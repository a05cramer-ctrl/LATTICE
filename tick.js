"use strict";
// POST /api/tick  (header x-cron-key: CRON_SECRET  or  Authorization: Bearer CRON_SECRET)
// Every minute: refresh every coin's curve snapshot, then for coins whose timer is due
// claim creator fees -> buy on the curve -> burn, in ONE tx. Max 8 burns per tick, < 25 s wall time.
// Confirmations run after the response via waitUntil; receipts are written only once confirmed.
const { waitUntil } = require("@vercel/functions");
const kv = require("../lib/kv");
const { ok, fail, methodGuard, requireCronAuth } = require("../lib/http");
const { opsKeypair, burnKeypairForMint } = require("../lib/wallets");
const pump = require("../lib/pump");
const rpc = require("../lib/rpc");
const connection = () => rpc.connection();
const waitForSignature = (...a) => rpc.waitForSignature(...a);
const { deadline } = rpc;

const TICK_BUDGET_MS = 24000;
const MAX_BURNS = 8;
const MIN_BURN_LAMPORTS = Number(process.env.MIN_BURN_LAMPORTS || 5000000);
const SEED_LAMPORTS = 3000000;
const ATTEMPT_COOLDOWN_MS = 90000; // don't retry a coin while a previous attempt may still be confirming

function nextBurnAt(c) {
  const base = Number(c.lastBurnAt) || Number(c.createdAt) || 0;
  return base + (Number(c.intervalSec) || 180) * 1000;
}

async function sendTx(tx) {
  return connection().sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" });
}

async function finalizeBurn({ coin, sig, solLamports, tokensRaw, buySig }) {
  const r = await waitForSignature(sig, 60000);
  if (!r.ok) {
    await kv.updateCoin(coin.mint, { status: `burn tx failed: ${typeof r.err === "string" ? r.err : JSON.stringify(r.err)}`, lastAttemptAt: Date.now() });
    return;
  }
  const ts = Date.now();
  const sol = solLamports / pump.LAMPORTS;
  const tokens = Number(tokensRaw) / 10 ** pump.DECIMALS;
  await kv.addBurn({ mint: coin.mint, symbol: coin.symbol, sig, sol, tokens, ts, buySig: buySig || undefined });
  await kv.updateCoin(coin.mint, {
    lastBurnAt: ts,
    lastSig: sig,
    burnCount: (Number(coin.burnCount) || 0) + 1,
    totalSolBurned: (Number(coin.totalSolBurned) || 0) + sol,
    totalTokensBurned: (Number(coin.totalTokensBurned) || 0) + tokens,
    status: "burned",
  });
  await kv.incrStats({ burns: 1, solBurnedLamports: solLamports, tokensBurnedRaw: Number(tokensRaw) });
}

/** Curve path: one tx. Returns sig. */
async function burnOnCurve({ coin, state, opsKp }) {
  const burnKp = burnKeypairForMint(coin.mint);
  const built = await pump.buildClaimBuyBurnTx({ mint: coin.mint, burnKp, opsKp, state });
  const sig = await sendTx(built.tx);
  await kv.updateCoin(coin.mint, { status: "burning", lastAttemptAt: Date.now() });
  waitUntil(finalizeBurn({ coin, sig, solLamports: built.spendLamports, tokensRaw: built.burnAmountRaw }).catch((e) => console.error("[tick finalize]", coin.mint, e)));
  return sig;
}

