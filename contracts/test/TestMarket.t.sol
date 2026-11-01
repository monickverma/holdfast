// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "../test-market/TestMarket.sol";
contract TestMarketTest {
 TestToken a; TestToken b; TestPool p; TestRouter r; TestQuoter q;
 function setUp() public {
  a=new TestToken("Test WHSK","tWHSK",18); b=new TestToken("Test USDT","tUSDT",6);
  p=new TestPool(a,b); r=new TestRouter(p); q=new TestQuoter(p);
  a.mint(address(this),2000e18); b.mint(address(this),200e6);
  a.approve(address(p),1000e18); b.approve(address(p),100e6); p.seed(1000e18,100e6);
 }
 function testPriceAndObserve() public view {
  (uint160 s,int24 t,,,,,)=p.slot0();
  uint256 price=uint256(s)*s*1e18>>192; require(price>=99999 && price<=100000,"spot");
  uint32[] memory ago=new uint32[](2); ago[0]=300;
  (int56[] memory c,)=p.observe(ago); require(c[1]-c[0]==int56(t)*300,"tick");
  require(t < -299000 && t > -300000,"tick price"); require(p.liquidity()>0,"liquidity");
 }
 function testBothDirectionsAndFee() public {
  uint256 beforeK=p.reserve0()*p.reserve1();
  (uint256 quoted,,,)=q.quoteExactInputSingle(TestQuoter.QuoteParams(address(a),address(b),1e18,3000,0));
  require(quoted==uint256(997)*1e18*100e6/(1000e18*1000+997*1e18),"fee");
  a.approve(address(r),1e18);
  uint256 out=r.exactInputSingle(TestRouter.ExactInputSingleParams(address(a),address(b),3000,address(this),1e18,quoted,0));
  require(out==quoted && p.reserve0()*p.reserve1()>=beforeK,"sell");
  b.approve(address(r),out);
  uint256 back=r.exactInputSingle(TestRouter.ExactInputSingleParams(address(b),address(a),3000,address(this),out,1,0));
  require(back<1e18 && back>0,"buy");
 }
 function testSlippageReverts() public {
  a.approve(address(r),1e18);
  (bool success,)=address(r).call(abi.encodeCall(r.exactInputSingle,(TestRouter.ExactInputSingleParams(address(a),address(b),3000,address(this),1e18,1e6,0))));
  require(!success,"slippage accepted"); require(p.reserve0()==1000e18,"atomic");
 }
}

