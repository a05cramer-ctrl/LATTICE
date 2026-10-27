"use strict";
// GET /api/coin?mint=...  -> { ok, coin, burns:[{sig,sol,tokens,ts}] }
const kv = require("../lib/kv");
const { ok, fail, methodGuard } = require("../lib/http");
const { publicCoin } = require("./state");

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

module.exports = async (req, res) => {
  if (!methodGuard(req, res, "GET")) return;
  try {
    const url = new URL(req.url, "http://x");
    const mint = String(url.searchParams.get("mint") || "").trim();
    if (!MINT_RE.test(mint)) return fail(res, 400, "bad mint");
    const coin = await kv.getCoin(mint);
    if (!coin) return fail(res, 404, "coin not found");
    const burns = await kv.getBurns(mint, 200);
    return ok(res, {
      coin: publicCoin(coin, Date.now()),
      burns: burns.map((b) => ({ sig: b.sig, sol: b.sol, tokens: b.tokens, ts: b.ts })),
    }, { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=10" });
  } catch (e) {
    console.error("[coin]", e);
    return fail(res, 500, e.message || "coin failed");
  }
};
