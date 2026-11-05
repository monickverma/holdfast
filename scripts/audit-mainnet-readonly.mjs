// Progress audit: public reads only. No signing, wallet files or transaction submission.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { encodeFunctionData, decodeFunctionResult, parseAbi, toEventSelector } from 'viem';
import { RpcClient } from '../.test-build/src/rpc.js';
const target = 'evidence/progress/mainnet-2026-11-03.json';
if (existsSync(target)) throw new Error('audit evidence already exists');
const vault = '0xbbd6f3df289a2fde6b5dd8edea19b827e0d07d3c';
const tx = '0x24d61d8021a549b45680db3108431d661bf488294783b9f59bc7ba2c39e3be34';
const tokens = { WHSK: '0xb210d2120d57b758ee163cffb43e73728c471cf1', USDT: '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029' };
const abi = parseAbi(['function VERSION() view returns (uint256)', 'function owner() view returns (address)', 'function agent() view returns (address)', 'function guardian() view returns (address)', 'function twapWindow() view returns (uint32)', 'function lossGuardOn() view returns (bool)', 'function logCount() view returns (uint64)', 'function agentExpiry() view returns (uint40)', 'function maxTrade(address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const rpc = new RpcClient('https://mainnet.hsk.xyz', { timeoutMs: 20000 });
const result = { lane: 'mainnet read-only', at: new Date().toISOString(), vault, deploymentTransaction: tx };
try {
  result.chainId = Number(BigInt(await rpc.call('eth_chainId')));
  if (result.chainId !== 177) throw new Error('wrong chain');
  const head = await rpc.call('eth_getBlockByNumber', ['latest', false]);
  result.block = BigInt(head.number).toString(); result.blockHash = head.hash;
  const blockRef = { blockHash: head.hash };
  result.runtimeBytes = ((await rpc.call('eth_getCode', [vault, blockRef])).length - 2) / 2;
  const receipt = await rpc.call('eth_getTransactionReceipt', [tx]);
  result.deployment = { succeeded: receipt.status === '0x1', address: receipt.contractAddress, block: BigInt(receipt.blockNumber).toString(), gasUsed: BigInt(receipt.gasUsed).toString() };
  async function read(address, functionName, args = []) {
    const data = encodeFunctionData({ abi, functionName, args });
    return decodeFunctionResult({ abi, functionName, data: await rpc.call('eth_call', [{ to: address, data }, blockRef]) });
  }
  result.state = {};
  for (const name of ['VERSION', 'owner', 'agent', 'guardian', 'twapWindow', 'lossGuardOn', 'logCount', 'agentExpiry']) result.state[name] = await read(vault, name);
  result.balancesWei = {};
  for (const [role, address] of Object.entries({ vault, owner: result.state.owner, agent: result.state.agent })) result.balancesWei[role] = BigInt(await rpc.call('eth_getBalance', [address, blockRef]));
  result.tokens = {};
  for (const [name, address] of Object.entries(tokens)) result.tokens[name] = { balance: await read(address, 'balanceOf', [vault]), maxTrade: await read(vault, 'maxTrade', [address]) };
  let trades = 0;
  const end = BigInt(head.number);
  for (let from = BigInt(receipt.blockNumber); from <= end; from += 5000n) {
    const to = from + 4999n > end ? end : from + 4999n;
    const logs = await rpc.call('eth_getLogs', [{ address: vault, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [toEventSelector('Traded(bytes32,address,uint256,uint256,uint256)')] }]);
    trades += logs.length;
  }
  result.tradedEventsSinceDeployment = trades;
  try {
    const response = await fetch(`https://hsk.blockscout.com/api/v2/addresses/${vault}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    result.explorer = { isContract: body.is_contract, sourceVerified: body.is_verified };
  } catch (error) { result.explorer = { error: String(error) }; }
} finally {
  rpc.close();
  mkdirSync('evidence/progress', { recursive: true });
  const json = JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  writeFileSync(target, json + '\n'); console.log(json);
}
