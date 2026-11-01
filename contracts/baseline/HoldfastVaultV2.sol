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

/// @title HoldfastVaultV2 (baseline for gas comparison; do not deploy)
/// @notice Holds a trading float for one V3 pool. An agent key can trade it only inside limits the owner set.
/// @dev The agent cannot choose the router, pool, tokens or recipient, and cannot withdraw. Input the agent can spend
///      is bounded per token by `remaining(token)` overall and by `hourlyBudget(token)` over time, and every sale must
///      pay at least the owner's floor. So value lost is at most the input spent times the market price minus the floor,
///      whatever the agent's key or model is told to do. The key stops working at `agentExpiry`.
contract HoldfastVaultV2 {
    uint256 public constant MAX_INTENT_TTL = 120;
    /// @notice The longest the owner can trust one agent key before renewing it.
    uint256 public constant MAX_AGENT_TTL = 30 days;
    uint256 private constant BUDGET_PERIOD = 1 hours;

    address public immutable owner;
    address public immutable router;
    address public immutable tokenA;
    address public immutable tokenB;
    uint24 public immutable poolFee;

    address public agent;
    bool public paused;
    /// @notice The agent key stops working at this time. Shares a slot with `agent`, which every trade reads anyway.
    uint40 public agentExpiry;

    /// @dev Everything a trade writes, in one slot. `available` is a token bucket, as it stood at `refilledAt`.
    struct Limits {
        uint72 maxTrade;
        uint72 remaining;
        uint72 available;
        uint40 refilledAt;
    }

    /// @dev Everything a trade only reads, in a second slot, so a trade pays for one extra cold read and no extra write.
    struct Terms {
        uint112 floorPriceX18;
        uint72 hourlyBudget;
    }

    mapping(address token => Limits) private limits;
    mapping(address token => Terms) private terms;
    /// @dev Bitmap keyed by the top 248 bits of an intent ID. IDs sharing a word cost 5,000 gas to mark, not 22,100.
    mapping(uint256 word => uint256 bits) private usedIntentBits;

    uint256 private transient lock;

    event Traded(
        bytes32 indexed intentId, address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 remainingAfter
    );
    event AgentSet(address indexed agent, uint256 expiry);
    event PausedSet(bool paused, address indexed by);
    event LimitsSet(
        address indexed token, uint256 maxTrade, uint256 remaining, uint256 floorPriceX18, uint256 hourlyBudget
    );
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
    error OverHourlyBudget();
    error AgentExpired();
    error BadExpiry();
    error BelowFloor();
    error InsufficientOutput();
    error Overspent();
    error TokenCallFailed();
    error ZeroAddress();
    error LimitTooLarge();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (lock != 0) revert Reentered();
        lock = 1;
        _;
        lock = 0;
    }

    constructor(
        address owner_,
        address agent_,
        uint256 agentExpiry_,
        address router_,
        address tokenA_,
        address tokenB_,
        uint24 poolFee_
    ) {
        if (owner_ == address(0) || agent_ == address(0) || router_ == address(0)) revert ZeroAddress();
        if (tokenA_ == address(0) || tokenB_ == address(0) || tokenA_ == tokenB_) revert BadToken();
        owner = owner_;
        _setAgent(agent_, agentExpiry_);
        router = router_;
        tokenA = tokenA_;
        tokenB = tokenB_;
        poolFee = poolFee_;
    }

    /// @notice Swap inside the owner's limits. Output always returns to this vault.
    function execute(address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline, bytes32 intentId)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        uint256 left = _admit(tokenIn, amountIn, minOut, deadline, intentId);

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

        // Trust balances, not the router's return value.
        uint256 spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        if (spent > amountIn) revert Overspent();
        // A full pull already consumed the exact allowance. Only a partial pull leaves one to clear.
        if (spent != amountIn) _approve(tokenIn, 0);
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < minOut) revert InsufficientOutput();

        emit Traded(intentId, tokenIn, amountIn, amountOut, left - amountIn);
    }

    /// @dev Every limit check, then the state change that spends against it, all before any external call.
    function _admit(address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline, bytes32 intentId)
        private
        returns (uint256 left)
    {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        if (block.timestamp >= agentExpiry) revert AgentExpired();
        if (tokenIn != tokenA && tokenIn != tokenB) revert BadToken();
        if (amountIn == 0) revert BadAmount();
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_INTENT_TTL) revert BadDeadline();
        uint256 word = uint256(intentId) >> 8;
        uint256 bit = 1 << (uint256(intentId) & 0xff);
        uint256 usedBits = usedIntentBits[word];
        if (usedBits & bit != 0) revert IntentUsed();
        left = _spend(tokenIn, amountIn, minOut);
        usedIntentBits[word] = usedBits | bit;
    }

    /// @dev Checks the token's limits and spends against them.
    function _spend(address tokenIn, uint256 amountIn, uint256 minOut) private returns (uint256 left) {
        Limits memory limit = limits[tokenIn];
        if (amountIn > limit.maxTrade) revert OverTradeCap();
        left = limit.remaining;
        if (amountIn > left) revert OverLifetimeCap();

        Terms memory term = terms[tokenIn];
        uint256 available = _availableNow(limit, term.hourlyBudget);
        if (amountIn > available) revert OverHourlyBudget();

        // Round the floor up so the bound cannot be shaved by truncation.
        uint256 floorPrice = term.floorPriceX18;
        if (floorPrice == 0) revert BelowFloor();
        uint256 floorOut = (amountIn * floorPrice + 1e18 - 1) / 1e18;
        if (minOut < floorOut) revert BelowFloor();

        // Fits: each only shrinks a value that was already a uint72, and a uint40 lasts until the year 36812.
        limits[tokenIn] =
            Limits(limit.maxTrade, uint72(left - amountIn), uint72(available - amountIn), uint40(block.timestamp));
    }

    /// @dev Refills at `hourlyBudget` per hour, up to `hourlyBudget`. Rounds down, so rounding never adds to the budget.
    function _availableNow(Limits memory limit, uint256 budget) private view returns (uint256) {
        uint256 refill = ((block.timestamp - limit.refilledAt) * budget) / BUDGET_PERIOD;
        uint256 available = limit.available + refill;
        return available < budget ? available : budget;
    }

    /// @notice Largest input for one trade, per input token.
    function maxTrade(address token) external view returns (uint256) {
        return limits[token].maxTrade;
    }

    /// @notice Input the agent may still spend, per token. Only the owner can raise it; nothing renews it.
    function remaining(address token) external view returns (uint256) {
        return limits[token].remaining;
    }

    /// @notice Minimum output per 1e18 base units of input, per input token. Set only by the owner.
    function floorPriceX18(address token) external view returns (uint256) {
        return terms[token].floorPriceX18;
    }

    /// @notice Input the agent may spend per hour, per token. Also the most it can spend in one moment.
    function hourlyBudget(address token) external view returns (uint256) {
        return terms[token].hourlyBudget;
    }

    /// @notice Input the agent may spend right now under the hourly budget, per token.
    function budgetAvailable(address token) external view returns (uint256) {
        return _availableNow(limits[token], terms[token].hourlyBudget);
    }

    function usedIntent(bytes32 intentId) external view returns (bool) {
        return usedIntentBits[uint256(intentId) >> 8] & (1 << (uint256(intentId) & 0xff)) != 0;
    }

    /// @notice Stop trading. The agent may stop but never restart, and an expired key can no longer do even that.
    function pause() external {
        if (msg.sender != owner && (msg.sender != agent || block.timestamp >= agentExpiry)) revert NotOwnerOrAgent();
        paused = true;
        emit PausedSet(true, msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedSet(false, msg.sender);
    }

    /// @notice Replace the agent key, or renew the current one. A renewal is when the owner should recheck the floor.
    function setAgent(address agent_, uint256 expiry_) external onlyOwner {
        if (agent_ == address(0)) revert ZeroAddress();
        _setAgent(agent_, expiry_);
    }

    function _setAgent(address agent_, uint256 expiry_) private {
        if (expiry_ <= block.timestamp || expiry_ > block.timestamp + MAX_AGENT_TTL) revert BadExpiry();
        agent = agent_;
        agentExpiry = uint40(expiry_);
        emit AgentSet(agent_, expiry_);
    }

    /// @notice Sets every limit for one token. A budget of zero means no trading.
    /// @dev What was spent in the last hour stays spent, so changing a limit never hands the agent a second budget.
    ///      `remaining_` is absolute: read it after pausing, or a trade can land between the read and this call.
    function setLimits(
        address token,
        uint256 maxTrade_,
        uint256 remaining_,
        uint256 floorPriceX18_,
        uint256 hourlyBudget_
    ) external onlyOwner {
        if (token != tokenA && token != tokenB) revert BadToken();
        // Refuse rather than truncate: a silently smaller cap or floor would change what the owner approved.
        if (
            maxTrade_ > type(uint72).max || remaining_ > type(uint72).max || hourlyBudget_ > type(uint72).max
                || floorPriceX18_ > type(uint112).max
        ) {
            revert LimitTooLarge();
        }
        uint256 oldBudget = terms[token].hourlyBudget;
        uint256 spent = oldBudget - _availableNow(limits[token], oldBudget);
        uint256 available = hourlyBudget_ > spent ? hourlyBudget_ - spent : 0;
        limits[token] = Limits(uint72(maxTrade_), uint72(remaining_), uint72(available), uint40(block.timestamp));
        terms[token] = Terms(uint112(floorPriceX18_), uint72(hourlyBudget_));
        emit LimitsSet(token, maxTrade_, remaining_, floorPriceX18_, hourlyBudget_);
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
