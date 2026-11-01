// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title HoldfastVaultV1, the vault as first deployed. Kept only as the gas baseline for bench:gas.
/// @notice Holds a trading float for one V3 pool. An agent key can trade it only inside limits the owner set.
/// @dev The agent cannot choose the router, pool, tokens or recipient, and cannot withdraw. Principal lost through
///      the agent is bounded per token by `remaining[token]`, whatever the agent's key or model is told to do.
contract HoldfastVaultV1 {
    uint256 public constant MAX_INTENT_TTL = 120;

    address public immutable owner;
    address public immutable router;
    address public immutable tokenA;
    address public immutable tokenB;
    uint24 public immutable poolFee;

    address public agent;
    bool public paused;

    /// @notice Largest input for one trade, per input token.
    mapping(address token => uint256) public maxTrade;
    /// @notice Input the agent may still spend, per token. Only the owner can raise it; nothing renews it.
    mapping(address token => uint256) public remaining;
    /// @notice Minimum output per 1e18 base units of input, per input token. Set only by the owner.
    mapping(address token => uint256) public floorPriceX18;
    mapping(bytes32 intentId => bool) public usedIntent;

    uint256 private lock = 1;

    event Traded(
        bytes32 indexed intentId, address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 remainingAfter
    );
    event AgentSet(address indexed agent);
    event PausedSet(bool paused, address indexed by);
    event LimitsSet(address indexed token, uint256 maxTrade, uint256 remaining, uint256 floorPriceX18);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotAgent();
    error NotOwnerOrAgent();
    error IsPaused();
    error Reentered();
    error BadToken();
    error BadAmount();
    error BadDeadline();
    error IntentUsed();
    error OverTradeCap();
    error OverLifetimeCap();
    error BelowFloor();
    error InsufficientOutput();
    error Overspent();
    error TokenCallFailed();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (lock != 1) revert Reentered();
        lock = 2;
        _;
        lock = 1;
    }

    constructor(address owner_, address agent_, address router_, address tokenA_, address tokenB_, uint24 poolFee_) {
        if (owner_ == address(0) || agent_ == address(0) || router_ == address(0)) revert ZeroAddress();
        if (tokenA_ == address(0) || tokenB_ == address(0) || tokenA_ == tokenB_) revert BadToken();
        owner = owner_;
        agent = agent_;
        router = router_;
        tokenA = tokenA_;
        tokenB = tokenB_;
        poolFee = poolFee_;
        emit AgentSet(agent_);
    }

    /// @notice Swap inside the owner's limits. Output always returns to this vault.
    function execute(address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline, bytes32 intentId)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        if (tokenIn != tokenA && tokenIn != tokenB) revert BadToken();
        if (amountIn == 0) revert BadAmount();
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_INTENT_TTL) revert BadDeadline();
        if (usedIntent[intentId]) revert IntentUsed();
        if (amountIn > maxTrade[tokenIn]) revert OverTradeCap();
        uint256 left = remaining[tokenIn];
        if (amountIn > left) revert OverLifetimeCap();

        // Round the floor up so the bound cannot be shaved by truncation.
        uint256 floorPrice = floorPriceX18[tokenIn];
        if (floorPrice == 0) revert BelowFloor();
        uint256 floorOut = (amountIn * floorPrice + 1e18 - 1) / 1e18;
        if (minOut < floorOut) revert BelowFloor();

        usedIntent[intentId] = true;
        remaining[tokenIn] = left - amountIn;

        address tokenOut = tokenIn == tokenA ? tokenB : tokenA;
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));

        _approve(tokenIn, amountIn);
        ISwapRouter02(router).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        _approve(tokenIn, 0);

        // Trust balances, not the router's return value.
        if (inBefore - IERC20(tokenIn).balanceOf(address(this)) > amountIn) revert Overspent();
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < minOut) revert InsufficientOutput();

        emit Traded(intentId, tokenIn, amountIn, amountOut, left - amountIn);
    }

    /// @notice Stop trading. The agent may stop but never restart.
    function pause() external {
        if (msg.sender != owner && msg.sender != agent) revert NotOwnerOrAgent();
        paused = true;
        emit PausedSet(true, msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedSet(false, msg.sender);
    }

    function setAgent(address agent_) external onlyOwner {
        if (agent_ == address(0)) revert ZeroAddress();
        agent = agent_;
        emit AgentSet(agent_);
    }

    function setLimits(address token, uint256 maxTrade_, uint256 remaining_, uint256 floorPriceX18_)
        external
        onlyOwner
    {
        if (token != tokenA && token != tokenB) revert BadToken();
        maxTrade[token] = maxTrade_;
        remaining[token] = remaining_;
        floorPriceX18[token] = floorPriceX18_;
        emit LimitsSet(token, maxTrade_, remaining_, floorPriceX18_);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _call(token, abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        emit Withdrawn(token, to, amount);
    }

    function _approve(address token, uint256 amount) private {
        _call(token, abi.encodeWithSignature("approve(address,uint256)", router, amount));
    }

    /// @dev Accepts tokens that return nothing, such as some USDT deployments.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TokenCallFailed();
    }
}
