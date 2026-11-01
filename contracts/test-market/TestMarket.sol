// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Freely minted test assets. No native backing and no economic value.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    constructor(string memory n, string memory s, uint8 d) { name=n; symbol=s; decimals=d; }
    function mint(address to, uint256 amount) external { balanceOf[to]+=amount; totalSupply+=amount; emit Transfer(address(0),to,amount); }
    function approve(address spender,uint256 amount) external returns(bool) { allowance[msg.sender][spender]=amount; emit Approval(msg.sender,spender,amount); return true; }
    function transfer(address to,uint256 amount) external returns(bool) { _transfer(msg.sender,to,amount); return true; }
    function transferFrom(address from,address to,uint256 amount) external returns(bool) { allowance[from][msg.sender]-=amount; _transfer(from,to,amount); return true; }
    function _transfer(address from,address to,uint256 amount) internal { balanceOf[from]-=amount; balanceOf[to]+=amount; emit Transfer(from,to,amount); }
}

/// TEST MARKET, NOT Uniswap V3. Constant product, 0.3% fee, fixed semantic order:
/// token0 is test WHSK (18 decimals), token1 is test USDT (6), regardless of addresses.
/// observe keeps a real history, shaped like V3's, so a price guard or a stop on this market meets a price that takes
/// time to move. Before the seed, the seed's own price counts as having always held.
contract TestPool {
    TestToken public immutable token0;
    TestToken public immutable token1;
    uint24 public constant fee = 3000;
    uint256 public reserve0;
    uint256 public reserve1;
    struct Observation { uint32 time; int56 cumulative; }
    Observation[] private observations;
    /// Worked out once per swap, because the search costs far more than the read.
    int24 private tick;
    constructor(TestToken a,TestToken b) { token0=a; token1=b; }
    function seed(uint256 a,uint256 b) external {
        require(reserve0==0 && a>0 && b>0 && a<=type(uint128).max && b<=type(uint128).max,"seed");
        token0.transferFrom(msg.sender,address(this),a); token1.transferFrom(msg.sender,address(this),b);
        reserve0=a; reserve1=b;
        tick=currentTick();
        observations.push(Observation(uint32(block.timestamp),0));
    }
    function quote(address input,uint256 amount) public view returns(uint256) {
        require(input==address(token0)||input==address(token1),"token");
        (uint256 x,uint256 y)=input==address(token0)?(reserve0,reserve1):(reserve1,reserve0);
        require(x>0 && amount>0,"empty");
        uint256 net=amount*997;
        return net*y/(x*1000+net);
    }
    // Anyone may swap, but must pay their own input. Router first takes custody.
    function swap(address input,uint256 amount,address recipient,uint256 minimum) external returns(uint256 out) {
        out=quote(input,amount); require(out>=minimum && out>0,"slippage");
        require((input==address(token0)?reserve0:reserve1)+amount<=type(uint128).max,"reserve limit");
        _observe();
        TestToken(input).transferFrom(msg.sender,address(this),amount);
        if(input==address(token0)) { reserve0+=amount; reserve1-=out; token1.transfer(recipient,out); }
        else { reserve1+=amount; reserve0-=out; token0.transfer(recipient,out); }
        tick=currentTick();
    }
    /// The price that held until now goes into the history, before this swap changes it.
    function _observe() private {
        Observation storage last=observations[observations.length-1];
        uint32 time=uint32(block.timestamp);
        if(last.time==time) return;
        observations.push(Observation(time,last.cumulative+int56(tick)*int56(uint56(time-last.time))));
    }
    function sqrt(uint256 x) internal pure returns(uint256 y) {
        if(x==0) return 0; y=x; uint256 z=(x+1)/2;
        while(z<y) { y=z; z=(x/z+z)/2; }
    }
    function liquidity() external view returns(uint128) { return uint128(sqrt(reserve0*reserve1)); }
    function priceAt(int24 t) internal pure returns(uint256) {
        uint256 n=uint256(int256(t<0?-t:t));
        uint256 scale=1<<128;
        uint256 p=scale;
        uint256 b=scale*10000/10001;
        // Negative powers stay below Q128, so each multiplication fits uint256.
        while(n>0) { if(n&1!=0) p=p*b/scale; n>>=1; if(n>0) b=b*b/scale; }
        return t<=0?p:type(uint256).max/p;
    }
    function currentTick() public view returns(int24) {
        uint256 ratio=(reserve1<<128)/reserve0;
        int24 low=-887272; int24 high=887272;
        while(low<high) { int24 mid=low+(high-low+1)/2; if(priceAt(mid)<=ratio) low=mid; else high=mid-1; }
        return low;
    }
    function _sqrtPrice(uint256 r0,uint256 r1) private pure returns(uint160) {
        // Q128 ratio -> Q64 square root -> Q96. Avoid decimal scaling assumptions.
        return uint160(sqrt((r1<<128)/r0)<<32);
    }
    function slot0() external view returns(uint160,int24,uint16,uint16,uint16,uint8,bool) {
        return(_sqrtPrice(reserve0,reserve1),tick,0,1,1,0,true);
    }
    /// The price this swap would leave behind.
    function sqrtPriceAfter(address input,uint256 amount) external view returns(uint160) {
        uint256 out=quote(input,amount);
        return input==address(token0)?_sqrtPrice(reserve0+amount,reserve1-out):_sqrtPrice(reserve0-out,reserve1+amount);
    }
    function observe(uint32[] calldata ago) external view returns(int56[] memory ticks,uint160[] memory secondsPerLiquidity) {
        ticks=new int56[](ago.length); secondsPerLiquidity=new uint160[](ago.length);
        for(uint256 i; i<ago.length;i++) ticks[i]=_cumulativeAt(uint32(block.timestamp)-ago[i]);
    }
    function _cumulativeAt(uint32 time) private view returns(int56) {
        uint256 n=observations.length;
        Observation memory first=observations[0];
        Observation memory last=observations[n-1];
        if(time>=last.time) return last.cumulative+int56(tick)*int56(uint56(time-last.time));
        // Between two swaps the price did not move, so each stretch is one tick, the one the later entry recorded.
        if(time<first.time) return first.cumulative-int56(_seedTick())*int56(uint56(first.time-time));
        uint256 low=0; uint256 high=n-1;
        while(low+1<high) { uint256 mid=(low+high)/2; if(observations[mid].time<=time) low=mid; else high=mid; }
        Observation memory a=observations[low]; Observation memory b=observations[high];
        return a.cumulative+(b.cumulative-a.cumulative)*int56(uint56(time-a.time))/int56(uint56(b.time-a.time));
    }
    /// The first stretch of history, or today's tick if nothing has traded since the seed.
    function _seedTick() private view returns(int24) {
        if(observations.length<2) return tick;
        Observation memory a=observations[0]; Observation memory b=observations[1];
        return int24((b.cumulative-a.cumulative)/int56(uint56(b.time-a.time)));
    }
}
contract TestRouter {
    TestPool public immutable pool;
    constructor(TestPool p) {pool=p;}
    struct ExactInputSingleParams {address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;}
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns(uint256) {
        require(msg.value==0 && p.fee==3000 && p.sqrtPriceLimitX96==0,"params");
        require((p.tokenIn==address(pool.token0()) && p.tokenOut==address(pool.token1())) || (p.tokenIn==address(pool.token1()) && p.tokenOut==address(pool.token0())),"pair");
        TestToken(p.tokenIn).transferFrom(msg.sender,address(this),p.amountIn);
        TestToken(p.tokenIn).approve(address(pool),p.amountIn);
        return pool.swap(p.tokenIn,p.amountIn,p.recipient,p.amountOutMinimum);
    }
}
contract TestQuoter {
    TestPool public immutable pool;
    constructor(TestPool p) {pool=p;}
    struct QuoteParams {address tokenIn;address tokenOut;uint256 amountIn;uint24 fee;uint160 sqrtPriceLimitX96;}
    function quoteExactInputSingle(QuoteParams calldata p) external view returns(uint256,uint160,uint32,uint256) {
        require(p.fee==3000 && p.sqrtPriceLimitX96==0,"params");
        require((p.tokenIn==address(pool.token0()) && p.tokenOut==address(pool.token1())) || (p.tokenIn==address(pool.token1()) && p.tokenOut==address(pool.token0())),"pair");
        return(pool.quote(p.tokenIn,p.amountIn),pool.sqrtPriceAfter(p.tokenIn,p.amountIn),0,200000);
    }
}
