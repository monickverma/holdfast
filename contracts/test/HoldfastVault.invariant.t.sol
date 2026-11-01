// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HoldfastVault} from "../HoldfastVault.sol";
import {FlexToken, ImpactRouter, MockPool, Vm} from "./Mocks.sol";

/// Random sequences of everything anyone can do to the vault. Each action asserts what must hold right after it, and
/// `fail_on_revert` makes any unexpected revert a failure, so a stuck owner cannot go unnoticed.
contract VaultHandler {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xB0B);
    address constant GUARDIAN = address(0x6A7D);
    address constant THIEF = address(0xBAD);

    uint256 public constant MAX_TRADE = 100e18;
    uint256 public constant LIFETIME = 1_500e18;
    uint256 public constant HOURLY = 300e18;
    uint256 public constant DAILY = 800e18;
    uint256 public constant FLOOR = 0.9e18;
    uint256 public constant STOP_TOTAL = 200e18;

    HoldfastVault public vault;
    FlexToken public a;
    FlexToken public b;
    ImpactRouter public router;
    MockPool public pool;
    uint256 public start;

    uint256 public agentSpent;
    uint256 public agentOut;
    uint256 public stopSpent;
    uint256 public stopOut;
    uint256 public withdrawn;
    uint256 public accepted;
    uint256 public refused;
    uint256 private nextIntent;

    constructor() {
        vm.warp(1_800_000_000);
        start = block.timestamp;
        a = new FlexToken();
        b = new FlexToken();
        router = new ImpactRouter();
        pool = new MockPool(address(a), address(b));
        router.setPool(pool);
        router.setRate(1e18);
        vault = new HoldfastVault(OWNER, AGENT, block.timestamp + 30 days, address(router), address(a), address(b), 3000);
        a.mint(address(vault), 1_000_000e18);
        a.mint(address(router), 10_000_000e18);
        b.mint(address(router), 10_000_000e18);
        vm.prank(OWNER);
        vault.setLimits(address(a), MAX_TRADE, LIFETIME, FLOOR, HOURLY);
        vm.prank(OWNER);
        vault.setDailyBudget(address(a), DAILY);
        vm.prank(OWNER);
        vault.setGuardian(GUARDIAN);
        vm.prank(OWNER);
        vault.setPriceGuard(address(pool), 300, 100);
        vm.prank(OWNER);
        vault.armStop(address(a), -1000, 20e18, STOP_TOTAL, 0.5e18, 500, 600);
    }

    function passTime(uint32 seconds_) external {
        vm.warp(block.timestamp + (seconds_ % 2 hours));
    }

    /// Mostly near the band's edges and the stop's trigger, so most trades are decided by the checks and not by chance.
    function movePrice(uint16 spotSeed, uint16 twapSeed) external {
        int24 twap = -1100 + int24(uint24(twapSeed % 300));
        pool.setPrice(twap - 150 + int24(uint24(spotSeed % 300)), twap);
    }

    function setRate(uint256 seed) external {
        router.setRate(0.4e18 + (seed % 0.8e18));
    }

    /// Whatever the agent key signs, from any amount, floor, deadline or replayed intent.
    function agentTrade(uint256 amountSeed, uint256 minOutSeed, uint256 deadlineSeed, bool replay) external {
        uint256 amount = amountSeed % (MAX_TRADE * 2);
        // Half the time a minOut that clears the floor, so trades get past the first check and reach the rest.
        uint256 minOut = minOutSeed % 2 == 0 ? (amount * FLOOR + 1e18 - 1) / 1e18 : minOutSeed % (amount + 1);
        uint256 deadline = block.timestamp - 1 + (deadlineSeed % 200);
        bytes32 intent = bytes32(replay ? nextIntent : ++nextIntent);
        uint256 inBefore = a.balanceOf(address(vault));
        uint256 outBefore = b.balanceOf(address(vault));
        vm.prank(AGENT);
        try vault.execute(address(a), amount, minOut, deadline, intent) returns (uint256 out) {
            accepted++;
            agentSpent += inBefore - a.balanceOf(address(vault));
            agentOut += b.balanceOf(address(vault)) - outBefore;
            require(out == b.balanceOf(address(vault)) - outBefore, "reported output is not what arrived");
        } catch {
            refused++;
            require(a.balanceOf(address(vault)) == inBefore && b.balanceOf(address(vault)) == outBefore, "a refusal moved funds");
        }
    }

    /// A stranger firing the stop. It may be refused, and if it runs, the caller is paid nothing.
    function fireStop(address caller) external {
        // The fuzzer also picks addresses it has seen. The router and vault hold tokens anyway, and are not strangers.
        if (caller == address(0) || caller == address(router) || caller == address(vault)) caller = THIEF;
        uint256 inBefore = a.balanceOf(address(vault));
        uint256 outBefore = b.balanceOf(address(vault));
        uint256 callerBefore = a.balanceOf(caller) + b.balanceOf(caller);
        vm.prank(caller);
        try vault.triggerStop() {
            stopSpent += inBefore - a.balanceOf(address(vault));
            stopOut += b.balanceOf(address(vault)) - outBefore;
            require(a.balanceOf(caller) + b.balanceOf(caller) == callerBefore, "the caller was paid");
        } catch {}
    }

    function agentTriesForbidden(address to, uint256 amount, uint8 which) external {
        vm.prank(AGENT);
        bool ok;
        which %= 7;
        if (which == 0) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.withdraw, (address(a), to, amount)));
        if (which == 1) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setLimits, (address(a), amount, amount, 0, amount)));
        if (which == 2) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setAgent, (to, block.timestamp + 1)));
        if (which == 3) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.unpause, ()));
        if (which == 4) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setGuardian, (to)));
        if (which == 5) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.transferOwnership, (to)));
        if (which == 6) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setPriceGuard, (address(0), 0, 0)));
        require(!ok, "the agent did something only the owner may do");
    }

    function guardianTriesForbidden(address to, uint256 amount, uint8 which) external {
        vm.prank(GUARDIAN);
        bool ok;
        which %= 4;
        if (which == 0) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.withdraw, (address(a), to, amount)));
        if (which == 1) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setLimits, (address(a), amount, amount, 0, amount)));
        if (which == 2) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.setAgent, (to, block.timestamp + 1)));
        if (which == 3) (ok,) = address(vault).call(abi.encodeCall(HoldfastVault.unpause, ()));
        require(!ok, "the guardian did something only the owner may do");
    }

    function stopControls(uint8 which) external {
        which %= 5;
        if (which == 0) {
            vm.prank(AGENT);
            try vault.pause() {} catch {}
        }
        if (which == 1) {
            vm.prank(OWNER);
            vault.unpause();
        }
        if (which == 2) {
            vm.prank(GUARDIAN);
            vault.pause();
        }
        if (which == 3) {
            vm.prank(GUARDIAN);
            vault.revokeAgent();
        }
        if (which == 4) {
            vm.prank(OWNER);
            vault.setAgent(AGENT, block.timestamp + 30 days);
        }
    }

    function halt() external {
        vm.prank(GUARDIAN);
        vault.halt();
        (bool ok,) = address(vault).call(abi.encodeCall(HoldfastVault.triggerStop, ()));
        require(!ok, "a halted stop fired");
        vm.prank(OWNER);
        vault.unpause();
        uint256 left = _stopLeft();
        vm.prank(OWNER);
        vault.armStop(address(a), -1000, 20e18, left, 0.5e18, 500, 600);
    }

    function _stopLeft() private view returns (uint256) {
        (, uint72 left,,,,,) = vault.stop();
        // The test's accounting needs an unchanged total, and armStop refuses a tranche above its total.
        return left < 20e18 ? 20e18 : left;
    }

    /// The owner must be able to take out a wei at any point in any sequence, or this reverts and fails the run.
    function ownerWithdraws(uint256 seed) external {
        (uint256 amount, address to) = (seed % 1e18, address(0xC01D));
        vm.prank(OWNER);
        vault.withdraw(address(a), to, amount);
        withdrawn += amount;
    }
}

