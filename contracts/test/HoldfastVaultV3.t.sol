// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HoldfastVault} from "../HoldfastVault.sol";
import {FlexToken, ImpactRouter, MockPool, Vm} from "./Mocks.sol";

/// The controls added in version 3: guardian, revocation, owner handover, conditional limits, daily budget, price guard
/// and the stop anyone can fire. The original suite in HoldfastVault.t.sol still runs against the same contract.
contract HoldfastVaultV3Test {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xB0B);
    address constant GUARDIAN = address(0x6A7D);
    address constant STRANGER = address(0xBAD);

    uint256 constant MAX_TRADE = 100e18;
    uint256 constant LIFETIME = 1_000e18;
    uint256 constant BUDGET = 500e18;
    uint256 constant FLOOR = 0.9e18;
    uint32 constant WINDOW = 300;
    uint16 constant BAND = 100;

    HoldfastVault vault;
    ImpactRouter router;
    MockPool pool;
    FlexToken a;
    FlexToken b;
    uint256 nextIntent;

    function setUp() public {
        vm.warp(1_800_000_000);
        a = new FlexToken();
        b = new FlexToken();
        router = new ImpactRouter();
        pool = new MockPool(address(a), address(b));
        router.setPool(pool);
        vault = new HoldfastVault(OWNER, AGENT, block.timestamp + 7 days, address(router), address(a), address(b), 3000);
        a.mint(address(vault), 10_000e18);
        a.mint(address(router), 1_000_000e18);
        b.mint(address(router), 1_000_000e18);
        vm.prank(OWNER);
        vault.setLimits(address(a), MAX_TRADE, LIFETIME, FLOOR, BUDGET);
        vm.prank(OWNER);
        vault.setGuardian(GUARDIAN);
    }

    function _trade(uint256 amount) private returns (uint256) {
        vm.prank(AGENT);
        return vault.execute(address(a), amount, (amount * FLOOR) / 1e18, block.timestamp + 60, bytes32(++nextIntent));
    }

    function _expectTrade(bytes4 reason) private {
        bytes32 intent = bytes32(++nextIntent);
        vm.prank(AGENT);
        vm.expectRevert(reason);
        vault.execute(address(a), 1e18, FLOOR, block.timestamp + 60, intent);
    }

    function _guard() private {
        vm.prank(OWNER);
        vault.setPriceGuard(address(pool), WINDOW, BAND);
    }

    function _armStop(int24 trigger, uint256 tranche, uint256 total, uint256 floor) private {
        vm.prank(OWNER);
        vault.armStop(address(a), trigger, tranche, total, floor, 500, 600);
    }

    // Constructor

    function test_constructorRefusesAddressesWithoutCode() public {
        vm.expectRevert(HoldfastVault.BadToken.selector);
        new HoldfastVault(OWNER, AGENT, block.timestamp + 1, address(0x1234), address(a), address(b), 3000);
        vm.expectRevert(HoldfastVault.BadToken.selector);
        new HoldfastVault(OWNER, AGENT, block.timestamp + 1, address(router), address(0x1234), address(b), 3000);
        vm.expectRevert(HoldfastVault.BadToken.selector);
        new HoldfastVault(OWNER, AGENT, block.timestamp + 1, address(router), address(a), address(0x1234), 3000);
    }

    // Guardian: can stop things, and nothing else

    function test_guardianCanPauseAndCannotUnpause() public {
        vm.prank(GUARDIAN);
        vault.pause();
        _expectTrade(HoldfastVault.IsPaused.selector);
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.unpause();
    }

    function test_attack_guardianHasNoOtherPower() public {
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.withdraw(address(a), GUARDIAN, 1);
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setLimits(address(a), 1, 1, 1, 1);
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setAgent(GUARDIAN, block.timestamp + 1);
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setGuardian(STRANGER);
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.transferOwnership(GUARDIAN);
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.armStop(address(a), 0, 1, 1, 1, 1, 60);
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotAgent.selector);
        vault.execute(address(a), 1e18, FLOOR, block.timestamp + 60, bytes32(uint256(1)));
    }

    function test_attack_strangerCannotStopAnything() public {
        vm.prank(STRANGER);
        vm.expectRevert(HoldfastVault.NotOwnerOrAgent.selector);
        vault.pause();
        vm.prank(STRANGER);
        vm.expectRevert(HoldfastVault.NotOwnerOrGuardian.selector);
        vault.halt();
        vm.prank(STRANGER);
        vm.expectRevert(HoldfastVault.NotOwnerOrGuardian.selector);
        vault.revokeAgent();
        vm.prank(STRANGER);
        vm.expectRevert(HoldfastVault.NotOwnerOrGuardian.selector);
        vault.disarmStop();
    }

    function test_attack_agentCannotHaltOrRevokeOrDisarm() public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwnerOrGuardian.selector);
        vault.halt();
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwnerOrGuardian.selector);
        vault.revokeAgent();
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwnerOrGuardian.selector);
        vault.disarmStop();
    }

    // Revocation

    function test_revokeEndsTheKeyInTheSameBlock() public {
        _trade(1e18);
        vm.prank(GUARDIAN);
        vault.revokeAgent();
        _expectTrade(HoldfastVault.AgentExpired.selector);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwnerOrAgent.selector);
        vault.pause();
    }

    function test_ownerBringsARevokedKeyBack() public {
        vm.prank(OWNER);
        vault.revokeAgent();
        vm.prank(OWNER);
        vault.setAgent(AGENT, block.timestamp + 1 days);
        _trade(1e18);
    }

    function test_attack_guardianCannotExtendARevokedKey() public {
        vm.prank(GUARDIAN);
        vault.revokeAgent();
        vm.prank(GUARDIAN);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setAgent(AGENT, block.timestamp + 1 days);
    }

    // Owner handover

    function test_ownerHandoverNeedsTheNewOwnerToAccept() public {
        vm.prank(OWNER);
        vault.transferOwnership(STRANGER);
        require(vault.owner() == OWNER, "changed before accept");
        vm.prank(OWNER);
        vault.withdraw(address(a), OWNER, 1);

        vm.prank(address(0xABC));
        vm.expectRevert(HoldfastVault.NotPendingOwner.selector);
        vault.acceptOwnership();

        vm.prank(STRANGER);
        vault.acceptOwnership();
        require(vault.owner() == STRANGER && vault.pendingOwner() == address(0), "not handed over");

        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.withdraw(address(a), OWNER, 1);
        vm.prank(STRANGER);
        vault.withdraw(address(a), STRANGER, 1);
    }

    function test_ownerCanCancelAHandover() public {
        vm.prank(OWNER);
        vault.transferOwnership(STRANGER);
        vm.prank(OWNER);
        vault.transferOwnership(address(0));
        vm.prank(STRANGER);
        vm.expectRevert(HoldfastVault.NotPendingOwner.selector);
        vault.acceptOwnership();
    }

    function test_attack_nobodyCanAcceptWhenNothingIsOffered() public {
        vm.prank(address(0));
        vm.expectRevert(HoldfastVault.NotPendingOwner.selector);
        vault.acceptOwnership();
    }

    // Conditional limits: the race the first independent review proved and left open

    function test_attack_tradeBetweenReadAndWriteCannotBePapered() public {
        uint256 seen = vault.remaining(address(a));
        _trade(10e18);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.RemainingChanged.selector);
        vault.setLimitsIfRemaining(address(a), MAX_TRADE, seen, FLOOR, BUDGET, seen);
        vm.prank(OWNER);
        vault.setLimitsIfRemaining(address(a), MAX_TRADE, seen - 10e18, FLOOR, BUDGET, seen - 10e18);
        require(vault.remaining(address(a)) == seen - 10e18, "wrong allowance");
    }

    function test_conditionalLimitsStillRefuseOversizedValues() public {
        uint256 seen = vault.remaining(address(a));
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.LimitTooLarge.selector);
        vault.setLimitsIfRemaining(address(a), uint256(type(uint72).max) + 1, 1, 1, 1, seen);
    }

    // Traded reports what actually left

    function test_tradedAmountsMatchBalances() public {
        uint256 before = a.balanceOf(address(vault));
        uint256 out = _trade(10e18);
        require(a.balanceOf(address(vault)) == before - 10e18, "input");
        require(b.balanceOf(address(vault)) == out, "output");
    }

    // Calldata suffix: decision hash

    function test_bytesAfterTheArgumentsAreIgnored() public {
        bytes memory data = abi.encodeCall(HoldfastVault.execute, (address(a), 1e18, FLOOR, block.timestamp + 60, bytes32(uint256(77))));
        vm.prank(AGENT);
        (bool ok,) = address(vault).call(bytes.concat(data, keccak256("decision record")));
        require(ok, "suffix broke execute");
        require(vault.usedIntent(bytes32(uint256(77))), "intent not marked");
    }

    // Daily budget

    function test_dailyBudgetCapsTotalBelowHourly() public {
        vm.prank(OWNER);
        vault.setDailyBudget(address(a), 150e18);
        _trade(100e18);
        _trade(50e18);
        _expectTrade(HoldfastVault.OverDailyBudget.selector);
        require(vault.dailyAvailable(address(a)) == 0, "should be spent");
    }

    function test_dailyBudgetRefillsContinuously() public {
        vm.prank(OWNER);
        vault.setDailyBudget(address(a), 240e18);
        _trade(100e18);
        _trade(100e18);
        _trade(40e18);
        vm.warp(block.timestamp + 1 hours);
        require(vault.dailyAvailable(address(a)) == 10e18, "one hour of refill");
        _trade(10e18);
        _expectTrade(HoldfastVault.OverDailyBudget.selector);
    }

    function test_dailyBudgetKeepsWhatWasSpent() public {
        vm.prank(OWNER);
        vault.setDailyBudget(address(a), 200e18);
        _trade(100e18);
        vm.prank(OWNER);
        vault.setDailyBudget(address(a), 150e18);
        require(vault.dailyAvailable(address(a)) == 50e18, "second budget");
        vm.prank(OWNER);
        vault.setDailyBudget(address(a), 90e18);
        require(vault.dailyAvailable(address(a)) == 0, "lowering below spent");
    }

    function test_settingLimitsKeepsTheDailyBudget() public {
        vm.prank(OWNER);
        vault.setDailyBudget(address(a), 150e18);
        _trade(100e18);
        vm.prank(OWNER);
        vault.setLimits(address(a), MAX_TRADE, LIFETIME, FLOOR, BUDGET);
        require(vault.dailyBudget(address(a)) == 150e18, "lost");
        require(vault.dailyAvailable(address(a)) == 50e18, "refilled");
    }

    function test_noDailyCapByDefault() public view {
        require(vault.dailyBudget(address(a)) == 0, "default");
        require(vault.dailyAvailable(address(a)) == type(uint72).max, "unlimited");
    }

    function test_dailyBudgetRefusesOversizedAndForeignToken() public {
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.LimitTooLarge.selector);
        vault.setDailyBudget(address(a), uint256(type(uint72).max) + 1);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadToken.selector);
        vault.setDailyBudget(address(0x1), 1);
    }

    function test_failedTradeSpendsNoDailyBudget() public {
        vm.prank(OWNER);
        vault.setDailyBudget(address(a), 150e18);
        router.setRate(0.5e18);
        vm.prank(AGENT);
        vm.expectRevert();
        vault.execute(address(a), 10e18, 9e18, block.timestamp + 60, bytes32(uint256(5)));
        require(vault.dailyAvailable(address(a)) == 150e18, "spent on a revert");
    }

    function testFuzz_dailySpendStaysInsideItsEnvelope(uint96[6] memory amounts, uint32[6] memory gaps) public {
        uint256 budget = 200e18;
        vm.prank(OWNER);
        vault.setDailyBudget(address(a), budget);
        uint256 start = block.timestamp;
        uint256 spent;
        for (uint256 i; i < 6; i++) {
            vm.warp(block.timestamp + (gaps[i] % 6 hours));
            uint256 amount = 1 + (uint256(amounts[i]) % MAX_TRADE);
            vm.prank(AGENT);
            try vault.execute(address(a), amount, (amount * FLOOR + 1e18 - 1) / 1e18, block.timestamp + 60, bytes32(++nextIntent)) {
                spent += amount;
            } catch {}
            require(spent <= budget + ((block.timestamp - start) * budget) / 1 days, "over the daily envelope");
        }
    }

    // Price guard configuration

    function test_priceGuardValidatesThePool() public {
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadPriceGuard.selector);
        vault.setPriceGuard(address(pool), 59, BAND);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadPriceGuard.selector);
        vault.setPriceGuard(address(pool), 1 days + 1, BAND);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadPriceGuard.selector);
        vault.setPriceGuard(address(pool), WINDOW, 0);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadPriceGuard.selector);
        vault.setPriceGuard(address(0x1234), WINDOW, BAND);

        MockPool wrongPair = new MockPool(address(a), address(0x1234));
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadPriceGuard.selector);
        vault.setPriceGuard(address(wrongPair), WINDOW, BAND);

        pool.setFee(500);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadPriceGuard.selector);
        vault.setPriceGuard(address(pool), WINDOW, BAND);
        pool.setFee(3000);

        pool.setOracleFails(true);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.OracleUnavailable.selector);
        vault.setPriceGuard(address(pool), WINDOW, BAND);
    }

    function test_attack_agentAndStrangerCannotChangeTheGuard() public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setPriceGuard(address(pool), 0, 0);
        vm.prank(STRANGER);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setPriceGuard(address(pool), WINDOW, BAND);
    }

    // Price guard enforcement: selling token a (token0) pushes the tick down

    function test_guardLetsANormalTradeThrough() public {
        _guard();
        router.setImpact(100);
        _trade(1e18);
    }

    function test_attack_guardRefusesASalePastTheBand() public {
        _guard();
        router.setImpact(101);
        _expectTrade(HoldfastVault.PriceOutOfBand.selector);
    }

    function test_attack_guardRefusesASaleIntoAPushedPool() public {
        _guard();
        // Spot pushed down, TWAP has not moved. The vault's floor alone would allow this.
        pool.setPrice(-int24(int16(BAND)) - 1, 0);
        _expectTrade(HoldfastVault.PriceOutOfBand.selector);
    }

    function test_guardBoundaryIsExact() public {
        _guard();
        pool.setPrice(-int24(int16(BAND)), 0);
        _trade(1e18);
    }

    function test_guardIsOneSided() public {
        _guard();
        // Spot far above TWAP is a better price for a sale of token0, so it passes.
        pool.setPrice(int24(int16(BAND)) * 5, 0);
        _trade(1e18);
    }

    function test_attack_guardRefusesABuyIntoAPushedPool() public {
        _guard();
        b.mint(address(vault), 100e6);
        vm.prank(OWNER);
        vault.setLimits(address(b), 10e6, 100e6, 1, 100e6);
        pool.setPrice(int24(int16(BAND)) + 1, 0);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.PriceOutOfBand.selector);
        vault.execute(address(b), 1e6, 1, block.timestamp + 60, bytes32(uint256(9)));
    }

    function test_guardHandlesPoolWithTokensTheOtherWayRound() public {
        MockPool flipped = new MockPool(address(b), address(a));
        router.setPool(flipped);
        vm.prank(OWNER);
        vault.setPriceGuard(address(flipped), WINDOW, BAND);
        // Token a is now token1, so selling it pushes the tick up.
        flipped.setPrice(int24(int16(BAND)) + 1, 0);
        _expectTrade(HoldfastVault.PriceOutOfBand.selector);
        flipped.setPrice(int24(int16(BAND)), 0);
        _trade(1e18);
    }

    function test_guardFailsClosedWhenTheOracleFails() public {
        _guard();
        pool.setOracleFails(true);
        _expectTrade(HoldfastVault.OracleUnavailable.selector);
        (bool ok,,) = vault.priceGuardTicks();
        require(!ok, "should report the failure");
    }

    function test_guardOffCostsNoExternalCalls() public {
        pool.setOracleFails(true);
        pool.setPrice(-10_000, 0);
        _trade(1e18);
    }

    function test_guardCanBeTurnedOff() public {
        _guard();
        pool.setOracleFails(true);
        _expectTrade(HoldfastVault.OracleUnavailable.selector);
        vm.prank(OWNER);
        vault.setPriceGuard(address(0), 0, 0);
        _trade(1e18);
    }

    function test_twapRoundsTowardsNegativeInfinity() public {
        _guard();
        pool.setPrice(0, -3);
        (bool ok, int24 spot, int24 twap) = vault.priceGuardTicks();
        require(ok && spot == 0 && twap == -3, "exact");
        // Minus three and a third is -4, as the V3 oracle library has it, and not -3.
        pool.setCumulativeOffset(-100);
        (,, twap) = vault.priceGuardTicks();
        require(twap == -4, "negative rounds down");
        pool.setCumulativeOffset(-300);
        (,, twap) = vault.priceGuardTicks();
        require(twap == -4, "a whole number stays");
        pool.setPrice(0, 3);
        pool.setCumulativeOffset(100);
        (,, twap) = vault.priceGuardTicks();
        require(twap == 3, "positive truncates");
    }

    function testFuzz_guardNeverPassesASalePastItsBand(int16 spot, int16 twap, uint8 impactSeed) public {
        _guard();
        int24 impact = int24(uint24(impactSeed));
        router.setImpact(impact);
        pool.setPrice(spot, twap);
        int256 after_ = int256(spot) - impact;
        bytes32 intent = bytes32(++nextIntent);
        vm.prank(AGENT);
        try vault.execute(address(a), 1e18, FLOOR, block.timestamp + 60, intent) {
            require(after_ - twap >= -int256(uint256(BAND)), "passed past the band");
        } catch {
            require(after_ - twap < -int256(uint256(BAND)), "refused inside the band");
        }
    }

    // Stop

    function test_stopNeedsAGuard() public {
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.NoPriceGuard.selector);
        vault.armStop(address(a), 0, 1, 1, 1, 1, 60);
    }

    function test_stopTermsAreValidated() public {
        _guard();
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadToken.selector);
        vault.armStop(address(0x1), 0, 1, 1, 1, 1, 60);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadStop.selector);
        vault.armStop(address(a), 0, 0, 1, 1, 1, 60);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadStop.selector);
        vault.armStop(address(a), 0, 2, 1, 1, 1, 60);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadStop.selector);
        vault.armStop(address(a), 0, 1, 1, 0, 1, 60);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadStop.selector);
        vault.armStop(address(a), 0, 1, 1, 1, 0, 60);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadStop.selector);
        vault.armStop(address(a), 0, 1, 1, 1, 1, 59);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.BadStop.selector);
        vault.armStop(address(a), 0, 1, uint256(type(uint72).max) + 1, 1, 1, 60);
    }

    function test_attack_onlyTheOwnerCanArm() public {
        _guard();
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.armStop(address(a), 0, 1, 1, 1, 1, 60);
        vm.prank(STRANGER);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.armStop(address(a), 0, 1, 1, 1, 1, 60);
    }

    function test_stopCannotFireWhenNotArmed() public {
        vm.expectRevert(HoldfastVault.StopNotArmed.selector);
        vault.triggerStop();
    }

    function test_anyoneCanFireATriggeredStop() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        pool.setPrice(-1000, -1000);
        vm.prank(STRANGER);
        uint256 out = vault.triggerStop();
        require(out == 10e18, "rate");
        require(b.balanceOf(address(vault)) == out, "proceeds stay in the vault");
        require(b.balanceOf(STRANGER) == 0 && a.balanceOf(STRANGER) == 0, "caller gets nothing");
    }

    function test_attack_spotAloneCannotFireAStop() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        // A one-block push moves spot and leaves the TWAP where it was.
        pool.setPrice(-5000, -999);
        require(!vault.stopReady(), "reports ready");
        vm.prank(STRANGER);
        vm.expectRevert(HoldfastVault.StopNotTriggered.selector);
        vault.triggerStop();
    }

    function test_stopTriggerBoundaryIsExact() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        pool.setPrice(-1000, -999);
        vm.expectRevert(HoldfastVault.StopNotTriggered.selector);
        vault.triggerStop();
        pool.setPrice(-1000, -1000);
        require(vault.stopReady(), "not ready");
        vault.triggerStop();
    }

    function test_stopSellsOneTranchePerCooldownUpToTheTotal() public {
        _guard();
        _armStop(-1000, 10e18, 25e18, 0.5e18);
        pool.setPrice(-1000, -1000);
        vault.triggerStop();
        vm.expectRevert(HoldfastVault.StopCoolingDown.selector);
        vault.triggerStop();
        vm.warp(block.timestamp + 599);
        vm.expectRevert(HoldfastVault.StopCoolingDown.selector);
        vault.triggerStop();
        vm.warp(block.timestamp + 1);
        vault.triggerStop();
        vm.warp(block.timestamp + 600);
        vault.triggerStop();
        require(b.balanceOf(address(vault)) == 25e18, "total");
        vm.warp(block.timestamp + 600);
        require(!vault.stopReady(), "nothing left");
        vm.expectRevert(HoldfastVault.BadAmount.selector);
        vault.triggerStop();
    }

    function test_stopSellsUnderTheAgentFloor() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        router.setRate(0.6e18);
        pool.setPrice(-1000, -1000);
        // Under the 0.9 floor the agent is refused, and the stop sells.
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.BelowFloor.selector);
        vault.execute(address(a), 1e18, 0.6e18, block.timestamp + 60, bytes32(uint256(1)));
        require(vault.triggerStop() == 6e18, "stop did not sell");
    }

    function test_attack_stopNeverSellsUnderItsOwnFloor() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        router.setRate(0.49e18);
        pool.setPrice(-1000, -1000);
        vm.expectRevert();
        vault.triggerStop();
        require(a.balanceOf(address(vault)) == 10_000e18, "sold");
    }

    function test_attack_sandwichedStopIsRefusedByItsBand() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        // Attacker pushes spot far past the TWAP in the same block, hoping to buy the tranche cheaply.
        pool.setPrice(-1000 - 501, -1000);
        vm.expectRevert(HoldfastVault.PriceOutOfBand.selector);
        vault.triggerStop();
    }

    function test_failedStopSpendsNoneOfItsAllowance() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        pool.setPrice(-1000 - 501, -1000);
        vm.expectRevert(HoldfastVault.PriceOutOfBand.selector);
        vault.triggerStop();
        (, uint72 left, uint40 nextAt,,,,) = vault.stop();
        require(left == 30e18 && nextAt == 0, "state kept after a revert");
    }

    function test_stopForToken1FiresOnTheTickRising() public {
        _guard();
        b.mint(address(vault), 100e18);
        vm.prank(OWNER);
        vault.armStop(address(b), 1000, 10e18, 30e18, 0.5e18, 500, 600);
        pool.setPrice(999, 999);
        vm.expectRevert(HoldfastVault.StopNotTriggered.selector);
        vault.triggerStop();
        pool.setPrice(1000, 1000);
        vault.triggerStop();
    }

    function test_stopSellsAtMostTheBalance() public {
        _guard();
        _armStop(-1000, 1_000e18, 4_000e18, 0.5e18);
        vm.prank(OWNER);
        vault.withdraw(address(a), OWNER, 9_995e18);
        pool.setPrice(-1000, -1000);
        vault.triggerStop();
        require(a.balanceOf(address(vault)) == 0 && b.balanceOf(address(vault)) == 5e18, "balance");
    }

    function test_attack_stolenKeyPausingDoesNotBlockTheStop() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        pool.setPrice(-1000, -1000);
        vm.prank(AGENT);
        vault.pause();
        vm.prank(STRANGER);
        vault.triggerStop();
    }

    function test_attack_stolenKeySpendingItsBudgetLeavesTheStopAllowance() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        for (uint256 i; i < 5; i++) _trade(100e18);
        _expectTrade(HoldfastVault.OverHourlyBudget.selector);
        pool.setPrice(-1000, -1000);
        vault.triggerStop();
    }

    function test_expiredKeyDoesNotBlockTheStop() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        vm.prank(OWNER);
        vault.revokeAgent();
        pool.setPrice(-1000, -1000);
        vault.triggerStop();
    }

    function test_haltStopsTheAgentAndTheStop() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        pool.setPrice(-1000, -1000);
        vm.prank(GUARDIAN);
        vault.halt();
        _expectTrade(HoldfastVault.IsPaused.selector);
        vm.expectRevert(HoldfastVault.StopNotArmed.selector);
        vault.triggerStop();
        require(!vault.stopReady(), "reports ready");
    }

    function test_turningTheGuardOffDisarmsTheStop() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        vm.prank(OWNER);
        vault.setPriceGuard(address(0), 0, 0);
        vm.expectRevert(HoldfastVault.StopNotArmed.selector);
        vault.triggerStop();
    }

    function test_stopFailsClosedWhenTheOracleFails() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        pool.setOracleFails(true);
        require(!vault.stopReady(), "reports ready");
        vm.expectRevert(HoldfastVault.OracleUnavailable.selector);
        vault.triggerStop();
    }

    // The owner's exit depends on nothing else

    function test_ownerWithdrawsWhenEverythingElseIsBroken() public {
        _guard();
        _armStop(-1000, 10e18, 30e18, 0.5e18);
        vm.prank(GUARDIAN);
        vault.halt();
        vm.prank(OWNER);
        vault.revokeAgent();
        pool.setOracleFails(true);
        router.setRate(0);
        vm.warp(block.timestamp + 365 days);
        vm.prank(OWNER);
        vault.withdraw(address(a), OWNER, 10_000e18);
        require(a.balanceOf(OWNER) == 10_000e18, "stuck");
    }

    function test_ownerWithdrawsAnyTokenSentHereByMistake() public {
        FlexToken stray = new FlexToken();
        stray.mint(address(vault), 5);
        vm.prank(OWNER);
        vault.withdraw(address(stray), OWNER, 5);
        require(stray.balanceOf(OWNER) == 5, "stuck");
    }

    // Hostile tokens

    function test_attack_tokenThatReturnsFalseFailsLoudly() public {
        a.setHostile(false, true, 0);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.TokenCallFailed.selector);
        vault.withdraw(address(a), OWNER, 1);
    }

    function test_attack_tokenThatRevertsOnTransferBlocksTradesNotOtherWithdrawals() public {
        b.mint(address(vault), 5);
        a.setHostile(true, false, 0);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.TokenCallFailed.selector);
        vault.withdraw(address(a), OWNER, 1);
        vm.prank(OWNER);
        vault.withdraw(address(b), OWNER, 5);
    }

    function test_attack_feeOnTransferOutputIsMeasuredByBalance() public {
        b.setHostile(false, false, 2_000);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.InsufficientOutput.selector);
        vault.execute(address(a), 10e18, 9.5e18, block.timestamp + 60, bytes32(uint256(1)));
    }

    function test_withdrawToAddressZeroIsRefused() public {
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.ZeroAddress.selector);
        vault.withdraw(address(a), address(0), 1);
    }

    function testFuzz_agentNeverGainsWithdrawalPower(address to, uint256 amount) public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.withdraw(address(a), to, amount);
    }

    function testFuzz_nobodyButTheAgentTrades(address caller) public {
        vm.assume(caller != AGENT);
        vm.prank(caller);
        vm.expectRevert(HoldfastVault.NotAgent.selector);
        vault.execute(address(a), 1e18, FLOOR, block.timestamp + 60, bytes32(uint256(1)));
    }
}
