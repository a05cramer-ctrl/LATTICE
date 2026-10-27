"use strict";
// Helius RPC connection + small helpers (batched account reads, tx confirm, deadline).

const { Connection, PublicKey } = require("@solana/web3.js");

let conn = null;

function rpcUrl() {
  const key = process.env.HELIUS_API_KEY;
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  return process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
}

function connection() {
  if (!conn) conn = new Connection(rpcUrl(), { commitment: "confirmed", disableRetryOnRateLimit: false });
  return conn;
}

/** getMultipleAccountsInfo in chunks of <=100. Returns array aligned with keys. */
async function getAccountsBatched(keys, commitment = "confirmed") {
  const c = module.exports.connection();
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100).map((k) => (typeof k === "string" ? new PublicKey(k) : k));
    const infos = await c.getMultipleAccountsInfo(chunk, commitment);
    out.push(...infos);
  }
  return out;
}

/** Poll a signature until confirmed/finalized or timeout. Returns {ok, err}. */
async function waitForSignature(sig, timeoutMs = 45000) {
  const c = module.exports.connection();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await c.getSignatureStatuses([sig]);
    const s = st && st.value && st.value[0];
    if (s) {
      if (s.err) return { ok: false, err: s.err };
      if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, err: "timeout" };
}

/** Deadline helper: returns a function telling whether we still have >= ms left. */
function deadline(totalMs) {
  const end = Date.now() + totalMs;
  return {
    left: () => end - Date.now(),
    has: (ms) => end - Date.now() >= ms,
  };
}

module.exports = { connection, rpcUrl, getAccountsBatched, waitForSignature, deadline };
