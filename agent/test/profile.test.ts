import test from "node:test";
import assert from "node:assert/strict";
import { assertTestMarketChain, CHAIN_ID, HSKSWAP, MAINNET_MARKET, loadConfig, networkProfile } from "../src/config.js";
test("default mainnet profile and addresses remain unchanged", () => {
 assert.equal(CHAIN_ID,177); assert.equal(loadConfig({}).chainId,177);
 assert.equal(loadConfig({}).rpcUrl,"https://mainnet.hsk.xyz");
 assert.equal(networkProfile({}).lane,"mainnet");
 assert.deepEqual(HSKSWAP,MAINNET_MARKET);
 assert.equal(MAINNET_MARKET.router,"0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3");
});
test("testnet selects 133 and its RPC and isolated lane", () => {
 assert.deepEqual(networkProfile({ NETWORK:"testnet" }), {network:"testnet",chainId:133,rpcUrl:"https://testnet.hsk.xyz",explorer:"https://testnet-explorer.hskchain.net",lane:"testnet"});
 assert.throws(()=>networkProfile({NETWORK:"typo"}));
});
test("test deployment refuses mainnet even when overridden", () => {
 assert.throws(()=>assertTestMarketChain(177),/177/);
 assert.throws(()=>loadConfig({NETWORK:"testnet",CHAIN_ID:"177"}),/177/);
 assert.doesNotThrow(()=>assertTestMarketChain(133));
 assert.doesNotThrow(()=>assertTestMarketChain(31337));
 assert.throws(()=>assertTestMarketChain(1));
});
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
test("testnet loads manifest addresses and refuses a mismatched chain", () => {
 const original = process.cwd(), previous = process.env.NETWORK;
 mkdirSync(".test-tmp", {recursive:true});
 const dir = mkdtempSync(join(original,".test-tmp","profile-"));
 try {
  process.chdir(dir); mkdirSync("data");
  const fields = ["router","quoter","pool","whsk","usdt","vault"];
  const manifest = Object.fromEntries(fields.map((key,i)=>[key,`0x${String(i+1).padStart(40,"0")}`]));
  writeFileSync("data/testnet-market.json",JSON.stringify({...manifest,chainId:133}));
  process.env.NETWORK="testnet";
  assert.equal(loadConfig({NETWORK:"testnet"}).vault,manifest.vault);
  assert.equal(loadConfig({NETWORK:"testnet"}).dataDir,"data/testnet");
  assert.equal(HSKSWAP.whsk,manifest.whsk); assert.equal(HSKSWAP.usdt,manifest.usdt);
  assert.equal(HSKSWAP.router,manifest.router); assert.equal(HSKSWAP.pool,manifest.pool);
  assert.equal(HSKSWAP.quoter,manifest.quoter);
  assert.throws(()=>loadConfig({NETWORK:"testnet",CHAIN_ID:"31337"}),/manifest chain/);
 } finally { process.chdir(original); if(previous===undefined) delete process.env.NETWORK; else process.env.NETWORK=previous; }
});
