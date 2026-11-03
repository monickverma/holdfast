// Public quotes only: no wallet file, signing or transaction submission.
import { writeFileSync, existsSync } from 'node:fs';
import { encodeFunctionData, decodeFunctionResult, parseAbi, formatUnits } from 'viem';
import { RpcClient } from '../.test-build/src/rpc.js';
import { MAINNET_MARKET } from '../.test-build/src/config.js';
import { multicall, quoteSub, sub } from '../.test-build/src/arb-read.js';
const file = 'evidence/progress/tiny-trade-quote-2026-11-03.json';
if (existsSync(file)) throw new Error('output exists');
const vault = '0xbbd6f3df289a2fde6b5dd8edea19b827e0d07d3c';
const owner = '0x1137FA10a0aE7e5Ac228d1B3b86CAc02b92Ef489';
const agent = '0x6ddB61023935F3E05F4fb94551eA18e0f04d2FcA';
const amount = 100000000000000n; // 0.0001 HSK, wrapped before trading
const abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function maxTrade(address) view returns (uint256)']);
const rpc = new RpcClient('https://mainnet.hsk.xyz', { timeoutMs: 20000 });
try {
  if (BigInt(await rpc.call('eth_chainId')) !== 177n) throw new Error('wrong chain');
  const head = await rpc.call('eth_getBlockByNumber', ['latest', false]);
  const tag = { blockHash: head.hash };
  const gasPrice = BigInt(head.baseFeePerGas) + BigInt(await rpc.call('eth_maxPriorityFeePerGas'));
  const balances = {};
  for (const [role, address] of Object.entries({ owner, agent, vault })) balances[role] = { address, nativeHsk: formatUnits(BigInt(await rpc.call('eth_getBalance', [address, tag])), 18) };
  async function read(to, functionName, args) {
    return decodeFunctionResult({ abi, functionName, data: await rpc.call('eth_call', [{ to, data: encodeFunctionData({ abi, functionName, args }) }, tag]) });
  }
  const configuration = { whskCap: await read(vault, 'maxTrade', [MAINNET_MARKET.whsk]), vaultWhsk: await read(MAINNET_MARKET.whsk, 'balanceOf', [vault]), vaultUsdt: await read(MAINNET_MARKET.usdt, 'balanceOf', [vault]), ownerWhsk: await read(MAINNET_MARKET.whsk, 'balanceOf', [owner]) };
  const [sold, l1Fee] = await multicall(rpc, head.hash, [quoteSub({ venue: 'hskswap-30', tokenIn: 'WHSK', amountIn: amount }), sub(MAINNET_MARKET.gasOracle, 'getL1Fee', [`0x${'a5'.repeat(400)}`])]);
  if (!sold || l1Fee === null) throw new Error('quote or gas oracle unavailable');
  const usdt = sold[0];
  const [samePoolBuy, dodoBuy] = await multicall(rpc, head.hash, [quoteSub({ venue: 'hskswap-30', tokenIn: 'USDT', amountIn: usdt }), quoteSub({ venue: 'dodo-dvm', tokenIn: 'USDT', amountIn: usdt })]);
  const fee = gas => gas * gasPrice + l1Fee;
  const report = {
    lane: 'mainnet read-only quotes; no transactions', at: new Date().toISOString(), block: BigInt(head.number).toString(), balances, configuration,
    inputWhsk: formatUnits(amount, 18), sellOutputUsdt: formatUnits(usdt, 6),
    indicativeRoundTrips: [ ['HSKSwap -> HSKSwap', samePoolBuy], ['HSKSwap -> DODO', dodoBuy] ].map(([route, quote]) => ({ route, outputWhsk: quote ? formatUnits(quote[0], 18) : null, pnlHskBeforeNetworkCosts: quote ? formatUnits(quote[0] - amount, 18) : null })),
    gasPriceGwei: formatUnits(gasPrice, 9), l1FeeForSynthetic400BytesHsk: formatUnits(l1Fee, 18),
    costsHsk: { intrinsic21000GasExcludingL1: formatUnits(21000n * gasPrice, 18), plainSwapFrom104740GasBenchmark: formatUnits(fee(104740n), 18), guardedSwapFrom172896GasBenchmark: formatUnits(fee(172896n), 18), firstSwapRunbook202215Gas: formatUnits(fee(202215n), 18) },
    limitations: ['The balance of any other user wallet is unknown.', 'Native HSK must be wrapped into WHSK; wrapping, approvals, transfers and vault configuration cost additional gas.', 'Same-pool buy is quoted against the original block state; this is indicative, not a stateful round-trip simulation.', 'Cross-venue quote is not executable by the current fixed-router vault.', 'Gas figures use previously measured fork gas, not eth_estimateGas for an executable transaction at this size.', 'No vault trade can execute with zero cap and zero funds.'],
  };
  const json = JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  writeFileSync(file, json + '\n'); console.log(json);
} finally { rpc.close(); }
