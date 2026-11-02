// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HoldfastVault} from "../HoldfastVault.sol";
import {ISwapRouter02} from "../HoldfastVault.sol";

interface Vm {
    function prank(address sender) external;
    function deal(address who, uint256 balance) external;
    function warp(uint256 timestamp) external;
    function roll(uint256 blockNumber) external;
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function envOr(string calldata name, bool defaultValue) external returns (bool);
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
}

interface IWhsk {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IPoolRead {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// Runs real swaps against the real HSKSwap router and pool on a local fork. Nothing is broadcast.
/// Enable with FORK_TESTS=true, since it depends on the public RPC.
contract HoldfastVaultForkTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant ROUTER = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3;
    address constant POOL = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC;
    address constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xB0B);
    address constant ATTACKER = address(0xBAD);
    uint32 constant WINDOW = 600;
    uint16 constant BAND = 100;

    function _vault() private returns (HoldfastVault vault) {
        vault = new HoldfastVault(OWNER, AGENT, block.timestamp + 1 days, ROUTER, WHSK, USDT, 3000);
        vm.deal(address(this), 400e18);
        IWhsk(WHSK).deposit{value: 300e18}();
        IWhsk(WHSK).transfer(address(vault), 300e18);
        vm.prank(OWNER);
        vault.setLimits(WHSK, 100e18, 300e18, 0.01e6, 300e18);
    }

    function _tick() private view returns (int24 tick) {
        (, tick,,,,,) = IPoolRead(POOL).slot0();
    }

    /// Sells `capital` of WHSK into the pool as an outsider, pushing the price down.
    function _push(uint256 capital) private {
        vm.deal(ATTACKER, capital + 1e18);
        vm.prank(ATTACKER);
        IWhsk(WHSK).deposit{value: capital}();
        vm.prank(ATTACKER);
        IWhsk(WHSK).approve(ROUTER, capital);
        vm.prank(ATTACKER);
        ISwapRouter02(ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams(WHSK, USDT, 3000, ATTACKER, capital, 0, 0));
    }

    /// Version 4's loss guard and log, with fills priced by the real pool rather than a mock.
    function test_fork_lossGuardAndLogAgainstTheRealPool() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork("hsk");
        HoldfastVault vault = _vault();
        bytes24 head = vault.logHead();

        vm.prank(AGENT);
        uint256 out = vault.execute(WHSK, 1e18, 0.01e6, block.timestamp + 60, "first");
        head = bytes24(keccak256(abi.encode(head, uint64(1), uint8(1), bytes32("first"), WHSK, uint256(1e18), out, block.timestamp)));
        require(vault.logHead() == head && vault.logCount() == 1, "the real fill must enter the log");

