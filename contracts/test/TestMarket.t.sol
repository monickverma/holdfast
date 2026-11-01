// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HoldfastVault} from "../HoldfastVault.sol";
import {TestPool, TestQuoter, TestRouter, TestToken} from "../test-market/TestMarket.sol";
import {Vm} from "./Mocks.sol";

/// The test market has to behave like the real pool in the ways the vault relies on, or a testnet demo proves nothing.
contract TestMarketTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xB0B);
    uint32 constant WINDOW = 300;
    uint16 constant BAND = 100;

    TestToken whsk;
    TestToken usdt;
    TestPool pool;
    TestRouter router;
    TestQuoter quoter;
    HoldfastVault vault;

    function setUp() public {
        vm.warp(1_800_000_000);
        whsk = new TestToken("Test WHSK", "tWHSK", 18);
        usdt = new TestToken("Test USDT", "tUSDT", 6);
        pool = new TestPool(whsk, usdt);
        router = new TestRouter(pool);
        quoter = new TestQuoter(pool);
        whsk.mint(address(this), 2_000_000e18);
        usdt.mint(address(this), 200_000e6);
        whsk.approve(address(pool), type(uint256).max);
        usdt.approve(address(pool), type(uint256).max);
        whsk.approve(address(router), type(uint256).max);
        usdt.approve(address(router), type(uint256).max);
        pool.seed(1_000_000e18, 90_000e6);

        vault = new HoldfastVault(OWNER, AGENT, block.timestamp + 1 days, address(router), address(whsk), address(usdt), 3000);
        whsk.mint(address(vault), 10_000e18);
        vm.prank(OWNER);
        vault.setLimits(address(whsk), 1_000e18, 4_000e18, 0.01e6, 4_000e18);
        vm.prank(OWNER);
        vault.setPriceGuard(address(pool), WINDOW, BAND);
    }

    function _push(uint256 amount) private {
        router.exactInputSingle(TestRouter.ExactInputSingleParams(address(whsk), address(usdt), 3000, address(this), amount, 0, 0));
    }

    function _tick() private view returns (int24 tick) {
        (, tick,,,,,) = pool.slot0();
    }

    function _twap(uint32 window) private view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory c,) = pool.observe(ago);
        return int24((c[1] - c[0]) / int56(uint56(window)));
    }

    function test_aFreshPoolHasATwapAtItsOwnPrice() public view {
        require(_twap(WINDOW) == _tick(), "seed price counts as having always held");
    }

    function test_oneSwapMovesSpotAndNotTheTwap() public {
        int24 before = _tick();
        vm.warp(block.timestamp + 10);
        _push(50_000e18);
        require(_tick() < before - 500, "swap should move spot");
        require(_twap(WINDOW) == before, "the same second cannot change the TWAP");
    }

    function test_aPriceHeldForTheWindowBecomesTheTwap() public {
        vm.warp(block.timestamp + 10);
        _push(50_000e18);
        int24 pushed = _tick();
        vm.warp(block.timestamp + WINDOW);
        require(_twap(WINDOW) == pushed, "the whole window at the pushed price");
    }

    function test_aPriceHeldForHalfTheWindowMovesTheTwapHalfWay() public {
        int24 before = _tick();
        vm.warp(block.timestamp + 1000);
        _push(50_000e18);
        int24 pushed = _tick();
        vm.warp(block.timestamp + WINDOW / 2);
        int24 twap = _twap(WINDOW);
        int24 middle = before + (pushed - before) / 2;
        require(twap <= middle + 1 && twap >= middle - 1, "half way");
    }

    function test_observationsOverSeveralSwapsInterpolate() public {
        int24 first = _tick();
        vm.warp(block.timestamp + 100);
        _push(10_000e18);
        int24 second = _tick();
        vm.warp(block.timestamp + 100);
        _push(10_000e18);
        vm.warp(block.timestamp + 100);
        _push(1e18);
        // The last 200 seconds: 100 at `second`, then 100 at the tick after the second push, which this one barely moves.
        int24 third = _tick();
        int24 twap = _twap(200);
        int24 expected = (second + third) / 2;
        require(twap <= expected + 2 && twap >= expected - 2, "interpolated");
        require(_twap(300) < first, "history reaches back");
    }

    function test_quoterGivesThePriceTheSwapReallyLeaves() public {
        TestQuoter.QuoteParams memory params = TestQuoter.QuoteParams(address(whsk), address(usdt), 20_000e18, 3000, 0);
        (uint256 out, uint160 after_,,) = quoter.quoteExactInputSingle(params);
        uint256 usdtBefore = usdt.balanceOf(address(this));
        _push(20_000e18);
        (uint160 actual,,,,,,) = pool.slot0();
        require(usdt.balanceOf(address(this)) - usdtBefore == out, "quoted output");
        require(actual == after_, "quoted post-swap price");
    }

    function test_vaultGuardAcceptsThisPoolAndRefusesASaleIntoAPush() public {
        vm.warp(block.timestamp + 10);
        _push(50_000e18);
        vm.prank(AGENT);
        vm.expectRevert(HoldfastVault.PriceOutOfBand.selector);
        vault.execute(address(whsk), 100e18, 1e6, block.timestamp + 60, bytes32(uint256(1)));
    }

    function test_vaultStopWaitsForTheWindowOnThisPool() public {
        int24 trigger = _tick() - 200;
        vm.prank(OWNER);
        vault.armStop(address(whsk), trigger, 100e18, 300e18, 0.01e6, 20_000, 60);
        vm.warp(block.timestamp + 10);
        _push(50_000e18);
        require(!vault.stopReady(), "one push must not trigger");
        vm.warp(block.timestamp + WINDOW);
        require(vault.stopReady(), "a held price triggers");
        require(vault.triggerStop() > 0, "the stop sold");
    }

    function test_aGuardedTradeFitsTheAgentsGasLimit() public {
        uint256 before = gasleft();
        vm.prank(AGENT);
        vault.execute(address(whsk), 100e18, 1e6, block.timestamp + 60, bytes32(uint256(1)));
        require(before - gasleft() < 500_000, "over GAS_LIMIT in executor.ts");
    }
}
