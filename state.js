"use strict";
// GET /api/state  (cached 5 s at the edge)
const kv = require("../lib/kv");
const { TIERS } = require("../lib/tiers");
const { ok, fail, methodGuard } = require("../lib/http");

const CACHE = { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=10" };

function publicCoin(c, now) {
  const intervalSec = Number(c.intervalSec) || TIERS[0].sec;
  const lastBurnAt = Number(c.lastBurnAt) || 0;
  const base = lastBurnAt || Number(c.createdAt) || now;
  const nextBurnAt = base + intervalSec * 1000;
  return {
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    image: c.image || "",
    owner: c.owner,
    burnWallet: c.burnWallet,
    createdAt: Number(c.createdAt) || 0,
    createSig: c.createSig || "",
    intervalSec,
    lastBurnAt,
    nextBurnAt,
    pendingLamports: Number(c.pendingLamports) || 0,
    complete: !!c.complete,
    mcapSol: Number(c.mcapSol) || 0,
    totalSolBurned: Number(c.totalSolBurned) || 0,
    totalTokensBurned: Number(c.totalTokensBurned) || 0,
    burnCount: Number(c.burnCount) || 0,
    lastSig: c.lastSig || "",
    status: c.status || "",
  };
}

module.exports = async (req, res) => {
  if (!methodGuard(req, res, "GET")) return;
  try {
    const now = Date.now();
    const [coins, recent, totals] = await Promise.all([kv.listCoins(), kv.recentBurns(), kv.getStats()]);
    return ok(res, {
      now,
      lattice: { mint: process.env.LATTICE_MINT || "", tiers: TIERS },
      totals,
      coins: coins.map((c) => publicCoin(c, now)),
      recent: recent.map((b) => ({ mint: b.mint, symbol: b.symbol, sig: b.sig, sol: b.sol, tokens: b.tokens, ts: b.ts })),
    }, CACHE);
  } catch (e) {
    console.error("[state]", e);
    return fail(res, 500, e.message || "state failed");
  }
};

module.exports.publicCoin = publicCoin;