        // A mark at twice the market makes each sale lose about one `out` against it.
        vm.prank(OWNER);
        vault.setLossGuard(out * 2, out * 3, 1 hours);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.OverLossBudget.selector);
        vault.execute(WHSK, 3e18, 3 * (out / 2), block.timestamp + 60, "too much");

        vm.prank(AGENT);
        vault.execute(WHSK, 1e18, out / 2, block.timestamp + 60, "second");
        require(!vault.paused(), "half the budget is not yet gone");
        vm.prank(AGENT);
        vault.execute(WHSK, 1e18, out / 2, block.timestamp + 60, "third");
        require(vault.paused(), "the breaker must trip and stay tripped");
        require(vault.logCount() == 3, "both real fills must enter the log");

        vm.prank(OWNER);
        vault.unpause();
        vm.warp(block.timestamp + 2 hours);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.MarkStale.selector);
        vault.execute(WHSK, 1e18, out / 2, block.timestamp + 60, "stale");

        // A stale mark and a halt stop the agent and never the owner.
        vm.prank(OWNER);
        vault.halt();
        uint256 held = IWhsk(WHSK).balanceOf(address(vault));
        vm.prank(OWNER);
        vault.withdraw(WHSK, OWNER, held);
        require(IWhsk(WHSK).balanceOf(OWNER) == held, "the owner must get everything out");
    }

    function test_fork_roundTripThroughRealRouter() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork("hsk");

        HoldfastVault vault = new HoldfastVault(OWNER, AGENT, block.timestamp + 1 days, ROUTER, WHSK, USDT, 3000);
        vm.deal(address(this), 200e18);
        IWhsk(WHSK).deposit{value: 100e18}();
        IWhsk(WHSK).transfer(address(vault), 100e18);

        // Floors are deliberately loose here; the test proves routing and accounting, not pricing.
        vm.prank(OWNER);
        vault.setLimits(WHSK, 100e18, 100e18, 0.01e6, 100e18);
        vm.prank(OWNER);
        vault.setLimits(USDT, 100e6, 100e6, 1e30, 100e6);

        vm.prank(AGENT);
        uint256 usdtOut = vault.execute(WHSK, 50e18, 0.5e6, block.timestamp + 60, "sell");
        require(usdtOut > 0, "no usdt");
        require(IWhsk(USDT).balanceOf(address(vault)) == usdtOut, "usdt not in vault");

        vm.prank(AGENT);
        uint256 whskOut = vault.execute(USDT, usdtOut, (usdtOut * 1e30 + 1e18 - 1) / 1e18, block.timestamp + 60, "buy");
        require(whskOut > 0 && whskOut < 50e18, "round trip must lose fees");
        require(IWhsk(WHSK).balanceOf(address(vault)) == 50e18 + whskOut, "whsk not in vault");

        // A floor above the market must make the real router revert rather than fill badly.
        vm.prank(AGENT);
        vm.expectRevert();
        vault.execute(WHSK, 1e18, 1_000e6, block.timestamp + 60, "too-greedy");
    }

    function test_fork_guardReadsTheRealOracle() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork("hsk");
        HoldfastVault vault = _vault();
        vm.prank(OWNER);
        vault.setPriceGuard(POOL, WINDOW, BAND);
        (bool ok, int24 spot, int24 twap) = vault.priceGuardTicks();
        require(ok, "real pool oracle did not answer");
        require(spot == _tick(), "spot");
        require(twap < 0 && twap > -887272, "twap out of range");
        // WHSK is token0 of the real pool, and a normal trade passes.
        vm.prank(AGENT);
        vault.execute(WHSK, 1e18, 0.01e6, block.timestamp + 60, "normal");
    }

    function test_fork_attack_guardRefusesASaleIntoARealPushedPool() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork("hsk");
        HoldfastVault vault = _vault();
        vm.prank(OWNER);
        vault.setPriceGuard(POOL, WINDOW, BAND);
        vm.warp(block.timestamp + WINDOW);
        vm.roll(block.number + 1);
        int24 before = _tick();

        // A thief who holds the agent key pushes the real pool, then sells the vault into it.
        _push(300_000e18);
        int24 pushed = _tick();
        require(before - pushed > int24(uint24(BAND)), "push too small to test anything");
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.PriceOutOfBand.selector);
        vault.execute(WHSK, 20e18, 0.2e6, block.timestamp + 60, "into-the-push");

        // The same trade passes the older checks alone: floor and caps do not see the push.
        vm.prank(OWNER);
        vault.setPriceGuard(address(0), 0, 0);
        vm.prank(AGENT);
        uint256 out = vault.execute(WHSK, 20e18, 0.2e6, block.timestamp + 60, "guard-off");
        require(out > 0, "guard off should fill");
    }

    function test_fork_attack_realPushCannotFireAStopUntilItHoldsForTheWindow() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork("hsk");
        HoldfastVault vault = _vault();
        vm.prank(OWNER);
        vault.setPriceGuard(POOL, WINDOW, BAND);
        vm.warp(block.timestamp + WINDOW);
        vm.roll(block.number + 1);
        int24 before = _tick();
        // A trigger 50 ticks below the market, and a band wide enough that the band is not what stops it.
        vm.prank(OWNER);
        vault.armStop(WHSK, before - 50, 10e18, 30e18, 0.01e6, 20_000, 600);

        _push(300_000e18);
        require(before - _tick() > 50, "push did not cross the trigger");
        require(!vault.stopReady(), "one push should not trigger");
        vm.expectRevert(HoldfastVault.StopNotTriggered.selector);
        vault.triggerStop();

        // Held for the window, the TWAP crosses, and anyone can fire it. The vault keeps the proceeds.
        vm.warp(block.timestamp + WINDOW);
        vm.roll(block.number + 1);
        require(vault.stopReady(), "held price should trigger");
        uint256 usdtBefore = IWhsk(USDT).balanceOf(address(vault));
        vm.prank(address(0xCAFE));
        uint256 out = vault.triggerStop();
        require(out > 0 && IWhsk(USDT).balanceOf(address(vault)) == usdtBefore + out, "proceeds");
        require(IWhsk(USDT).balanceOf(address(0xCAFE)) == 0, "caller paid");
    }

    function test_fork_attack_stopRefusesWhileThePriceIsPushedPastItsBand() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork("hsk");
        HoldfastVault vault = _vault();
        vm.prank(OWNER);
        vault.setPriceGuard(POOL, WINDOW, BAND);
        // Trigger above the market, so the TWAP has already crossed it.
        int24 trigger = _tick() + 1000;
        vm.prank(OWNER);
        vault.armStop(WHSK, trigger, 10e18, 30e18, 0.01e6, 50, 600);
        vm.warp(block.timestamp + WINDOW);
        vm.roll(block.number + 1);
        _push(300_000e18);
        vm.expectRevert(HoldfastVault.PriceOutOfBand.selector);
        vault.triggerStop();
    }

    function test_fork_ownerWithdrawsDuringAnEmergency() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork("hsk");
        HoldfastVault vault = _vault();
        vm.prank(OWNER);
        vault.setPriceGuard(POOL, WINDOW, BAND);
        vm.prank(OWNER);
        vault.halt();
        vm.prank(OWNER);
        vault.revokeAgent();
        vm.prank(OWNER);
        vault.withdraw(WHSK, OWNER, 300e18);
        require(IWhsk(WHSK).balanceOf(OWNER) == 300e18, "stuck");
    }

    receive() external payable {}
}
