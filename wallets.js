"use strict";
// Wallets:
//   ops wallet   = OPS_WALLET_SECRET (base58 64-byte secret key). Pays tx fees for tick, seeds burn wallets.
//   burn wallet  = per coin, derived: Keypair.fromSeed(HMAC-SHA512(BURN_MASTER_SEED, mintPubkeyBytes)[0..32])
// Nothing here ever logs or returns a secret.

const crypto = require("crypto");
const { Keypair, PublicKey } = require("@solana/web3.js");

function bs58decode(s) {
  const m = require("bs58");
  return (m.default || m).decode(s);
}

function opsKeypair() {
  const secret = process.env.OPS_WALLET_SECRET;
  if (!secret) throw new Error("OPS_WALLET_SECRET not set");
  const bytes = bs58decode(secret.trim());
  if (bytes.length === 64) return Keypair.fromSecretKey(Uint8Array.from(bytes));
  if (bytes.length === 32) return Keypair.fromSeed(Uint8Array.from(bytes));
  throw new Error("OPS_WALLET_SECRET must be a base58 64-byte secret key");
}

function masterSeedBytes() {
  const seed = process.env.BURN_MASTER_SEED;
  if (!seed || seed.length < 16) throw new Error("BURN_MASTER_SEED not set (need >=16 chars)");
  return Buffer.from(seed, "utf8");
}

/** Deterministic burn wallet for a mint. */
function burnKeypairForMint(mint) {
  const mintPk = typeof mint === "string" ? new PublicKey(mint) : mint;
  const h = crypto.createHmac("sha512", masterSeedBytes()).update(mintPk.toBytes()).digest();
  return Keypair.fromSeed(Uint8Array.from(h.subarray(0, 32)));
}

function burnWalletForMint(mint) {
  return burnKeypairForMint(mint).publicKey;
}

module.exports = { opsKeypair, burnKeypairForMint, burnWalletForMint };
