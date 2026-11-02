// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {PushOracle} from "../src/oracles/PushOracle.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {SimVenue} from "../src/mocks/SimVenue.sol";
import {IVenue} from "../src/interfaces/IVenue.sol";

/// @dev Pays exactly the minimum it is asked for, as a pool pushed to that price would.
contract MinOutVenue is IVenue {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to) external returns (uint256) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(to, minOut);
        return minOut;
    }
}

/// @dev Reads the vault's breaker from inside the swap, while the vault's balances are mid-trade.
contract PokingVenue is IVenue {
    AgentVault public vault;
    bool public outputFirst;

    function configure(AgentVault v, bool first) external {
        vault = v;
        outputFirst = first;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to) external returns (uint256) {
        if (outputFirst) {
            IERC20(tokenOut).transfer(to, minOut);
            vault.pokeCircuitBreaker();
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        } else {
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
            vault.pokeCircuitBreaker();
            IERC20(tokenOut).transfer(to, minOut);
        }
        return minOut;
    }
}

/// @notice Each test states one claim about the Sentinel source at the pinned commit. A pass means the claim holds there.
///         Names say whether the behaviour is a weakness (WEAK), or a hypothesis this run refuted (SOUND).
contract SentinelProbes is Test {
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address author = makeAddr("author");
    address stranger = makeAddr("stranger");

    MockERC20 usdt;
    MockERC20 weth;
    MockERC20 wbtc;
    PushOracle oracle;
    SimVenue sim;
    MinOutVenue minOutVenue;
    PokingVenue poking;
    StrategyRegistry registry;
    VaultFactory factory;
    AgentVault vault;
    uint256 sid;

    uint256 constant ETH = 2_400e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdt = new MockERC20("USDT", "USDT", 6);
        weth = new MockERC20("WETH", "WETH", 18);
        wbtc = new MockERC20("WBTC", "WBTC", 8);
        oracle = new PushOracle(address(this), 2500);
        _prices(1e18, ETH);
        sim = new SimVenue(oracle, 10, 1_000_000);
        minOutVenue = new MinOutVenue();
        poking = new PokingVenue();
        for (uint256 i; i < 3; ++i) {
            address v = i == 0 ? address(sim) : i == 1 ? address(minOutVenue) : address(poking);
            usdt.mint(v, 10_000_000e6);
            weth.mint(v, 10_000e18);
        }
        registry = new StrategyRegistry();
        factory = new VaultFactory();
        vm.prank(author);
        sid = registry.register("s", "u", keccak256("params"));
        vault = _vault(owner, agent, AgentVault.Limits(2500, 10_000, 1000, 200, 0, 3600));
        poking.configure(vault, false);
        usdt.mint(owner, 100_000e6);
        vm.startPrank(owner);
        usdt.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6);
        vm.stopPrank();
    }

    function _vault(address o, address a, AgentVault.Limits memory l) private returns (AgentVault) {
        address[] memory toks = new address[](2);
        toks[0] = address(weth);
        toks[1] = address(wbtc);
        address[] memory venues = new address[](3);
        venues[0] = address(sim);
        venues[1] = address(minOutVenue);
        venues[2] = address(poking);
        vm.prank(o);
        return factory.createVault(AgentVault.Config(o, a, address(usdt), address(oracle), address(registry), sid, toks, venues, l));
    }

    function _prices(uint256 usd, uint256 eth) private {
        address[] memory t = new address[](2);
        uint256[] memory p = new uint256[](2);
        t[0] = address(usdt);
        t[1] = address(weth);
        p[0] = usd;
        p[1] = eth;
        oracle.setPrices(t, p);
    }

    function _priceWbtc(uint256 p0) private {
        address[] memory t = new address[](1);
        uint256[] memory p = new uint256[](1);
        t[0] = address(wbtc);
        p[0] = p0;
        oracle.setPrices(t, p);
    }

    /// @dev 1,000 USDT for WETH at the given output per 1e6 of slippage allowance.
    function _buy(address venue, uint256 usdtIn, uint256 slipBps, bytes32 h) private {
        uint256 fair = (usdtIn * 1e18 * 1e18) / (ETH * 1e6);
        vm.prank(agent);
        vault.executeTrade(AgentVault.Trade(venue, address(usdt), address(weth), usdtIn, (fair * (10_000 - slipBps)) / 10_000, h));
    }

    // ---------------------------------------------------------------- 3.1 breaker

    function test_SOUND_breakerPersistsAfterALossyTradeWithoutReverting() public {
        // Limit 1% drawdown, trades allowed to give up 3%. Each 24,000 USDT trade loses about 0.72% of NAV, so the second breaches.
        vm.prank(owner);
        vault.setLimits(AgentVault.Limits(2500, 50_000, 100, 300, 0, 3600));
        _buy(address(minOutVenue), 24_000e6, 300, keccak256("1"));
        assertFalse(vault.halted());
        _buy(address(minOutVenue), 24_000e6, 300, keccak256("2"));
        assertTrue(vault.halted(), "the halt is written by the trade that lost, and survives because that trade does not revert");
        vm.prank(agent);
        vm.expectRevert(AgentVault.IsHalted.selector);
        vault.executeTrade(AgentVault.Trade(address(sim), address(usdt), address(weth), 1e6, 1, keccak256("3")));
        assertLt(vault.nav(), 100_000e6, "the loss that tripped it stands");
    }

    function test_WEAK_aBreachSeenBeforeATradeRevertsAndPersistsNothingUntilSomeonePokes() public {
        vm.prank(owner);
        vault.setLimits(AgentVault.Limits(2500, 50_000, 500, 200, 0, 3600));
        _buy(address(sim), 25_000e6, 200, keccak256("1"));
        // Prices fall. The breach is real, but a refused trade can write nothing.
        _prices(1e18, ETH - ETH / 4);
        vm.prank(agent);
        vm.expectRevert(AgentVault.DrawdownBreached.selector);
        vault.executeTrade(AgentVault.Trade(address(sim), address(usdt), address(weth), 1e6, 1, keccak256("2")));
        assertFalse(vault.halted(), "no halt until a separate transaction");
        // If the price recovers before anyone pokes, the vault never halted at all.
        _prices(1e18, 2_250e18);
        _prices(1e18, ETH);
        vault.pokeCircuitBreaker();
        assertFalse(vault.halted());
    }

    function test_WEAK_staleOracleBlocksThePokeAndErasesTheHighWaterMarkOnAnyWithdrawal() public {
        vm.prank(owner);
        vault.setLimits(AgentVault.Limits(2500, 50_000, 500, 200, 0, 3600));
        _buy(address(sim), 25_000e6, 200, keccak256("1"));
        uint256 hwm = vault.highWaterMark();
        assertGt(hwm, 0);
        vm.warp(block.timestamp + 3601);
        vm.expectRevert();
        vault.pokeCircuitBreaker();
        // The owner can withdraw, as promised. One base unit, during an outage, also wipes the drawdown history.
        vm.prank(owner);
        vault.withdraw(address(usdt), 1, owner);
        assertEq(vault.highWaterMark(), 0, "drawdown baseline gone");
        // Prices return 25% lower. The next read takes this lower NAV as the new peak, with no breach and no halt.
        _prices(1e18, ETH - ETH / 4);
        vault.pokeCircuitBreaker();
        assertFalse(vault.halted());
        assertEq(vault.drawdownBps(), 0);
        assertLt(vault.highWaterMark(), hwm);
    }

    function test_SOUND_ownerWithdrawsWithStaleOracleHaltedAndStrategyOff() public {
        vm.prank(agent);
        vault.halt();
        vm.prank(author);
        registry.setActive(sid, false);
        vm.warp(block.timestamp + 10 days);
        vm.prank(owner);
        vault.withdraw(address(usdt), 100_000e6, owner);
        assertEq(usdt.balanceOf(owner), 100_000e6);
    }

    // ---------------------------------------------------------------- 2.1 limits

    function test_WEAK_rollingLimitIsATumblingWindowSoTurnoverDoublesAtTheBoundary() public {
        vm.prank(owner);
        vault.setLimits(AgentVault.Limits(5000, 5000, 5000, 1000, 0, 100_000));
        // 50% of NAV just before the window ends, and 50% again right after: twice the "rolling 24h" limit in two seconds.
        _buy(address(sim), 1_000e6, 200, keccak256("open"));
        vm.warp(block.timestamp + 1 days - 1);
        _buy(address(sim), 48_000e6, 1000, keccak256("a"));
        vm.warp(block.timestamp + 1);
        _buy(address(sim), 40_000e6, 1000, keccak256("b"));
        assertEq(vault.dayVolume(), 40_000e6);
    }

    function test_WEAK_navCapsGrowWithDonationsAndWithTheOracle() public {
        vm.prank(agent);
        vm.expectRevert();
        vault.executeTrade(AgentVault.Trade(address(sim), address(usdt), address(weth), 30_000e6, 1, keccak256("big")));
        // Nothing fixes the cap in absolute terms: anyone's transfer into the vault raises what the agent may trade.
        usdt.mint(address(vault), 100_000e6);
        _buy(address(sim), 30_000e6, 200, keccak256("ok"));
    }

    function test_WEAK_oneDustTransferOfAStalePricedTokenStopsTradingThePokeAndResume() public {
        _priceWbtc(80_000e18);
        vm.warp(block.timestamp + 3601);
        _prices(1e18, ETH); // Base and WETH are fresh. WBTC, whose balance is zero, is stale and so far harmless.
        _buy(address(sim), 1_000e6, 200, keccak256("works"));
        vm.prank(stranger);
        deal(address(wbtc), stranger, 1);
        vm.prank(stranger);
        wbtc.transfer(address(vault), 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.StaleOracle.selector, address(wbtc)));
        vault.executeTrade(AgentVault.Trade(address(sim), address(usdt), address(weth), 1e6, 1, keccak256("blocked")));
        vm.expectRevert();
        vault.pokeCircuitBreaker();
        vm.prank(agent);
        vm.expectRevert();
        vault.recordHold(keccak256("no record either"));
        vm.prank(agent);
        vault.halt();
        vm.prank(owner);
        vm.expectRevert();
        vault.resume(false);
    }

    function test_WEAK_noExpiryOnTheAgentOrOnATrade() public {
        vm.warp(block.timestamp + 3650 days);
        _prices(1e18, ETH);
        // Ten years on, the same key and a trade carrying no deadline still pass.
        _buy(address(sim), 1_000e6, 200, keccak256("years later"));
    }

    function test_WEAK_factoryAllowsOwnerAsAgentAndLimitsThatRemoveTheOracleFloor() public {
        AgentVault v = _vault(owner, owner, AgentVault.Limits(10_000, 60_000, 10_000, 10_000, 0, type(uint32).max));
        assertEq(v.agent(), v.owner());
        (,,, uint16 slip,,) = v.limits();
        assertEq(slip, 10_000);
    }

    // ---------------------------------------------------------------- 2.2 oracle

    function test_WEAK_pushOracleMoveLimitIsPerCallSoAPublisherReachesAnyPriceInOneBlock() public {
        for (uint256 i; i < 12; ++i) {
            address[] memory t = new address[](1);
            uint256[] memory p = new uint256[](1);
            t[0] = address(weth);
            (uint256 now_,) = oracle.getPrice(address(weth));
            p[0] = (now_ * 3) / 4 + 1;
            t[0] = address(weth);
            oracle.setPrices(t, p);
        }
        (uint256 price,) = oracle.getPrice(address(weth));
        assertLt(price, ETH / 25, "over 96% in one block, against a 25% per-update limit");
    }

    /// @dev script/DeployDemo.s.sol calls oracle.setPublisher(agent, true). This is that role, with a venue paying only the minimum.
    function _thiefMarksWethDown(uint256 steps) private {
        oracle.setPublisher(agent, true);
        address[] memory t = new address[](1);
        uint256[] memory p = new uint256[](1);
        t[0] = address(usdt);
        for (uint256 i; i < steps; ++i) {
            (uint256 cur,) = oracle.getPrice(address(usdt));
            p[0] = (cur * 125) / 100;
            vm.prank(agent);
            oracle.setPrices(t, p);
        }
    }

    function test_WEAK_agentThatPublishesTheOracleSellsBelowTrueValueUnderTheBreaker() public {
        vm.prank(owner);
        vault.setLimits(AgentVault.Limits(2500, 50_000, 500, 200, 0, 3600));
        _buy(address(sim), 8_000e6, 200, keccak256("position"));
        uint256 held = weth.balanceOf(address(vault));
        _thiefMarksWethDown(2);
        (uint256 pUsdt,) = oracle.getPrice(address(usdt));
        uint256 minOut = (held * ETH * 1e6 * 9800) / (pUsdt * 1e18 * 10_000) + 1;
        uint256 before = usdt.balanceOf(address(vault));
        vm.prank(agent);
        vault.executeTrade(AgentVault.Trade(address(minOutVenue), address(weth), address(usdt), held, minOut, keccak256("sell")));
        uint256 got = usdt.balanceOf(address(vault)) - before;
        uint256 trueValue = (held * ETH) / 1e18 / 1e12;
        assertLt(got, (trueValue * 65) / 100, "sold for under 65% of the true price, with every on-chain check passing");
        assertFalse(vault.halted());
    }

    function test_SOUND_theBreakerBoundsThatSaleOnceTheMarkdownIsLargeEnoughToSee() public {
        vm.prank(owner);
        vault.setLimits(AgentVault.Limits(2500, 50_000, 500, 200, 0, 3600));
        _buy(address(sim), 24_000e6, 200, keccak256("position"));
        uint256 held = weth.balanceOf(address(vault));
        _thiefMarksWethDown(4);
        vm.prank(agent);
        vm.expectRevert(AgentVault.DrawdownBreached.selector);
        vault.executeTrade(AgentVault.Trade(address(minOutVenue), address(weth), address(usdt), held / 4, 1, keccak256("sell")));
    }

    function test_WEAK_thatSamePublisherCanHaltAnyVaultOnTheOracle() public {
        vm.prank(owner);
        vault.setLimits(AgentVault.Limits(2500, 50_000, 500, 200, 0, 3600));
        _buy(address(sim), 24_000e6, 200, keccak256("position"));
        _thiefMarksWethDown(4);
        vm.prank(stranger);
        vault.pokeCircuitBreaker();
        assertTrue(vault.halted());
    }

    // ---------------------------------------------------------------- reentrancy

    function test_WEAK_venueCanPokeTheBreakerMidSwapAndHaltOnPhantomLoss() public {
        vm.prank(owner);
        vault.setLimits(AgentVault.Limits(2500, 50_000, 500, 200, 0, 3600));
        vault.pokeCircuitBreaker();
        // Input gone, output not yet back: the vault looks 25% poorer for an instant, and that is enough to write a halt.
        _buy(address(poking), 25_000e6, 100, keccak256("x"));
        assertTrue(vault.halted(), "halted by a read of mid-trade balances");
        assertLt(vault.drawdownBps(), 500, "the real NAV never breached");
    }

    function test_WEAK_venueCanInflateTheHighWaterMarkMidSwap() public {
        poking.configure(vault, true);
        vm.prank(owner);
        vault.setLimits(AgentVault.Limits(2500, 50_000, 1000, 200, 0, 3600));
        vault.pokeCircuitBreaker();
        uint256 before = vault.highWaterMark();
        _buy(address(poking), 25_000e6, 100, keccak256("x"));
        assertGt(vault.highWaterMark(), before + 20_000e6, "peak counted both sides of one trade");
    }

    // ---------------------------------------------------------------- 3.2 registry

    function test_WEAK_authorKeyStopsEveryVaultOnTheStrategyAndOwnerMustMigrateToResume() public {
        vm.prank(author);
        registry.setActive(sid, false);
        vm.prank(agent);
        vm.expectRevert(AgentVault.StrategyInactive.selector);
        vault.executeTrade(AgentVault.Trade(address(sim), address(usdt), address(weth), 1e6, 1, keccak256("a")));
        vm.prank(owner);
        uint256 mine = registry.register("mine", "u", bytes32(0));
        vm.prank(owner);
        vault.setStrategy(mine);
        _buy(address(sim), 1_000e6, 200, keccak256("b"));
    }

    function test_WEAK_authorCanChangeTheStrategyUnderAVaultWithNoPin() public {
        _buy(address(sim), 1_000e6, 200, keccak256("v1"));
        vm.prank(author);
        registry.update(sid, "new", keccak256("different params"));
        assertEq(registry.versionOf(sid), 2);
        _buy(address(sim), 1_000e6, 200, keccak256("v2")); // Accepted. Nothing compares paramsHash or version to what the owner chose.
    }

    function test_WEAK_registryEnforcesNothingAboutWhatTheAgentActuallyRuns() public {
        // A stolen key, running no strategy at all, passes the check as long as the entry stays active.
        vm.prank(agent);
        vault.executeTrade(AgentVault.Trade(address(sim), address(usdt), address(weth), 1_000e6, (1_000e6 * 1e18 * 1e18 * 98) / (ETH * 1e6 * 100), bytes32(0)));
    }

    // ---------------------------------------------------------------- 3.4 records

    function test_WEAK_oneDecisionHashCanAuthorizeManyTradesAndHolds() public {
        bytes32 h = keccak256("one decision");
        _buy(address(sim), 1_000e6, 200, h);
        _buy(address(sim), 1_000e6, 200, h);
        vm.prank(agent);
        vault.recordHold(h);
        assertEq(vault.logCount(), 3);
    }

    function test_SOUND_everyExecutedTradeAdvancesTheLogAndTheHeadChanges() public {
        bytes32 before = vault.logHead();
        _buy(address(sim), 1_000e6, 200, keccak256("x"));
        assertEq(vault.logCount(), 1);
        assertTrue(vault.logHead() != before);
    }

    function test_SOUND_aLyingVenueCannotFakeOutputOrOverspend() public {
        vm.prank(owner);
        vault.setVenue(address(this), true);
        vm.prank(agent);
        vm.expectRevert();
        vault.executeTrade(AgentVault.Trade(address(this), address(usdt), address(weth), 1_000e6, 1e17, keccak256("x")));
    }

    /// @dev Reports a full fill and moves nothing.
    function swap(address, address, uint256, uint256 minOut, address) external pure returns (uint256) {
        return minOut;
    }
}
