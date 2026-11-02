// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HoldfastVault} from "../HoldfastVault.sol";
import {FlexToken, ImpactRouter, MockPool, Vm} from "./Mocks.sol";

/// Random sequences in both directions with the mandate, the loss guard and the log on, and with everyone who can move
/// value or state trying. A shadow log recomputes the vault's head from what the handler saw. Local, with mocks.
contract V4Handler {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xB0B);
    address constant GUARDIAN = address(0x6A7D);
    address constant THIEF = address(0xBAD);

    uint256 public constant MAX_TRADE = 100e18;
    uint256 public constant LIFETIME = 3_000e18;
    uint256 public constant HOURLY = 400e18;
    uint256 public constant FLOOR = 0.4e18;
    uint256 public constant LOSS_BUDGET = 40e18;
    uint256 public constant MARK = 1e18;
    uint256 public constant START_BALANCE = 1_000_000e18;

    HoldfastVault public vault;
    FlexToken public a;
    FlexToken public b;
    FlexToken public other;
    ImpactRouter public router;
    uint256 public start;

    uint256 public spentA;
    uint256 public spentB;
    uint256 public largestTrade;
    /// @notice Loss against the mark, summed from balances the handler saw move.
    uint256 public totalLoss;
    uint256 public maxBudgetSeen = LOSS_BUDGET;
    uint256 public withdrawnA;
    uint256 public withdrawnB;
    uint256 public donatedA;
    uint256 public donatedB;
    uint256 public accepted;
    uint256 public refused;
    uint256 public anchors;
    bytes24 public shadowHead;
    uint64 public shadowCount;
    uint256 private nextIntent;
    bool public revokedNow;

    constructor() {
        vm.warp(1_800_000_000);
        start = block.timestamp;
        a = new FlexToken();
        b = new FlexToken();
        other = new FlexToken();
        router = new ImpactRouter();
        router.setPool(new MockPool(address(a), address(b)));
        router.setRate(1e18);
        vault = new HoldfastVault(OWNER, AGENT, block.timestamp + 30 days, address(router), address(a), address(b), 3000);
        shadowHead = vault.logHead();
        a.mint(address(vault), START_BALANCE);
        b.mint(address(vault), START_BALANCE);
        other.mint(address(vault), 1e18);
        a.mint(address(router), 100_000_000e18);
        b.mint(address(router), 100_000_000e18);
        vm.prank(OWNER);
        vault.setLimits(address(a), MAX_TRADE, LIFETIME, FLOOR, HOURLY);
        vm.prank(OWNER);
        vault.setLimits(address(b), MAX_TRADE, LIFETIME, FLOOR, HOURLY);
        vm.prank(OWNER);
        vault.setGuardian(GUARDIAN);
        vm.prank(OWNER);
        vault.setMandate(5_000, 0);
        vm.prank(OWNER);
        vault.setLossGuard(MARK, LOSS_BUDGET, 0);
    }

    function _shadow(uint8 kind, bytes32 id, address token, uint256 x, uint256 y) private {
        shadowCount++;
        shadowHead = bytes24(keccak256(abi.encode(shadowHead, shadowCount, kind, id, token, x, y, block.timestamp)));
    }

    function passTime(uint32 seconds_) external {
        vm.warp(block.timestamp + (seconds_ % 3 hours));
    }

    function setRate(uint256 seed) external {
        router.setRate(0.5e18 + (seed % 0.7e18));
    }

    function agentTrade(uint256 amountSeed, uint256 minOutSeed, bool sell, bool replay) external {
        FlexToken tokenIn = sell ? a : b;
        FlexToken tokenOut = sell ? b : a;
        uint256 amount = amountSeed % (MAX_TRADE * 2);
        uint256 minOut = minOutSeed % 2 == 0 ? (amount * 0.97e18) / 1e18 : minOutSeed % (amount + 1);
        bytes32 intent = bytes32(replay ? nextIntent : ++nextIntent);
        bool wasUsed = vault.usedIntent(intent);
        uint256 inBefore = tokenIn.balanceOf(address(vault));
        uint256 outBefore = tokenOut.balanceOf(address(vault));
        (bytes24 headBefore, uint64 countBefore) = (vault.logHead(), vault.logCount());
        vm.prank(AGENT);
        try vault.execute(address(tokenIn), amount, minOut, block.timestamp + 60, intent) returns (uint256 out) {
            require(!wasUsed, "one intent executed twice");
            require(!revokedNow, "a revoked key traded");
            uint256 spent = inBefore - tokenIn.balanceOf(address(vault));
            uint256 got = tokenOut.balanceOf(address(vault)) - outBefore;
            require(out == got, "reported output is not what arrived");
            require(got >= minOut, "paid under the minimum");
            require(spent <= amount, "spent over the authorized input");
            accepted++;
            if (sell) spentA += spent;
            else spentB += spent;
            if (spent > largestTrade) largestTrade = spent;
            if (spent > got) totalLoss += spent - got;
            _shadow(1, intent, address(tokenIn), spent, got);
        } catch {
            refused++;
            require(tokenIn.balanceOf(address(vault)) == inBefore && tokenOut.balanceOf(address(vault)) == outBefore, "a refusal moved funds");
            require(vault.logHead() == headBefore && vault.logCount() == countBefore, "a refusal left a log entry");
        }
    }

    function agentAnchors(bytes32 head, uint64 seq) external {
        vm.prank(AGENT);
        try vault.anchorLog(head, seq) {
            require(!revokedNow, "a revoked key anchored");
            anchors++;
            _shadow(3, head, address(0), seq, 0);
        } catch {
            require(revokedNow, "a valid key could not anchor");
        }
    }

    function agentTriesForbidden(address to, uint256 amount, uint8 which) external {
        vm.prank(AGENT);
        bool ok;
        which %= 8;
        if (which == 0) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.withdraw, (address(a), to, amount)));
        if (which == 1) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setLossGuard, (0, 0, 0)));
        if (which == 2) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setMandate, (0, 0)));
        if (which == 3) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setStrategyPin, (bytes32(amount))));
        if (which == 4) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.unpause, ()));
        if (which == 5) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setLimits, (address(a), amount, amount, 0, amount)));
        if (which == 6) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setAgent, (to, block.timestamp + 1)));
        if (which == 7) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.execute, (address(other), 1, 1, block.timestamp + 60, keccak256(abi.encode(amount)))));
        require(!ok, "the agent did something it may not");
    }

    function thiefTries(uint256 amount, uint8 which) external {
        vm.prank(THIEF);
        bool ok;
        which %= 5;
        if (which == 0) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.execute, (address(a), 1e18, 1e18, block.timestamp + 60, keccak256(abi.encode(amount)))));
        if (which == 1) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.anchorLog, (bytes32(amount), 1)));
        if (which == 2) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setLossGuard, (0, 0, 0)));
        if (which == 3) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.withdraw, (address(a), THIEF, 1)));
        if (which == 4) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setStrategyPin, (bytes32(amount))));
        require(!ok, "a stranger did something it may not");
    }

    /// Anyone can send tokens in. Nothing may read this as a reason to allow more.
    function donate(uint256 seed, bool toA) external {
        uint256 amount = seed % 1_000_000e18;
        (toA ? a : b).mint(address(vault), amount);
        if (toA) donatedA += amount;
        else donatedB += amount;
    }

    /// Withdrawal must work at every point in every sequence, paused, revoked or out of budget. A revert fails the run.
    function ownerWithdraws(uint256 seed, bool fromA) external {
        FlexToken token = fromA ? a : b;
        uint256 amount = seed % 1e18;
        if (amount > token.balanceOf(address(vault))) amount = 0;
        vm.prank(OWNER);
        vault.withdraw(address(token), address(0xC01D), amount);
        if (fromA) withdrawnA += amount;
        else withdrawnB += amount;
    }

    function controls(uint8 which) external {
        which %= 6;
        if (which == 0) {
            vm.prank(GUARDIAN);
            vault.pause();
        }
        if (which == 1) {
            vm.prank(OWNER);
            vault.unpause();
        }
        if (which == 2) {
            vm.prank(GUARDIAN);
            vault.revokeAgent();
            revokedNow = true;
        }
        if (which == 3) {
            vm.prank(OWNER);
            vault.setAgent(AGENT, block.timestamp + 30 days);
            revokedNow = false;
        }
        if (which == 4) {
            // A fresh mark must not hand back what was already lost today.
            uint256 left = vault.lossBudgetAvailable();
            vm.prank(OWNER);
            vault.setLossGuard(MARK, LOSS_BUDGET, 0);
            require(vault.lossBudgetAvailable() == left, "a reset handed back budget");
        }
        if (which == 5) {
            vm.prank(GUARDIAN);
            vault.halt();
        }
    }
}