/** Graduated path: claim tx -> Jupiter buy -> burn tx. Runs fully after the response via waitUntil. */
async function burnGraduated({ coin, state, opsKp }) {
  const burnKp = burnKeypairForMint(coin.mint);
  await kv.updateCoin(coin.mint, { status: "burning (graduated)", lastAttemptAt: Date.now() });
  const job = (async () => {
    const conn = connection();
    const s = pump.snapshot(state);
    if (s.claimableLamports > 0 || state.curve) {
      const claim = await pump.buildGraduatedClaimTx({ mint: coin.mint, burnKp, opsKp, state });
      const csig = await sendTx(claim.tx);
      const cr = await waitForSignature(csig, 60000);
      if (!cr.ok) throw new Error(`claim failed: ${JSON.stringify(cr.err)}`);
    }
    const bal = await conn.getBalance(burnKp.publicKey, "confirmed");
    const spend = bal - pump.RENT_SYSTEM - 3000000; // keep rent + ~0.003 for Jupiter ATA/wrap rents
    if (spend < MIN_BURN_LAMPORTS) throw new Error("not enough SOL after claim");
    const jup = await pump.jupiterBuy({ mint: coin.mint, burnKp, lamports: spend });
    if (jup.sig) await waitForSignature(jup.sig, 60000);
    const burn = await pump.buildBurnAllTx({ mint: coin.mint, burnKp, opsKp });
    const bsig = await sendTx(burn.tx);
    await finalizeBurn({ coin, sig: bsig, solLamports: spend, tokensRaw: burn.burnAmountRaw, buySig: jup.sig });
  })().catch(async (e) => {
    console.error("[tick graduated]", coin.mint, e);
    await kv.updateCoin(coin.mint, { status: `graduated burn failed: ${e.message || e}` });
  });
  waitUntil(job);
  return "pending";
}

module.exports = async (req, res) => {
  if (!methodGuard(req, res, req.method === "GET" ? "GET" : "POST")) return;
  const dl = deadline(TICK_BUDGET_MS);
  let locked = false;
  try {
    requireCronAuth(req);
    locked = await kv.acquireLock("tick", 55);
    if (!locked) return ok(res, { processed: 0, burned: [], skipped: "tick already running" });

    const coins = await kv.listCoins();
    if (!coins.length) return ok(res, { processed: 0, burned: [] });

    const states = await pump.readCoinStates(coins);
    const now = Date.now();
    const due = [];
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      const s = pump.snapshot(states[i]);
      const patch = { pendingLamports: s.pendingLamports, mcapSol: s.mcapSol, complete: s.complete };
      const isDue = now >= nextBurnAt(c);
      const cooling = now - (Number(c.lastAttemptAt) || 0) < ATTEMPT_COOLDOWN_MS;
      if (!s.hasCurve) patch.status = "curve not found";
      else if (isDue && s.pendingLamports < MIN_BURN_LAMPORTS) patch.status = "waiting for fees";
      await kv.updateCoin(c.mint, patch);
      if (s.hasCurve && isDue && !cooling && s.pendingLamports >= MIN_BURN_LAMPORTS) {
        due.push({ coin: { ...c, ...patch }, state: states[i], s });
      }
    }
    due.sort((a, b) => b.s.pendingLamports - a.s.pendingLamports);

    const burned = [];
    let processed = 0;
    let graduatedDone = false;
    if (due.length) {
      const opsKp = opsKeypair();
      for (const d of due.slice(0, MAX_BURNS)) {
        if (!dl.has(5000)) break;
        processed++;
        try {
          if (d.state.walletLamports === 0) {
            // First burn for this coin: seed the burn wallet so it can pay its own ATA / accumulator rent.
            const seed = await pump.buildSeedTx({ opsKp, burnWallet: d.coin.burnWallet, lamports: SEED_LAMPORTS });
            const ssig = await sendTx(seed);
            await kv.updateCoin(d.coin.mint, { status: "seeding burn wallet", lastAttemptAt: Date.now() });
            waitUntil(waitForSignature(ssig, 60000).then(() => kv.updateCoin(d.coin.mint, { lastAttemptAt: 0 })).catch(() => {}));
            continue;
          }
          if (d.s.complete) {
            if (graduatedDone) continue;
            graduatedDone = true;
            const sig = await burnGraduated({ coin: d.coin, state: d.state, opsKp });
            burned.push({ mint: d.coin.mint, sig });
          } else {
            const sig = await burnOnCurve({ coin: d.coin, state: d.state, opsKp });
            burned.push({ mint: d.coin.mint, sig });
          }
        } catch (e) {
          console.error("[tick]", d.coin.mint, e);
          await kv.updateCoin(d.coin.mint, { status: `error: ${String(e.message || e).slice(0, 160)}`, lastAttemptAt: Date.now() });
        }
      }
    }
    return ok(res, { processed, burned, due: due.length, coins: coins.length });
  } catch (e) {
    console.error("[tick]", e);
    return fail(res, e.status || 500, e.message || "tick failed");
  } finally {
    if (locked) await kv.releaseLock("tick").catch(() => {});
  }
};