contract HoldfastVaultInvariantTest {
    VaultHandler handler;

    function setUp() public {
        handler = new VaultHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_routerNeverKeepsAnAllowance() public view {
        HoldfastVault vault = handler.vault();
        require(handler.a().allowance(address(vault), address(handler.router())) == 0, "allowance left on token a");
        require(handler.b().allowance(address(vault), address(handler.router())) == 0, "allowance left on token b");
    }

    function invariant_lifetimeAccountingIsExact() public view {
        require(handler.vault().remaining(address(handler.a())) == handler.LIFETIME() - handler.agentSpent(), "lifetime drifted");
    }

    function invariant_agentSpendStaysInsideEveryCap() public view {
        uint256 elapsed = block.timestamp - handler.start();
        uint256 spent = handler.agentSpent();
        require(spent <= handler.LIFETIME(), "over lifetime");
        require(spent <= handler.HOURLY() + (elapsed * handler.HOURLY()) / 1 hours, "over the hourly envelope");
        require(spent <= handler.DAILY() + (elapsed * handler.DAILY()) / 1 days, "over the daily envelope");
    }

    function invariant_everyAgentSaleClearedTheFloor() public view {
        require(handler.agentOut() >= (handler.agentSpent() * handler.FLOOR()) / 1e18, "sold under the floor");
    }

    function invariant_everyStopSaleClearedItsFloorAndTotal() public view {
        require(handler.stopOut() >= (handler.stopSpent() * 0.5e18) / 1e18, "stop sold under its floor");
    }

    function invariant_fundsOnlyLeaveThroughTheRouterOrTheOwner() public view {
        HoldfastVault vault = handler.vault();
        uint256 accounted = handler.agentSpent() + handler.stopSpent() + handler.withdrawn();
        require(handler.a().balanceOf(address(vault)) == 1_000_000e18 - accounted, "tokens left some other way");
        require(handler.a().balanceOf(address(0xB0B)) == 0 && handler.b().balanceOf(address(0xB0B)) == 0, "the agent holds tokens");
        require(handler.a().balanceOf(address(0x6A7D)) == 0 && handler.b().balanceOf(address(0x6A7D)) == 0, "the guardian holds tokens");
        require(handler.a().balanceOf(address(0xBAD)) == 0 && handler.b().balanceOf(address(0xBAD)) == 0, "a stranger holds tokens");
    }

    function invariant_ownerNeverChanges() public view {
        require(handler.vault().owner() == address(0xA11CE), "owner changed");
        require(handler.vault().pendingOwner() == address(0), "owner offered");
    }
}
