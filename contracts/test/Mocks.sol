// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISwapRouter02} from "../HoldfastVault.sol";

interface Vm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function roll(uint256 blockNumber) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    function assume(bool condition) external;
    function deal(address who, uint256 balance) external;
    function envOr(string calldata name, bool defaultValue) external returns (bool);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
}

/// An ERC-20 whose return value and fees can be made hostile.
contract FlexToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public transfersFail;
    bool public returnsFalse;
    uint256 public feeBps;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setHostile(bool fail, bool false_, uint256 feeBps_) external {
        transfersFail = fail;
        returnsFalse = false_;
        feeBps = feeBps_;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        require(!transfersFail, "transfer blocked");
        if (returnsFalse) return false;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - (amount * feeBps) / 10_000;
        return true;
    }
}

/// A pool with a tick and TWAP the test controls. `observe` is shaped like V3's: cumulative tick over the window.
contract MockPool {
    address public token0;
    address public token1;
    uint24 public fee = 3000;
    int24 public tick;
    int24 public twap;
    bool public oracleFails;
    /// Added to the cumulative tick, to make a TWAP that is not a whole number of ticks.
    int56 public cumulativeOffset;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    function setPrice(int24 tick_, int24 twap_) external {
        tick = tick_;
        twap = twap_;
    }

    function setOracleFails(bool fails) external {
        oracleFails = fails;
    }

    function setCumulativeOffset(int56 offset) external {
        cumulativeOffset = offset;
    }

    function setFee(uint24 fee_) external {
        fee = fee_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, tick, 0, 1, 1, 0, true);
    }

    function observe(uint32[] calldata ago) external view returns (int56[] memory cumulative, uint160[] memory perLiquidity) {
        require(!oracleFails, "OLD");
        cumulative = new int56[](2);
        perLiquidity = new uint160[](2);
        cumulative[1] = int56(twap) * int56(uint56(ago[0])) + cumulativeOffset;
    }
}

/// Pays at a set rate, and moves the mock pool's tick by a set amount, as a real swap's price impact would.
contract ImpactRouter {
    MockPool public pool;
    uint256 public rateX18 = 1e18;
    int24 public impactTicks;

    function setPool(MockPool pool_) external {
        pool = pool_;
    }

    function setRate(uint256 rateX18_) external {
        rateX18 = rateX18_;
    }

    function setImpact(int24 impact) external {
        impactTicks = impact;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external payable returns (uint256) {
        require(FlexToken(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn), "pull");
        uint256 out = (p.amountIn * rateX18) / 1e18;
        if (address(pool) != address(0)) {
            bool down = p.tokenIn == pool.token0();
            pool.setPrice(pool.tick() + (down ? -impactTicks : impactTicks), pool.twap());
        }
        require(FlexToken(p.tokenOut).transfer(p.recipient, out), "pay");
        require(out >= p.amountOutMinimum, "slippage");
        return out;
    }
}
