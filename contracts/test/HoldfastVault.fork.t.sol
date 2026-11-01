// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HoldfastVault} from "../HoldfastVault.sol";

interface Vm {
    function prank(address sender) external;
    function deal(address who, uint256 balance) external;
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function envOr(string calldata name, bool defaultValue) external returns (bool);
    function expectRevert() external;
}

interface IWhsk {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// Runs real swaps against the real HSKSwap router on a local fork. Nothing is broadcast.
/// Enable with FORK_TESTS=true, since it depends on the public RPC.
contract HoldfastVaultForkTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant ROUTER = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3;
    address constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xB0B);

    function test_fork_roundTripThroughRealRouter() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork("hsk");

        HoldfastVault vault = new HoldfastVault(OWNER, AGENT, ROUTER, WHSK, USDT, 3000);
        vm.deal(address(this), 200e18);
        IWhsk(WHSK).deposit{value: 100e18}();
        IWhsk(WHSK).transfer(address(vault), 100e18);

        // Floors are deliberately loose here; the test proves routing and accounting, not pricing.
        vm.prank(OWNER);
        vault.setLimits(WHSK, 100e18, 100e18, 0.01e6);
        vm.prank(OWNER);
        vault.setLimits(USDT, 100e6, 100e6, 1e30);

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

    receive() external payable {}
}
