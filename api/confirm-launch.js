"use strict";
// POST /api/confirm-launch {sig, mint} -> { ok, coin }
// Verifies ON CHAIN: tx succeeded, fee payer == owner, contains create_v2 for this mint with creator == derived burn wallet.
const { PublicKey } = require("@solana/web3.js");
const kv = require("../lib/kv");
const { ok, fail, methodGuard, readJson } = require("../lib/http");
const { burnWalletForMint } = require("../lib/wallets");
const { verifyCreateTx, readCoinStates, snapshot } = require("../lib/pump");
const { connection, waitForSignature } = require("../lib/rpc");
const { intervalForBalance, latticeBalanceOf } = require("../lib/tiers");
const { publicCoin } = require("./state");

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

module.exports = async (req, res) => {
  if (!methodGuard(req, res, "POST")) return;
  try {
    const body = await readJson(req);
    const sig = String(body.sig || "").trim();
    const mintStr = String(body.mint || "").trim();
    if (!SIG_RE.test(sig)) return fail(res, 400, "bad sig");
    let mint;
    try { mint = new PublicKey(mintStr); } catch { return fail(res, 400, "bad mint"); }

    const existing = await kv.getCoin(mint.toBase58());
    if (existing) return ok(res, { coin: publicCoin(existing, Date.now()) });

    const pending = await kv.getPending(mint.toBase58());
    if (!pending) return fail(res, 404, "no pending launch for this mint (build-create first; drafts expire after 1h)");

    const burnWallet = burnWalletForMint(mint);
    if (burnWallet.toBase58() !== pending.burnWallet) return fail(res, 500, "burn wallet derivation mismatch");

    // Give the tx a moment to confirm, then prove it.
    await waitForSignature(sig, 40000);
    const v = await verifyCreateTx({ sig, mint, owner: pending.owner, burnWallet });
    if (!v.ok) return fail(res, 400, v.error);

    // Re-read tier at confirm time (balance may have changed since build); keep the better of the two.
    let intervalSec = Number(pending.intervalSec) || intervalForBalance(0);
    try {
      const bal = await latticeBalanceOf(connection(), pending.owner);
      intervalSec = Math.min(intervalSec, intervalForBalance(bal));
    } catch { /* keep pending tier */ }

    let image = "";
    try {
      const r = await fetch(pending.uri, { signal: AbortSignal.timeout(4000) });
      if (r.ok) { const j = await r.json(); image = String(j.image || ""); }
    } catch { /* image optional */ }

    const createdAt = v.blockTime || Date.now();
    const coin = {
      mint: mint.toBase58(), name: pending.name, symbol: pending.symbol, image, uri: pending.uri,
      owner: pending.owner, burnWallet: burnWallet.toBase58(), createdAt, createSig: sig,
      intervalSec, lastBurnAt: 0, lastAttemptAt: 0, burnCount: 0, pendingLamports: 0, complete: false, mcapSol: 0,
      totalSolBurned: 0, totalTokensBurned: 0, lastSig: "", status: "waiting for fees", latticeBalance: pending.latticeBalance || 0,
    };
    try {
      const [st] = await readCoinStates([coin]);
      const s = snapshot(st);
      coin.pendingLamports = s.pendingLamports;
      coin.mcapSol = s.mcapSol;
      coin.complete = s.complete;
    } catch { /* first tick fills it */ }

    await kv.putCoin(coin);
    await kv.incrStats({ coins: 1 });
    await kv.delPending(mint.toBase58());
    return ok(res, { coin: publicCoin(coin, Date.now()) });
  } catch (e) {
    console.error("[confirm-launch]", e);
    return fail(res, e.status || 500, e.message || "confirm failed");
  }
};
