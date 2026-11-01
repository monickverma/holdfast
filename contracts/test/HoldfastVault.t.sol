// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HoldfastVault, ISwapRouter02} from "../HoldfastVault.sol";

interface Vm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
    function assume(bool condition) external;
    function deal(address who, uint256 balance) external;
    function envOr(string calldata name, bool defaultValue) external returns (bool);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
}

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public immutable returnsNothing;

    constructor(bool returnsNothing_) {
        returnsNothing = returnsNothing_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        // USDT-style: refuse a change between two nonzero allowances.
        require(amount == 0 || allowance[msg.sender][spender] == 0, "usdt approve");
        allowance[msg.sender][spender] = amount;
        if (returnsNothing) assembly { return(0, 0) }
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (returnsNothing) assembly { return(0, 0) }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (returnsNothing) assembly { return(0, 0) }
        return true;
    }
}

/// Pays out at a set rate. `mode` turns it hostile to exercise the vault's own checks.
contract MockRouter {
    enum Mode {
        Honest,
        ShortPay,
        LiesAboutOutput,
        PartialPull,
        ReenterExecute,
        ReenterWithdraw
    }

    Mode public mode;
    uint256 public rateX18 = 1e18;
    HoldfastVault public vault;

    function setMode(Mode m, HoldfastVault v) external {
        mode = m;
        vault = v;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external payable returns (uint256) {
        uint256 pulled = mode == Mode.PartialPull ? p.amountIn / 2 : p.amountIn;
        _call(p.tokenIn, abi.encodeCall(MockToken.transferFrom, (msg.sender, address(this), pulled)));
        uint256 out = (p.amountIn * rateX18) / 1e18;
        if (mode == Mode.ReenterExecute) {
            vault.execute(p.tokenIn, p.amountIn, p.amountOutMinimum, block.timestamp, keccak256("reenter"));
        }
        if (mode == Mode.ReenterWithdraw) vault.withdraw(p.tokenIn, address(this), 1);
        if (mode == Mode.ShortPay) out = out / 2;
        if (mode == Mode.LiesAboutOutput) return p.amountOutMinimum;
        _call(p.tokenOut, abi.encodeCall(MockToken.transfer, (p.recipient, out)));
        return out;
    }

    /// Low-level so the mock can pay in tokens that return nothing.
    function _call(address token, bytes memory data) private {
        (bool ok,) = token.call(data);
        require(ok, "token call failed");
    }
}

contract HoldfastVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xB0B);
    address constant ATTACKER = address(0xBAD);

    uint256 constant MAX_TRADE = 100e18;
    uint256 constant LIFETIME = 1_000e18;
    uint256 constant FLOOR = 0.9e18;

    HoldfastVault vault;
    MockRouter router;
    MockToken a;
    MockToken b;

    function setUp() public {
        vm.warp(1_800_000_000);
        a = new MockToken(false);
        b = new MockToken(true);
        router = new MockRouter();
        vault = new HoldfastVault(OWNER, AGENT, address(router), address(a), address(b), 3000);
        a.mint(address(vault), 10_000e18);
        b.mint(address(router), 1_000_000e18);
        a.mint(address(router), 1_000_000e18);
        vm.prank(OWNER);
        vault.setLimits(address(a), MAX_TRADE, LIFETIME, FLOOR);
    }

    function _trade(uint256 amountIn, uint256 minOut, bytes32 id) internal returns (uint256) {
        vm.prank(AGENT);
        return vault.execute(address(a), amountIn, minOut, block.timestamp + 60, id);
    }

    function _eq(uint256 got, uint256 want) internal pure {
        require(got == want, "not equal");
    }

    // Benign path

    function test_trade_paysVaultAndSpendsCap() public {
        uint256 before = b.balanceOf(address(vault));
        uint256 out = _trade(10e18, 9e18, "one");
        _eq(out, 10e18);
        _eq(b.balanceOf(address(vault)) - before, 10e18);
        _eq(vault.remaining(address(a)), LIFETIME - 10e18);
        _eq(a.allowance(address(vault), address(router)), 0);
    }

    function test_trade_worksTwiceWithUsdtStyleApprove() public {
        _trade(10e18, 9e18, "one");
        _trade(10e18, 9e18, "two");
        _eq(vault.remaining(address(a)), LIFETIME - 20e18);
    }

    function test_trade_sellsTokenThatReturnsNothing() public {
        b.mint(address(vault), 100e18);
        vm.prank(OWNER);
        vault.setLimits(address(b), 10e18, 20e18, FLOOR);
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(AGENT);
            vault.execute(address(b), 10e18, 9e18, block.timestamp + 60, keccak256(abi.encode(i)));
        }
        _eq(vault.remaining(address(b)), 0);
        _eq(b.allowance(address(vault), address(router)), 0);
    }

    function test_ownerCanWithdrawAgentProceeds() public {
        _trade(10e18, 9e18, "one");
        vm.prank(OWNER);
        vault.withdraw(address(b), OWNER, 10e18);
        _eq(b.balanceOf(OWNER), 10e18);
    }

    // Attack family: recipient substitution and theft

    function test_attack_agentCannotWithdraw() public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.withdraw(address(a), AGENT, 1);
    }

    function test_attack_strangerCannotTrade() public {
        vm.prank(ATTACKER);
        vm.expectRevert(HoldfastVault.NotAgent.selector);
        vault.execute(address(a), 1e18, 1e18, block.timestamp + 60, "x");
    }

    function test_attack_agentCannotUseOtherToken() public {
        MockToken evil = new MockToken(false);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.BadToken.selector);
        vault.execute(address(evil), 1e18, 1e18, block.timestamp + 60, "x");
    }

    function test_attack_agentCannotChangeLimits() public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setLimits(address(a), type(uint256).max, type(uint256).max, 0);
    }

    function test_attack_agentCannotUnpauseOrReplaceItself() public {
        vm.prank(AGENT);
        vault.pause();
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.unpause();
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.setAgent(ATTACKER);
    }

    // Attack family: amount inflation and bad price

    function test_attack_overTradeCap() public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.OverTradeCap.selector);
        vault.execute(address(a), MAX_TRADE + 1, MAX_TRADE, block.timestamp + 60, "x");
    }

    function test_attack_lifetimeCapDoesNotRenew() public {
        for (uint256 i = 0; i < 10; i++) {
            _trade(MAX_TRADE, 90e18, keccak256(abi.encode(i)));
        }
        _eq(vault.remaining(address(a)), 0);
        vm.warp(block.timestamp + 365 days);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.OverLifetimeCap.selector);
        vault.execute(address(a), 1, 1, block.timestamp + 60, "later");
    }

    function test_attack_zeroMinOutRejected() public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.BelowFloor.selector);
        vault.execute(address(a), 10e18, 0, block.timestamp + 60, "x");
    }

    function test_attack_oneWeiBelowFloorRejected() public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.BelowFloor.selector);
        vault.execute(address(a), 10e18, 9e18 - 1, block.timestamp + 60, "x");
    }

    function test_attack_noFloorMeansNoTrade() public {
        b.mint(address(vault), 100e18);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.OverTradeCap.selector);
        vault.execute(address(b), 1e18, 1e18, block.timestamp + 60, "x");
        vm.prank(OWNER);
        vault.setLimits(address(b), 10e18, 10e18, 0);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.BelowFloor.selector);
        vault.execute(address(b), 1e18, 1e18, block.timestamp + 60, "x");
    }

    // Attack family: replay

    function test_attack_intentReplay() public {
        _trade(1e18, 0.9e18, "once");
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.IntentUsed.selector);
        vault.execute(address(a), 1e18, 0.9e18, block.timestamp + 60, "once");
    }

    function test_attack_changedPayloadSameIntent() public {
        _trade(1e18, 0.9e18, "once");
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.IntentUsed.selector);
        vault.execute(address(a), 2e18, 1.8e18, block.timestamp + 60, "once");
    }

    // Attack family: expiry and reset

    function test_attack_expiredIntent() public {
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.BadDeadline.selector);
        vault.execute(address(a), 1e18, 1e18, block.timestamp - 1, "x");
    }

    function test_attack_farFutureDeadline() public {
        uint256 deadline = block.timestamp + vault.MAX_INTENT_TTL() + 1;
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.BadDeadline.selector);
        vault.execute(address(a), 1e18, 1e18, deadline, "x");
    }

    function test_attack_pausedVaultRefuses() public {
        vm.prank(OWNER);
        vault.pause();
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.IsPaused.selector);
        vault.execute(address(a), 1e18, 1e18, block.timestamp + 60, "x");
    }

    // Attack family: hostile router, reentrancy

    function test_attack_routerShortPays() public {
        router.setMode(MockRouter.Mode.ShortPay, vault);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.InsufficientOutput.selector);
        vault.execute(address(a), 10e18, 9e18, block.timestamp + 60, "x");
        _eq(vault.remaining(address(a)), LIFETIME);
    }

    function test_attack_routerLiesAboutOutput() public {
        router.setMode(MockRouter.Mode.LiesAboutOutput, vault);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.InsufficientOutput.selector);
        vault.execute(address(a), 10e18, 9e18, block.timestamp + 60, "x");
    }

    function test_attack_routerReentersExecute() public {
        router.setMode(MockRouter.Mode.ReenterExecute, vault);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.Reentered.selector);
        vault.execute(address(a), 10e18, 9e18, block.timestamp + 60, "x");
    }

    function test_attack_routerReentersWithdraw() public {
        router.setMode(MockRouter.Mode.ReenterWithdraw, vault);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.NotOwner.selector);
        vault.execute(address(a), 10e18, 9e18, block.timestamp + 60, "x");
    }

    function test_partialPullLeavesNoAllowance() public {
        router.setMode(MockRouter.Mode.PartialPull, vault);
        _trade(10e18, 9e18, "partial");
        _eq(a.allowance(address(vault), address(router)), 0);
    }

    // Packed limits and the intent bitmap

    function test_attack_oversizedLimitsRefusedNotTruncated() public {
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.LimitTooLarge.selector);
        vault.setLimits(address(a), uint256(type(uint72).max) + 1, 1, 1);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.LimitTooLarge.selector);
        vault.setLimits(address(a), 1, uint256(type(uint72).max) + 1, 1);
        vm.prank(OWNER);
        vm.expectRevert(HoldfastVault.LimitTooLarge.selector);
        vault.setLimits(address(a), 1, 1, uint256(type(uint112).max) + 1);
        _eq(vault.maxTrade(address(a)), MAX_TRADE);
    }

    function test_limitsKeepTheirLargestValues() public {
        vm.prank(OWNER);
        vault.setLimits(address(a), type(uint72).max, type(uint72).max - 1, type(uint112).max);
        _eq(vault.maxTrade(address(a)), type(uint72).max);
        _eq(vault.remaining(address(a)), type(uint72).max - 1);
        _eq(vault.floorPriceX18(address(a)), type(uint112).max);
    }

    function test_attack_replayInsideASharedWord() public {
        bytes32 first = bytes32(uint256(0xabc00));
        bytes32 next = bytes32(uint256(0xabc01));
        _trade(1e18, 0.9e18, first);
        require(vault.usedIntent(first), "first not marked");
        require(!vault.usedIntent(next), "neighbour marked");
        _trade(1e18, 0.9e18, next);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.IntentUsed.selector);
        vault.execute(address(a), 1e18, 0.9e18, block.timestamp + 60, first);
    }

    /// Any two distinct IDs are independent, including ones that differ only in the bit index or only in the word.
    function testFuzz_intentBitmapHasNoCollisions(bytes32 one, bytes32 two) public {
        vm.assume(one != two);
        _trade(1e18, 0.9e18, one);
        require(vault.usedIntent(one), "not marked");
        require(!vault.usedIntent(two), "collision");
        _trade(1e18, 0.9e18, two);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.IntentUsed.selector);
        vault.execute(address(a), 1e18, 0.9e18, block.timestamp + 60, two);
    }

    /// The lock must not outlive its call: two trades in one transaction are not reentrancy.
    function test_lockClearsBetweenCalls() public {
        _trade(1e18, 0.9e18, "a");
        _trade(1e18, 0.9e18, "b");
        _eq(vault.remaining(address(a)), LIFETIME - 2e18);
    }

    // Properties

    function testFuzz_cannotSpendPastLifetimeCap(uint256[8] memory amounts) public {
        uint256 spent;
        uint256 start = a.balanceOf(address(vault));
        for (uint256 i = 0; i < amounts.length; i++) {
            // The first trade is always valid, so this test cannot pass by rejecting everything.
            uint256 amount = i == 0 ? 1e18 : amounts[i] % (MAX_TRADE * 2);
            uint256 minOut = (amount * FLOOR + 1e18 - 1) / 1e18;
            vm.prank(AGENT);
            try vault.execute(address(a), amount, minOut, block.timestamp + 60, keccak256(abi.encode(i))) {
                spent += amount;
            } catch {}
        }
        require(spent >= 1e18 && spent <= LIFETIME, "spent outside cap");
        _eq(vault.remaining(address(a)), LIFETIME - spent);
        _eq(start - a.balanceOf(address(vault)), spent);
    }

    /// The mock pays 1:1, so a trade is valid exactly when floorOut <= minOut <= amount.
    function testFuzz_acceptsOnlyTradesAboveFloor(uint256 amountSeed, uint256 minOutSeed) public {
        uint256 amount = 1 + amountSeed % MAX_TRADE;
        uint256 minOut = minOutSeed % (amount * 2);
        uint256 floorOut = (amount * FLOOR + 1e18 - 1) / 1e18;
        vm.prank(AGENT);
        try vault.execute(address(a), amount, minOut, block.timestamp + 60, "f") returns (uint256 out) {
            require(minOut >= floorOut, "accepted below floor");
            require(out >= minOut, "paid below minOut");
        } catch {
            require(minOut < floorOut || minOut > amount, "rejected a valid trade");
        }
    }
}