contract HoldfastVaultV4InvariantTest {
    V4Handler handler;

    function setUp() public {
        handler = new V4Handler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_1_theAgentHoldsNothingAndOnlyTheOwnerTakesAssetsOut() public view {
        V4Handler h = handler;
        require(h.a().balanceOf(address(0xB0B)) == 0 && h.b().balanceOf(address(0xB0B)) == 0, "the agent holds tokens");
        require(h.a().balanceOf(address(0xBAD)) == 0 && h.b().balanceOf(address(0xBAD)) == 0, "a stranger holds tokens");
        require(h.a().balanceOf(address(0xC01D)) == h.withdrawnA() && h.b().balanceOf(address(0xC01D)) == h.withdrawnB(), "withdrawal account wrong");
    }

    function invariant_2_noTradeSpentOverTheCap() public view {
        require(handler.largestTrade() <= handler.MAX_TRADE(), "over the trade cap");
    }

    function invariant_4_noOtherAssetEverMoved() public view {
        require(handler.other().balanceOf(address(handler.vault())) == 1e18, "an unauthorized asset moved");
        require(handler.a().allowance(address(handler.vault()), address(handler.router())) == 0, "allowance left on a");
        require(handler.b().allowance(address(handler.vault()), address(handler.router())) == 0, "allowance left on b");
    }

    function invariant_6_budgetsAreNeverResetByAnyTransition() public view {
        V4Handler h = handler;
        uint256 elapsed = block.timestamp - h.start();
        require(h.spentA() <= h.LIFETIME() && h.spentB() <= h.LIFETIME(), "over lifetime");
        require(h.vault().remaining(address(h.a())) == h.LIFETIME() - h.spentA(), "lifetime a drifted");
        require(h.vault().remaining(address(h.b())) == h.LIFETIME() - h.spentB(), "lifetime b drifted");
        require(h.spentA() <= h.HOURLY() + (elapsed * h.HOURLY()) / 1 hours, "a over the hourly envelope");
        require(h.spentB() <= h.HOURLY() + (elapsed * h.HOURLY()) / 1 hours, "b over the hourly envelope");
        // The loss guard's own promise: total loss stays inside one budget plus what has refilled since. Refill rounds down.
        require(h.totalLoss() <= h.LOSS_BUDGET() + (elapsed * h.LOSS_BUDGET()) / 1 days + 1, "loss over the envelope");
    }

    function invariant_8_theOnChainLogMatchesAShadowOfEveryExecution() public view {
        require(handler.vault().logHead() == handler.shadowHead(), "head differs from what was executed");
        require(handler.vault().logCount() == handler.shadowCount(), "count differs");
        require(handler.vault().logCount() == handler.accepted() + handler.anchors(), "an entry with no execution, or the reverse");
    }

    function invariant_fundsAccountedForInBothTokens() public view {
        V4Handler h = handler;
        // Tokens in: start, donations, swap output. Out: swap input, withdrawals. Output is whatever the router paid, so it
        // is checked through the handler's per-trade assertions, and here only that nothing vanished on the spend side.
        require(h.a().balanceOf(address(h.vault())) + h.spentA() + h.withdrawnA() >= h.START_BALANCE() + h.donatedA(), "tokens a left some other way");
        require(h.b().balanceOf(address(h.vault())) + h.spentB() + h.withdrawnB() >= h.START_BALANCE() + h.donatedB(), "tokens b left some other way");
    }
}
