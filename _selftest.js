"use strict";
// Offline self-test: `node lib/_selftest.js`. No network. Uses throwaway env values.
process.env.LATTICE_SILENT_KV = "1";
process.env.BURN_MASTER_SEED = process.env.BURN_MASTER_SEED || "selftest-master-seed-do-not-use-0123456789";
process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || "x";

const assert = require("assert");
const { Keypair, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");

(async () => {
  // wallets: deterministic derivation, distinct per mint
  const { burnKeypairForMint, burnWalletForMint } = require("./wallets");
  const m1 = Keypair.generate().publicKey, m2 = Keypair.generate().publicKey;
  assert.strictEqual(burnWalletForMint(m1).toBase58(), burnWalletForMint(m1.toBase58()).toBase58());
  assert.notStrictEqual(burnWalletForMint(m1).toBase58(), burnWalletForMint(m2).toBase58());
  assert.strictEqual(burnKeypairForMint(m1).publicKey.toBase58(), burnWalletForMint(m1).toBase58());
  const seedA = burnWalletForMint(m1).toBase58();
  process.env.BURN_MASTER_SEED = "another-seed-another-seed-1234";
  assert.notStrictEqual(burnWalletForMint(m1).toBase58(), seedA, "different master seed -> different wallet");
  console.log("wallets ok");

  // tiers
  const { intervalForBalance, tierIndexForBalance, TIERS } = require("./tiers");
  assert.deepStrictEqual(TIERS.map((t) => t.sec), [180, 120, 60]);
  assert.strictEqual(intervalForBalance(0), 180);
  assert.strictEqual(intervalForBalance(999999), 180);
  assert.strictEqual(intervalForBalance(1000000), 120);
  assert.strictEqual(intervalForBalance(9999999), 120);
  assert.strictEqual(intervalForBalance(10000000), 60);
  assert.strictEqual(intervalForBalance(1e12), 60);
  assert.strictEqual(tierIndexForBalance(5000000), 1);
  console.log("tiers ok");

  // kv in-memory fallback
  const kv = require("./kv");
  assert.strictEqual(kv.hasUpstash(), false);
  await kv.putCoin({ mint: "M1", name: "a", symbol: "A", createdAt: 1, intervalSec: 180, complete: false, burnCount: 0 });
  await kv.putCoin({ mint: "M2", name: "b", symbol: "B", createdAt: 2, intervalSec: 60, complete: true, burnCount: 0 });
  const list = await kv.listCoins();
  assert.deepStrictEqual(list.map((c) => c.mint), ["M2", "M1"]);
  assert.strictEqual(list[0].complete, true);
  assert.strictEqual(typeof list[0].intervalSec, "number");
  await kv.addBurn({ mint: "M1", symbol: "A", sig: "s", sol: 0.01, tokens: 5, ts: 3 });
  assert.strictEqual((await kv.getBurns("M1")).length, 1);
  assert.strictEqual((await kv.recentBurns()).length, 1);
  await kv.incrStats({ burns: 1, solBurnedLamports: 10000000, tokensBurnedRaw: 5000000 });
  const st = await kv.getStats();
  assert.strictEqual(st.burns, 1); assert.strictEqual(st.solBurned, 0.01); assert.strictEqual(st.tokensBurned, 5);
  assert.strictEqual(await kv.acquireLock("t", 10), true);
  assert.strictEqual(await kv.acquireLock("t", 10), false);
  await kv.releaseLock("t");
  assert.strictEqual(await kv.acquireLock("t", 10), true);
  await kv.putPending("M3", { a: 1 });
  assert.deepStrictEqual(await kv.getPending("M3"), { a: 1 });
  console.log("kv ok");

  // pump: snapshot math + offline instruction building for the claim/buy/burn tx (no RPC)
  const pump = require("./pump");
  const creator = burnWalletForMint(m1);
  const curve = {
    virtualTokenReserves: new BN("1073000000000000"), virtualQuoteReserves: new BN("30000000000"),
    realTokenReserves: new BN("793100000000000"), realQuoteReserves: new BN(0), tokenTotalSupply: new BN("1000000000000000"),
    complete: false, creator, isMayhemMode: false, isCashbackCoin: false, quoteMint: PublicKey.default,
    creatorFeeBps: new BN(0), canEditCreatorFee: false, isHolderReward: false, creatorFee: new BN(7000000), protocolFees: new BN(0),
    depth: 0, initialVirtualQuoteReserves: new BN(0), postCompleteBaseOut: new BN(0), postCompleteQuoteIn: new BN(0),
  };
  const s = pump.snapshot({ curve, vaultLamports: 2890880, walletLamports: 3000000 });
  assert.strictEqual(s.pendingLamports, 7000000 + 2000000 + (3000000 - 890880));
  assert.strictEqual(s.claimableLamports, 9000000);
  assert.ok(s.mcapSol > 27 && s.mcapSol < 29, "mcap ~27.96 SOL for a fresh curve");
  assert.strictEqual(s.complete, false);
  const empty = pump.snapshot({ curve: null, vaultLamports: 0, walletLamports: 0 });
  assert.strictEqual(empty.pendingLamports, 0); assert.strictEqual(empty.hasCurve, false);
  console.log("pump snapshot ok");

  // verifyCreateTx decoding path: build a create ix and decode it with the same coder
  const { PUMP_SDK, pumpIdl } = require("@pump-fun/pump-sdk");
  const { BorshInstructionCoder } = require("@coral-xyz/anchor");
  const ix = await PUMP_SDK.createV2Instruction({ mint: m1, name: "N", symbol: "S", uri: "https://u", creator, user: m2, mayhemMode: false });
  const d = new BorshInstructionCoder(pumpIdl).decode(ix.data);
  assert.strictEqual(d.name, "create_v2");
  assert.strictEqual(d.data.creator.toBase58(), creator.toBase58());
  assert.strictEqual(ix.keys[0].pubkey.toBase58(), m1.toBase58());
  assert.strictEqual(ix.keys[5].pubkey.toBase58(), m2.toBase58());
  console.log("create_v2 decode ok");

  console.log("ALL OK");
})().catch((e) => { console.error(e); process.exit(1); });
