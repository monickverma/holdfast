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

/// @dev The part of a Uniswap V3 pool the price guard reads.
interface IPricePool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
}

/// @title HoldfastVault
/// @notice Holds a trading float for one V3 pool. An agent key can trade it only inside limits the owner set.
/// @dev The agent cannot choose the router, pool, tokens or recipient, and cannot withdraw. Input the agent can spend
///      is bounded per token by `remaining(token)` overall and by `hourlyBudget(token)` and optionally `dailyBudget(token)`
///      over time, and every sale must pay at least the owner's floor. With a price guard set, a trade must also leave
///      the pool within a band of its TWAP, so a price pushed in one block cannot be sold into. A stop the owner arms
///      can be fired by anyone once the TWAP crosses its trigger, so protection does not depend on the agent being up.
///      The key stops working at `agentExpiry`.
contract HoldfastVault {
    uint256 public constant MAX_INTENT_TTL = 120;
    /// @notice The longest the owner can trust one agent key before renewing it.
    uint256 public constant MAX_AGENT_TTL = 30 days;
    uint256 public constant VERSION = 3;
    /// @notice A TWAP shorter than this barely costs anything to move.
    uint32 public constant MIN_TWAP_WINDOW = 60;
    uint32 public constant MAX_TWAP_WINDOW = 1 days;
    uint32 public constant MIN_STOP_COOLDOWN = 60;
    uint256 private constant BUDGET_PERIOD = 1 hours;
    uint256 private constant DAILY_PERIOD = 1 days;

    address public immutable router;
    address public immutable tokenA;
    address public immutable tokenB;
    uint24 public immutable poolFee;

    address public owner;
    address public pendingOwner;
    /// @notice Can stop things and nothing else. Meant for a monitoring key that should never hold real power.
    address public guardian;

    // Everything an agent trade reads about who may act, in one slot it pays for anyway.
    address public agent;
    bool public paused;
    /// @notice The agent key stops working at this time.
    uint40 public agentExpiry;
    /// @notice Zero means no price guard. Reading it here adds no cold storage read to a trade with the guard off.
    uint32 public twapWindow;
    /// @notice How far past its TWAP, in ticks of about 1 bp, a trade may leave the pool.
    uint16 public guardBandTicks;

    address public pool;
    bool private tokenAIsToken0;

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
        /// @dev Zero means no daily cap, because the hourly budget of zero already means no trading.
        uint72 dailyBudget;
    }

    /// @dev Written only when a daily budget is set, so a vault without one pays nothing for it.
    struct DailyBucket {
        uint72 available;
        uint40 refilledAt;
    }

    struct Stop {
        uint72 tranche;
        uint72 remaining;
        uint40 nextAt;
        uint32 cooldown;
        int24 triggerTick;
        bool armed;
        bool sellsTokenA;
    }

    struct StopTerms {
        uint112 floorPriceX18;
        uint16 bandTicks;
    }

    mapping(address token => Limits) private limits;
    mapping(address token => Terms) private terms;
    mapping(address token => DailyBucket) private dailyBuckets;
    /// @dev Bitmap keyed by the top 248 bits of an intent ID. IDs sharing a word cost 5,000 gas to mark, not 22,100.
    mapping(uint256 word => uint256 bits) private usedIntentBits;

    Stop public stop;
    StopTerms public stopTerms;

    uint256 private transient lock;

    event Traded(
        bytes32 indexed intentId, address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 remainingAfter
    );
    event AgentSet(address indexed agent, uint256 expiry);
    event PausedSet(bool paused, address indexed by);
    event LimitsSet(
        address indexed token, uint256 maxTrade, uint256 remaining, uint256 floorPriceX18, uint256 hourlyBudget
    );
    event DailyBudgetSet(address indexed token, uint256 dailyBudget);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event GuardianSet(address indexed guardian);
    event OwnershipOffered(address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PriceGuardSet(address indexed pool, uint256 twapWindow, uint256 bandTicks);
    event StopArmed(
        address indexed token,
        int256 triggerTick,
        uint256 tranche,
        uint256 total,
        uint256 floorPriceX18,
        uint256 bandTicks,
        uint256 cooldown
    );
    event StopDisarmed(address indexed by);
    event StopFired(
        address indexed by, address indexed tokenIn, uint256 amountIn, uint256 amountOut, int256 twapTick, uint256 remainingAfter
    );

    error NotOwner();
    error NotAgent();
    error NotOwnerOrAgent();
    error NotOwnerOrGuardian();
    error NotPendingOwner();
    error IsPaused();
    error Reentered();
    error BadToken();
    error BadAmount();
    error BadDeadline();
    error IntentUsed();
    error OverTradeCap();
    error OverLifetimeCap();
    error OverHourlyBudget();
    error OverDailyBudget();
    error AgentExpired();
    error BadExpiry();
    error BelowFloor();
    error InsufficientOutput();
    error Overspent();
    error TokenCallFailed();
    error ZeroAddress();
    error LimitTooLarge();
    error RemainingChanged();
    error BadPriceGuard();
    error OracleUnavailable();
    error PriceOutOfBand();
    error NoPriceGuard();
    error BadStop();
    error StopNotArmed();
    error StopCoolingDown();
    error StopNotTriggered();

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
        // A typo here would otherwise only show up as a failed trade, after the float was deposited.
        if (router_.code.length == 0 || tokenA_.code.length == 0 || tokenB_.code.length == 0) revert BadToken();
        owner = owner_;
        _setAgent(agent_, agentExpiry_);
        router = router_;
        tokenA = tokenA_;
        tokenB = tokenB_;
        poolFee = poolFee_;
    }

    /// @notice Swap inside the owner's limits. Output always returns to this vault.
    /// @dev Bytes after the ABI-encoded arguments are ignored, so the agent appends a hash of its decision record there.
    function execute(address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline, bytes32 intentId)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        uint256 left = _admit(tokenIn, amountIn, minOut, deadline, intentId);

        uint256 spent;
        (spent, amountOut) = _swap(tokenIn, amountIn, minOut);

        uint32 window = twapWindow;
        if (window != 0) _requireInBand(tokenIn, _twapTick(window), guardBandTicks);

        // Limits were charged the full `amountIn`; the event reports what actually left, which a thin pool can make less.
        emit Traded(intentId, tokenIn, spent, amountOut, left - amountIn);
    }

    /// @notice Sell one tranche of the armed stop. Anyone may call it, once the pool's TWAP has crossed the trigger.
    /// @dev The caller picks nothing: token, size, floor and recipient are the owner's. A pause does not stop this,
    ///      because a stolen agent key can pause; `halt` and `disarmStop` do. It has its own allowance, so a thief
    ///      spending the agent's budget cannot use up the stop's.
    function triggerStop() external nonReentrant returns (uint256 amountOut) {
        Stop memory s = stop;
        if (!s.armed) revert StopNotArmed();
        if (block.timestamp < s.nextAt) revert StopCoolingDown();

        address tokenIn = s.sellsTokenA ? tokenA : tokenB;
        int24 twap = _twapTick(twapWindow);
        // Selling token0 protects against its price falling, which is the tick falling. Token1 is the mirror image.
        if (_sellsToken0(tokenIn) ? twap > s.triggerTick : twap < s.triggerTick) revert StopNotTriggered();

        uint256 balance = IERC20(tokenIn).balanceOf(address(this));
        uint256 amountIn = s.tranche;
        if (amountIn > s.remaining) amountIn = s.remaining;
        if (amountIn > balance) amountIn = balance;
        if (amountIn == 0) revert BadAmount();

        StopTerms memory t = stopTerms;
        // Fits: only shrinks a uint72, and a uint40 lasts until the year 36812.
        s.remaining -= uint72(amountIn);
        s.nextAt = uint40(block.timestamp + s.cooldown);
        stop = s;

        uint256 minOut = _floorOut(amountIn, t.floorPriceX18);
        (, amountOut) = _swap(tokenIn, amountIn, minOut);
        _requireInBand(tokenIn, twap, t.bandTicks);

        emit StopFired(msg.sender, tokenIn, amountIn, amountOut, twap, s.remaining);
    }

    /// @dev Trust balances, not the router's return value. Every path that moves funds out comes through here.
    function _swap(address tokenIn, uint256 amountIn, uint256 minOut) private returns (uint256 spent, uint256 amountOut) {
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

        spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        if (spent > amountIn) revert Overspent();
        // A full pull already consumed the exact allowance. Only a partial pull leaves one to clear.
        if (spent != amountIn) _approve(tokenIn, 0);
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < minOut) revert InsufficientOutput();
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
        if (term.dailyBudget != 0) _spendDaily(tokenIn, amountIn, term.dailyBudget);

        uint256 floorPrice = term.floorPriceX18;
        if (floorPrice == 0) revert BelowFloor();
        if (minOut < _floorOut(amountIn, floorPrice)) revert BelowFloor();

        // Fits: each only shrinks a value that was already a uint72, and a uint40 lasts until the year 36812.
        limits[tokenIn] =
            Limits(limit.maxTrade, uint72(left - amountIn), uint72(available - amountIn), uint40(block.timestamp));
    }

    function _spendDaily(address tokenIn, uint256 amountIn, uint256 budget) private {
        uint256 available = _dailyNow(dailyBuckets[tokenIn], budget);
        if (amountIn > available) revert OverDailyBudget();
        dailyBuckets[tokenIn] = DailyBucket(uint72(available - amountIn), uint40(block.timestamp));
    }

    /// @dev Rounds the floor up, so the bound cannot be shaved by truncation.
    function _floorOut(uint256 amountIn, uint256 floorPrice) private pure returns (uint256) {
        return (amountIn * floorPrice + 1e18 - 1) / 1e18;
    }

    /// @dev Refills at `hourlyBudget` per hour, up to `hourlyBudget`. Rounds down, so rounding never adds to the budget.
    function _availableNow(Limits memory limit, uint256 budget) private view returns (uint256) {
        uint256 refill = ((block.timestamp - limit.refilledAt) * budget) / BUDGET_PERIOD;
        uint256 available = limit.available + refill;
        return available < budget ? available : budget;
    }

    function _dailyNow(DailyBucket memory bucket, uint256 budget) private view returns (uint256) {
        uint256 refill = ((block.timestamp - bucket.refilledAt) * budget) / DAILY_PERIOD;
        uint256 available = bucket.available + refill;
        return available < budget ? available : budget;
    }

    /// @dev Whether selling this token pushes the pool's tick down.
    function _sellsToken0(address tokenIn) private view returns (bool) {
        return (tokenIn == tokenA) == tokenAIsToken0;
    }

    /// @dev A swap earlier in this block does not move this: the pool writes its observation with the tick before it.
    function _twapTick(uint32 window) private view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        try IPricePool(pool).observe(ago) returns (int56[] memory cumulative, uint160[] memory) {
            int56 delta = cumulative[1] - cumulative[0];
            int56 span = int56(uint56(window));
            int56 tick = delta / span;
            // Round towards negative infinity, as the V3 oracle library does.
            if (delta < 0 && delta % span != 0) tick--;
            return int24(tick);
        } catch {
            // Fail closed. An owner who needs out can still withdraw, which reads no price.
            revert OracleUnavailable();
        }
    }

    /// @dev One-sided: the trade may not leave the pool further than the band on the side it pushes. A fill's average
    ///      price lies between the price before and the price after, so a price this far from the TWAP bounds the fill.
    function _requireInBand(address tokenIn, int24 twap, uint256 band) private view {
        (, int24 spot,,,,,) = IPricePool(pool).slot0();
        int256 gap = int256(spot) - int256(twap);
        if (_sellsToken0(tokenIn) ? gap < -int256(band) : gap > int256(band)) revert PriceOutOfBand();
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

    /// @notice Input the agent may spend per day, per token. Zero means no daily cap.
    function dailyBudget(address token) external view returns (uint256) {
        return terms[token].dailyBudget;
    }

    /// @notice Input the agent may spend right now under the daily budget. With no daily cap, the most a uint72 holds.
    function dailyAvailable(address token) external view returns (uint256) {
        uint256 budget = terms[token].dailyBudget;
        return budget == 0 ? type(uint72).max : _dailyNow(dailyBuckets[token], budget);
    }

    function usedIntent(bytes32 intentId) external view returns (bool) {
        return usedIntentBits[uint256(intentId) >> 8] & (1 << (uint256(intentId) & 0xff)) != 0;
    }

    /// @notice The pool's tick and TWAP tick as the guard sees them. `ok` is false if the guard is off or the oracle fails.
    function priceGuardTicks() external view returns (bool ok, int24 spot, int24 twap) {
        uint32 window = twapWindow;
        if (window == 0) return (false, 0, 0);
        try this.readTwapTick(window) returns (int24 tick) {
            (, spot,,,,,) = IPricePool(pool).slot0();
            return (true, spot, tick);
        } catch {
            return (false, 0, 0);
        }
    }

    /// @dev External only so `priceGuardTicks` can catch its revert. Reads and changes nothing a caller could use.
    function readTwapTick(uint32 window) external view returns (int24) {
        return _twapTick(window);
    }

    /// @notice Whether `triggerStop` would pass its trigger and cooldown checks now. Keepers read this before paying gas.
    function stopReady() external view returns (bool) {
        Stop memory s = stop;
        if (!s.armed || block.timestamp < s.nextAt || s.remaining == 0) return false;
        try this.readTwapTick(twapWindow) returns (int24 twap) {
            address tokenIn = s.sellsTokenA ? tokenA : tokenB;
            return _sellsToken0(tokenIn) ? twap <= s.triggerTick : twap >= s.triggerTick;
        } catch {
            return false;
        }
    }

    /// @notice Stop agent trading. The agent may stop but never restart, and an expired key can no longer do even that.
    function pause() external {
        if (msg.sender != owner && msg.sender != guardian && (msg.sender != agent || block.timestamp >= agentExpiry)) {
            revert NotOwnerOrAgent();
        }
        paused = true;
        emit PausedSet(true, msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedSet(false, msg.sender);
    }

    /// @notice Stop everything that can move funds: agent trades and the stop. Only the owner can start them again.
    function halt() external {
        if (msg.sender != owner && msg.sender != guardian) revert NotOwnerOrGuardian();
        paused = true;
        stop.armed = false;
        emit PausedSet(true, msg.sender);
        emit StopDisarmed(msg.sender);
    }

    /// @notice End the agent key now, without naming a replacement. `setAgent` brings a key back.
    function revokeAgent() external {
        if (msg.sender != owner && msg.sender != guardian) revert NotOwnerOrGuardian();
        agentExpiry = uint40(block.timestamp);
        emit AgentSet(agent, block.timestamp);
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

    /// @notice Zero removes the guardian.
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Offer ownership. Nothing changes until the new address accepts, so a typo cannot lose the vault.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipOffered(newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Sets every limit for one token. A budget of zero means no trading.
    /// @dev What was spent in the last hour stays spent, so changing a limit never hands the agent a second budget.
    ///      `remaining_` is absolute: use `setLimitsIfRemaining`, or a trade can land between the read and this call.
    function setLimits(
        address token,
        uint256 maxTrade_,
        uint256 remaining_,
        uint256 floorPriceX18_,
        uint256 hourlyBudget_
    ) external onlyOwner {
        _setLimits(token, maxTrade_, remaining_, floorPriceX18_, hourlyBudget_);
    }

    /// @notice `setLimits`, refused if a trade has changed the lifetime allowance since the owner read it.
    function setLimitsIfRemaining(
        address token,
        uint256 maxTrade_,
        uint256 remaining_,
        uint256 floorPriceX18_,
        uint256 hourlyBudget_,
        uint256 expectedRemaining
    ) external onlyOwner {
        if (limits[token].remaining != expectedRemaining) revert RemainingChanged();
        _setLimits(token, maxTrade_, remaining_, floorPriceX18_, hourlyBudget_);
    }

    function _setLimits(
        address token,
        uint256 maxTrade_,
        uint256 remaining_,
        uint256 floorPriceX18_,
        uint256 hourlyBudget_
    ) private {
        if (token != tokenA && token != tokenB) revert BadToken();
        // Refuse rather than truncate: a silently smaller cap or floor would change what the owner approved.
        if (
            maxTrade_ > type(uint72).max || remaining_ > type(uint72).max || hourlyBudget_ > type(uint72).max
                || floorPriceX18_ > type(uint112).max
        ) {
            revert LimitTooLarge();
        }
        Terms memory term = terms[token];
        uint256 spent = term.hourlyBudget - _availableNow(limits[token], term.hourlyBudget);
        uint256 available = hourlyBudget_ > spent ? hourlyBudget_ - spent : 0;
        limits[token] = Limits(uint72(maxTrade_), uint72(remaining_), uint72(available), uint40(block.timestamp));
        terms[token] = Terms(uint112(floorPriceX18_), uint72(hourlyBudget_), term.dailyBudget);
        emit LimitsSet(token, maxTrade_, remaining_, floorPriceX18_, hourlyBudget_);
    }

    /// @notice Caps what the agent can spend per day, for an owner who wants a large hourly burst for stops but a
    ///         smaller total. Zero removes the cap. As with the hourly budget, what was spent stays spent.
    function setDailyBudget(address token, uint256 dailyBudget_) external onlyOwner {
        if (token != tokenA && token != tokenB) revert BadToken();
        if (dailyBudget_ > type(uint72).max) revert LimitTooLarge();
        Terms memory term = terms[token];
        uint256 spent = term.dailyBudget == 0 ? 0 : term.dailyBudget - _dailyNow(dailyBuckets[token], term.dailyBudget);
        uint256 available = dailyBudget_ > spent ? dailyBudget_ - spent : 0;
        dailyBuckets[token] = DailyBucket(uint72(available), uint40(block.timestamp));
        terms[token].dailyBudget = uint72(dailyBudget_);
        emit DailyBudgetSet(token, dailyBudget_);
    }

    /// @notice Require every trade to leave the pool within `bandTicks` of its TWAP. A window of zero turns the guard off,
    ///         and disarms the stop, which cannot run without a price.
    /// @dev The floor stays in force either way: this narrows the loss on a pushed pool, and the floor is the backstop
    ///      if someone holds the price down for the whole window. Checks the oracle can answer now, so a window longer
    ///      than the pool's observation history fails here and not on the first trade.
    function setPriceGuard(address pool_, uint32 window_, uint16 bandTicks_) external onlyOwner {
        if (window_ == 0) {
            twapWindow = 0;
            guardBandTicks = 0;
            pool = address(0);
            stop.armed = false;
            emit PriceGuardSet(address(0), 0, 0);
            return;
        }
        if (window_ < MIN_TWAP_WINDOW || window_ > MAX_TWAP_WINDOW || bandTicks_ == 0) revert BadPriceGuard();
        if (pool_.code.length == 0) revert BadPriceGuard();
        address token0 = IPricePool(pool_).token0();
        address token1 = IPricePool(pool_).token1();
        if (
            !((token0 == tokenA && token1 == tokenB) || (token0 == tokenB && token1 == tokenA))
                || IPricePool(pool_).fee() != poolFee
        ) {
            revert BadPriceGuard();
        }
        pool = pool_;
        tokenAIsToken0 = token0 == tokenA;
        twapWindow = window_;
        guardBandTicks = bandTicks_;
        _twapTick(window_);
        emit PriceGuardSet(pool_, window_, bandTicks_);
    }

    /// @notice Arm a stop anyone can fire: once the TWAP crosses `triggerTick`, sell up to `tranche` of `token` every
    ///         `cooldown` seconds, up to `total`, at no less than `floorPriceX18_`, leaving the pool within `bandTicks_`.
    /// @dev `floorPriceX18_` may be under the agent's floor, which is the point: it is what lets a stop sell in a crash
    ///      that the agent's floor would block. The worst this costs is `total` at that floor, set here by the owner.
    function armStop(
        address token,
        int24 triggerTick,
        uint256 tranche,
        uint256 total,
        uint256 floorPriceX18_,
        uint16 bandTicks_,
        uint32 cooldown
    ) external onlyOwner {
        if (token != tokenA && token != tokenB) revert BadToken();
        if (twapWindow == 0) revert NoPriceGuard();
        if (
            tranche == 0 || tranche > total || total > type(uint72).max || floorPriceX18_ == 0
                || floorPriceX18_ > type(uint112).max || bandTicks_ == 0 || cooldown < MIN_STOP_COOLDOWN
        ) {
            revert BadStop();
        }
        stop = Stop(uint72(tranche), uint72(total), 0, cooldown, triggerTick, true, token == tokenA);
        stopTerms = StopTerms(uint112(floorPriceX18_), bandTicks_);
        emit StopArmed(token, triggerTick, tranche, total, floorPriceX18_, bandTicks_, cooldown);
    }

    function disarmStop() external {
        if (msg.sender != owner && msg.sender != guardian) revert NotOwnerOrGuardian();
        stop.armed = false;
        emit StopDisarmed(msg.sender);
    }

    /// @notice Reads no price, no limit and no agent state, so nothing the agent or a pool does can block it.
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
