"use strict";
// POST /api/build-create {owner,name,symbol,uri,devBuySol?}
// -> { ok, tx:<base64 v0 tx partially signed by mint keypair>, mint, burnWallet }
const { PublicKey, Keypair } = require("@solana/web3.js");
const kv = require("../lib/kv");
const { ok, fail, methodGuard, readJson } = require("../lib/http");
const { burnWalletForMint } = require("../lib/wallets");
const { buildCreateTx } = require("../lib/pump");
const { connection } = require("../lib/rpc");
const { intervalForBalance, latticeBalanceOf } = require("../lib/tiers");

const SYMBOL_RE = /^[A-Z0-9]{1,13}$/;
const MAX_DEV_BUY_SOL = 10;

module.exports = async (req, res) => {
  if (!methodGuard(req, res, "POST")) return;
  try {
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const symbol = String(body.symbol || "").trim().toUpperCase();
    const uri = String(body.uri || "").trim();
    let owner;
    try { owner = new PublicKey(String(body.owner || "")); } catch { return fail(res, 400, "bad owner"); }
    if (!name || name.length > 32) return fail(res, 400, "name must be 1-32 chars");
    if (!SYMBOL_RE.test(symbol)) return fail(res, 400, "symbol must match ^[A-Z0-9]{1,13}$");
    if (!uri || uri.length > 200 || !/^https?:\/\//i.test(uri)) return fail(res, 400, "uri must be an http(s) url <= 200 chars");
    let devBuySol = Number(body.devBuySol || 0);
    if (!Number.isFinite(devBuySol) || devBuySol < 0) devBuySol = 0;
    if (devBuySol > MAX_DEV_BUY_SOL) return fail(res, 400, `devBuySol max ${MAX_DEV_BUY_SOL}`);

    // Mint keypair first: the burn wallet (= create_v2 creator) is derived from the mint pubkey.
    const preMint = Keypair.generate();
    const burnWallet = burnWalletForMint(preMint.publicKey);
    const built = await buildCreateTx({ owner, name, symbol, uri, burnWallet, devBuySol, mintKeypair: preMint });

    // Tier from the launcher's LATTICE balance, fixed at launch.
    const latticeBalance = await latticeBalanceOf(connection(), owner);
    const intervalSec = intervalForBalance(latticeBalance);

    await kv.putPending(built.mint, {
      mint: built.mint, owner: owner.toBase58(), burnWallet: built.burnWallet,
      name, symbol, uri, devBuySol, intervalSec, latticeBalance, builtAt: Date.now(),
    });
    return ok(res, { tx: built.tx, mint: built.mint, burnWallet: built.burnWallet, intervalSec });
  } catch (e) {
    console.error("[build-create]", e);
    return fail(res, e.status || 500, e.message || "build failed");
  }
};
