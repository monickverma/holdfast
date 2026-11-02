// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HoldfastVault, ISwapRouter02} from "../HoldfastVault.sol";
import {FlexToken, ImpactRouter, MockPool, Vm} from "./Mocks.sol";

/// A router that reports a full fill and pays only what it chooses, or calls back into the vault mid-swap.
contract HostileRouter {
    HoldfastVault public vault;
    uint256 public payBps = 10_000;
    uint256 public pullBps = 10_000;
    bytes public callback;
    bool public callbackSucceeded;

    function configure(HoldfastVault v, uint256 pay, uint256 pull, bytes calldata cb) external {
        vault = v;
        payBps = pay;
        pullBps = pull;
        callback = cb;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external payable returns (uint256) {
        FlexToken(p.tokenIn).transferFrom(msg.sender, address(this), (p.amountIn * pullBps) / 10_000);
        if (callback.length != 0) {
            (bool ok,) = address(vault).call(callback);
            callbackSucceeded = ok;
        }
        FlexToken(p.tokenOut).transfer(p.recipient, (p.amountOutMinimum * payBps) / 10_000);
        return p.amountOutMinimum * 2;
    }
}

/// The controls added in version 4: mandate, loss guard, log and strategy pin. Local, with mocks: this says what the
/// contract does, and nothing about the real pool. The fork suite covers that.
contract HoldfastVaultV4Test {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xB0B);
    address constant GUARDIAN = address(0x6A7D);
    address constant STRANGER = address(0xBAD);

    uint256 constant MAX_TRADE = 100e18;
    uint256 constant LIFETIME = 4_000e18;
    uint256 constant BUDGET = 4_000e18;
    uint256 constant FLOOR = 0.5e18;
    uint256 constant MARK = 1e18;

    event LossBreakerTripped(bytes32 indexed intentId, uint256 loss, uint256 budgetLeft);

    HoldfastVault vault;
    HostileRouter router;
    FlexToken a;
    FlexToken b;
    uint256 nextIntent;

    function setUp() public {
        vm.warp(1_800_000_000);
        a = new FlexToken();
        b = new FlexToken();
        router = new HostileRouter();
        vault = new HoldfastVault(OWNER, AGENT, block.timestamp + 7 days, address(router), address(a), address(b), 3000);
        a.mint(address(vault), 1_000e18);
        b.mint(address(vault), 1_000e18);
        a.mint(address(router), 1_000_000e18);
        b.mint(address(router), 1_000_000e18);
        vm.prank(OWNER);
        vault.setLimits(address(a), MAX_TRADE, LIFETIME, FLOOR, BUDGET);
        vm.prank(OWNER);
        vault.setLimits(address(b), MAX_TRADE, LIFETIME, FLOOR, BUDGET);
    }

    function _trade(address token, uint256 amount, uint256 minOut) private returns (uint256) {
        vm.prank(AGENT);
        return vault.execute(token, amount, minOut, block.timestamp + 60, bytes32(++nextIntent));
    }

    function _refused(address token, uint256 amount, uint256 minOut, bytes4 reason) private {
        bytes32 intent = bytes32(++nextIntent);
        vm.prank(AGENT);
        vm.expectRevert(reason);
        vault.execute(token, amount, minOut, block.timestamp + 60, intent);
    }

    function _lossGuard(uint256 mark, uint256 budget, uint32 age) private {
        vm.prank(OWNER);
        vault.setLossGuard(mark, budget, age);
    }

    // Settlement: balance deltas against a dishonest router

    function test_aFullFillReportedButNotPaidIsRefused() public {
        router.configure(vault, 9_000, 10_000, "");
        _refused(address(a), 10e18, 10e18, HoldfastVault.InsufficientOutput.selector);
    }

    function test_aPartialPullLeavesNoAllowanceAndTheEventReportsWhatLeft() public {
        router.configure(vault, 10_000, 4_000, "");
        uint256 before = a.balanceOf(address(vault));
        bytes24 head = vault.logHead();
        uint256 out = _trade(address(a), 10e18, 6e18);
        require(before - a.balanceOf(address(vault)) == 4e18);
        require(a.allowance(address(vault), address(router)) == 0, "allowance left");
        // The log says what left the vault, not what was asked for.
        require(vault.logHead() == _next(head, 1, 1, bytes32(nextIntent), address(a), 4e18, out), "log entry");
    }

    function test_aFeeOnTransferOutputIsMeasuredNotAssumed() public {
        b.setHostile(false, false, 100);
        _refused(address(a), 10e18, 10e18, HoldfastVault.InsufficientOutput.selector);
    }

    function test_aRouterCannotReenterAnyPathThatMovesFunds() public {
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeCall(vault.execute, (address(a), 1e18, 1e18, block.timestamp + 60, bytes32(uint256(777))));
        calls[1] = abi.encodeCall(vault.triggerStop, ());
        calls[2] = abi.encodeCall(vault.withdraw, (address(a), address(router), 1e18));
        calls[3] = abi.encodeCall(vault.anchorLog, (bytes32(uint256(1)), 1));
        for (uint256 i; i < calls.length; ++i) {
            router.configure(vault, 10_000, 10_000, calls[i]);
            _trade(address(a), 1e18, 1e18);
            require(!router.callbackSucceeded(), "reentered");
        }
    }

    // Mandate

    function test_shareOfBalanceLimitsATradeBelowTheAbsoluteCap() public {
        vm.prank(OWNER);
        vault.setMandate(500, 0); // 5% of 1,000 is 50.
        _refused(address(a), 51e18, 26e18, HoldfastVault.OverBalanceShare.selector);
        _trade(address(a), 50e18, 26e18);
    }

    function test_aDonationCannotLiftATradeAboveTheAbsoluteCap() public {
        vm.prank(OWNER);
        vault.setMandate(10_000, 0);
        a.mint(address(vault), 1_000_000e18);
        _refused(address(a), MAX_TRADE + 1, MAX_TRADE, HoldfastVault.OverTradeCap.selector);
    }

    function test_withdrawingShrinksTheShareLimitAtOnce() public {
        vm.prank(OWNER);
        vault.setMandate(5_000, 0);
        _trade(address(a), 100e18, 51e18);
        vm.prank(OWNER);
        vault.withdraw(address(a), OWNER, 800e18); // Balance is now 100, so 50 is the most.
        _refused(address(a), 51e18, 26e18, HoldfastVault.OverBalanceShare.selector);
    }

    function test_cooldownSpacesTradesPerTokenAndAddsNoWayRound() public {
        vm.prank(OWNER);
        vault.setMandate(0, 300);
        vm.warp(block.timestamp + 300);
        _trade(address(a), 1e18, 1e18);
        _refused(address(a), 1e18, 1e18, HoldfastVault.TradeTooSoon.selector);
        vm.warp(block.timestamp + 299);
        _refused(address(a), 1e18, 1e18, HoldfastVault.TradeTooSoon.selector);
        vm.warp(block.timestamp + 1);
        _trade(address(a), 1e18, 1e18);
    }

    function test_mandateBoundsAreChecked() public {
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadMandate.selector);
        vault.setMandate(10_001, 0);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadMandate.selector);
        vault.setMandate(0, 1 days + 1);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setMandate(0, 0);
    }

    // Budgets: no transition hands one back

    function test_anHourlyBudgetIsARealRollingLimitWithNoBoundaryToExploit() public {
        vm.prank(OWNER);
        vault.setLimits(address(a), MAX_TRADE, LIFETIME, FLOOR, 100e18);
        _trade(address(a), 100e18, 51e18);
        vm.warp(block.timestamp + 1);
        _refused(address(a), 1e18, 1e18, HoldfastVault.OverHourlyBudget.selector);
        // An hour-boundary reset would hand back 100 here. A half hour refills exactly half.
        vm.warp(block.timestamp + 1799);
        require(vault.budgetAvailable(address(a)) == 50e18);
        _refused(address(a), 50e18 + 1e9, 26e18, HoldfastVault.OverHourlyBudget.selector);
    }

    function test_depositsWithdrawalsAndDonationsMoveNoBudget() public {
        _lossGuard(MARK, 10e18, 0);
        _trade(address(a), 10e18, 9e18);
        uint256 hourly = vault.budgetAvailable(address(a));
        uint256 lossLeft = vault.lossBudgetAvailable();
        uint256 lifetime = vault.remaining(address(a));
        a.mint(address(vault), 500e18);
        b.mint(address(vault), 500e18);
        vm.prank(OWNER);
        vault.withdraw(address(a), OWNER, 1_000e18);
        vm.prank(OWNER);
        vault.withdraw(address(b), OWNER, 1);
        require(vault.budgetAvailable(address(a)) == hourly);
        require(vault.lossBudgetAvailable() == lossLeft);
        require(vault.remaining(address(a)) == lifetime);
    }

    // Loss guard: pre-trade refusal

    function test_aTradeWhoseWorstFillWouldExceedTheBudgetIsRefusedBeforeAnyCall() public {
        _lossGuard(MARK, 5e18, 0);
        _refused(address(a), 100e18, 94e18, HoldfastVault.OverLossBudget.selector);
        require(a.allowance(address(vault), address(router)) == 0);
        _trade(address(a), 100e18, 95e18);
    }

    function test_theBuySideIsValuedAtTheSameMark() public {
        _lossGuard(1.5e18, 10e18, 0); // One A is worth 1.5 B.
        // Spending 100 B must return at least 60 A, worth 90 B.
        _refused(address(b), 100e18, 60e18 - 1, HoldfastVault.OverLossBudget.selector);
        _trade(address(b), 100e18, 60e18);
        require(vault.lossBudgetAvailable() == 0, "charged in tokenB");
        require(vault.paused());
    }

    function test_aFillAboveTheMarkEarnsNoCreditForALaterBadOne() public {
        _lossGuard(MARK, 4e18, 0);
        router.configure(vault, 20_000, 10_000, "");
        _trade(address(a), 10e18, 10e18); // Paid double. Nothing lost, and nothing banked.
        require(vault.lossBudgetAvailable() == 4e18);
        _refused(address(a), 100e18, 95e18, HoldfastVault.OverLossBudget.selector);
    }

    function test_aStaleMarkRefusesTheAgentAndNotTheOwner() public {
        _lossGuard(MARK, 10e18, 1 hours);
        vm.warp(block.timestamp + 1 hours + 1);
        _refused(address(a), 1e18, 1e18, HoldfastVault.MarkStale.selector);
        vm.prank(OWNER);
        vault.withdraw(address(a), OWNER, 1e18);
        _lossGuard(MARK, 10e18, 1 hours);
        _trade(address(a), 1e18, 1e18);
    }

    // Loss guard: post-trade detection

    function test_theBreakerPersistsBecauseTheTradeThatTripsItSucceeds() public {
        _lossGuard(MARK, 10e18, 0);
        _trade(address(a), 100e18, 94e18); // Loses 6 of 10, past half.
        require(vault.paused(), "the loss stands and the pause stands with it");
        require(vault.lossBudgetAvailable() == 4e18);
        require(b.balanceOf(address(vault)) == 1_094e18);
        _refused(address(a), 1e18, 1e18, HoldfastVault.IsPaused.selector);
    }

    function test_underHalfTheBudgetNothingTrips() public {
        _lossGuard(MARK, 10e18, 0);
        _trade(address(a), 100e18, 95e18);
        require(!vault.paused());
        require(vault.lossBudgetAvailable() == 5e18);
    }

    function test_unpausingDoesNotRefillTheBudget() public {
        _lossGuard(MARK, 10e18, 0);
        _trade(address(a), 100e18, 94e18);
        vm.prank(OWNER);
        vault.unpause();
        require(vault.lossBudgetAvailable() == 4e18);
        _refused(address(a), 100e18, 95e18, HoldfastVault.OverLossBudget.selector);
    }

    function test_aNewMarkDoesNotRefillTheBudgetEither() public {
        _lossGuard(MARK, 10e18, 0);
        _trade(address(a), 100e18, 95e18);
        _lossGuard(MARK * 2, 10e18, 0);
        require(vault.lossBudgetAvailable() == 5e18, "spent stays spent");
        _lossGuard(MARK, 3e18, 0);
        require(vault.lossBudgetAvailable() == 0, "a smaller budget leaves none");
    }

    function test_refillIsLinearAndCapped() public {
        _lossGuard(MARK, 10e18, 0);
        _trade(address(a), 100e18, 95e18);
        vm.warp(block.timestamp + 12 hours);
        require(vault.lossBudgetAvailable() == 10e18);
        vm.warp(block.timestamp + 12 hours);
        require(vault.lossBudgetAvailable() == 10e18);
    }

    function test_turningItOffAndOnStartsAFullBudgetButOnlyTheOwnerCan() public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setLossGuard(0, 0, 0);
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setLossGuard(MARK, type(uint72).max, 0);
        _lossGuard(MARK, 10e18, 0);
        _lossGuard(0, 0, 0);
        require(!vault.lossGuardOn());
        require(vault.lossBudgetAvailable() == type(uint72).max);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadLossGuard.selector);
        vault.setLossGuard(0, 1, 0);
    }

    function testFuzz_theLossChargedNeverExceedsTheBudget(uint96 amount, uint96 minOut, uint96 pay, uint32 budgetSeed) public {
        uint256 budget = uint256(budgetSeed) * 1e9;
        uint256 size = 1 + uint256(amount) % MAX_TRADE;
        uint256 want = size / 2 + uint256(minOut) % size;
        router.configure(vault, 10_000 + uint256(pay) % 5_000, 10_000, "");
        _lossGuard(MARK, budget, 0);
        uint256 balanceBefore = b.balanceOf(address(vault));
        vm.prank(AGENT);
        try vault.execute(address(a), size, want, block.timestamp + 60, bytes32(++nextIntent)) {
            uint256 got = b.balanceOf(address(vault)) - balanceBefore;
            uint256 loss = size > got ? size - got : 0;
            require(loss <= budget, "over budget");
            require(vault.lossBudgetAvailable() == budget - loss, "charged wrongly");
            require(vault.paused() == ((budget - loss) * 2 < budget && loss != 0), "breaker wrong");
        } catch {
            require(size > want && size - want > budget || want < (size * FLOOR + 1e18 - 1) / 1e18, "refused without cause");
        }
    }

    // Stops, withdrawal and revocation stay outside it

    function test_ownerWithdrawsWhilePausedWithAStaleMarkAndAnExhaustedBudget() public {
        _lossGuard(MARK, 10e18, 1 hours);
        _trade(address(a), 100e18, 94e18);
        vm.warp(block.timestamp + 2 hours);
        require(vault.paused());
        uint256 all = a.balanceOf(address(vault));
        vm.prank(OWNER);
        vault.withdraw(address(a), OWNER, all);
        require(a.balanceOf(OWNER) == all);
    }

    function test_aRevokedKeyCannotTradeOrAnchorAndAPausedOneCanStillAnchor() public {
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwnerOrGuardian.selector);
        vault.revokeAgent();
        vm.prank(OWNER);
        vault.pause();
        vm.prank(AGENT);
        vault.anchorLog(bytes32(uint256(5)), 1);
        vm.prank(OWNER);
        vault.unpause();
        vm.prank(OWNER);
        vault.revokeAgent();
        _refused(address(a), 1e18, 1e18, HoldfastVault.AgentExpired.selector);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotAgent.selector);
        vault.anchorLog(bytes32(uint256(5)), 2);
    }

    // Log

    function _next(bytes24 head, uint64 count, uint8 kind, bytes32 id, address token, uint256 spent, uint256 out) private view returns (bytes24) {
        return bytes24(keccak256(abi.encode(head, count, kind, id, token, spent, out, block.timestamp)));
    }

    function test_theLogStartsBoundToThisChainAndVault() public {
        require(vault.logHead() == bytes24(keccak256(abi.encode("holdfast.log.v1", block.chainid, address(vault)))));
        require(vault.logCount() == 0);
        HoldfastVault other = new HoldfastVault(OWNER, AGENT, block.timestamp + 7 days, address(router), address(a), address(b), 3000);
        require(other.logHead() != vault.logHead());
    }

    function test_everyTradeAdvancesTheLogAndAFailedTradeLeavesNoEntry() public {
        bytes24 head = vault.logHead();
        _trade(address(a), 10e18, 10e18);
        head = _next(head, 1, 1, bytes32(nextIntent), address(a), 10e18, 10e18);
        require(vault.logHead() == head, "head");
        require(vault.logCount() == 1, "count");
        router.configure(vault, 9_000, 10_000, "");
        _refused(address(a), 10e18, 10e18, HoldfastVault.InsufficientOutput.selector);
        require(vault.logCount() == 1, "a failed trade must not count");
        require(vault.logHead() == head, "or move the head");
    }

    function test_anIntentCannotBeUsedTwiceSoOneDecisionCannotTradeTwice() public {
        vm.prank(AGENT);
        vault.execute(address(a), 1e18, 1e18, block.timestamp + 60, bytes32(uint256(42)));
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.IntentUsed.selector);
        vault.execute(address(a), 1e18, 1e18, block.timestamp + 60, bytes32(uint256(42)));
        require(vault.logCount() == 1);
    }

    function test_onlyTheAgentAnchorsAndAnAnchorIsInTheChain() public {
        vm.prank(STRANGER);
        vm.expectRevert(HoldfastVault.NotAgent.selector);
        vault.anchorLog(bytes32(uint256(5)), 1);
        bytes24 head = vault.logHead();
        vm.prank(AGENT);
        vault.anchorLog(bytes32(uint256(5)), 9);
        require(vault.logHead() == _next(head, 1, 3, bytes32(uint256(5)), address(0), 9, 0));
        require(vault.logCount() == 1);
    }

    // Stops

    function _armedStopVault() private returns (HoldfastVault v, ImpactRouter r, MockPool p) {
        r = new ImpactRouter();
        p = new MockPool(address(a), address(b));
        r.setPool(p);
        a.mint(address(r), 1_000_000e18);
        b.mint(address(r), 1_000_000e18);
        v = new HoldfastVault(OWNER, AGENT, block.timestamp + 7 days, address(r), address(a), address(b), 3000);
        a.mint(address(v), 1_000e18);
        vm.prank(OWNER);
        v.setPriceGuard(address(p), 300, 100);
        vm.prank(OWNER);
        v.armStop(address(a), -1000, 20e18, 100e18, 0.5e18, 500, 600);
        p.setPrice(-1100, -1100);
    }

    function test_aStopEntersTheLogAndIsNotChargedToTheLossGuard() public {
        (HoldfastVault v, ImpactRouter r,) = _armedStopVault();
        r.setRate(0.6e18); // Far below the mark, which is what a stop in a crash looks like.
        vm.prank(OWNER);
        v.setLossGuard(MARK, 1e18, 1 hours);
        vm.warp(block.timestamp + 2 hours); // The mark is stale as well.
        bytes24 head = v.logHead();
        vm.prank(STRANGER);
        v.triggerStop();
        require(v.logCount() == 1, "a stop must count");
        require(v.logHead() == _next(head, 1, 2, bytes32(0), address(a), 20e18, 12e18), "stop entry");
        require(v.lossBudgetAvailable() == 1e18, "a stop is not charged");
        require(!v.paused(), "and trips nothing");
    }

    // Strategy pin

    function test_onlyTheOwnerPinsAndTradingDoesNotDependOnIt() public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setStrategyPin(bytes32(uint256(1)));
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setStrategyPin(bytes32(uint256(1)));
        vm.prank(OWNER);
        vault.setStrategyPin(bytes32(uint256(1)));
        require(vault.strategyPin() == bytes32(uint256(1)));
        _trade(address(a), 1e18, 1e18);
    }
}
