"use strict";
// Timer tiers (CONTRACT.md): hold $LATTICE as the launcher -> shorter burn interval.
//   0 LATTICE          -> 180 s
//   >= 1,000,000       -> 120 s
//   >= 10,000,000      ->  60 s
// Balances are in whole LATTICE (6 decimals on chain, divided out before this).

const TIERS = [
  { minLattice: 0, sec: 180 },
  { minLattice: 1000000, sec: 120 },
  { minLattice: 10000000, sec: 60 },
];

function intervalForBalance(lattice) {
  const n = Number(lattice) || 0;
  let sec = TIERS[0].sec;
  for (const t of TIERS) if (n >= t.minLattice) sec = t.sec;
  return sec;
}

function tierIndexForBalance(lattice) {
  const n = Number(lattice) || 0;
  let idx = 0;
  TIERS.forEach((t, i) => { if (n >= t.minLattice) idx = i; });
  return idx;
}

/**
 * Launcher's LATTICE balance (whole tokens) read from their ATA of LATTICE_MINT.
 * No LATTICE_MINT -> 0 (everyone tier 0). No ATA -> 0. RPC error -> 0 (never block a launch).
 */
async function latticeBalanceOf(connection, ownerPubkey) {
  const mintStr = process.env.LATTICE_MINT;
  if (!mintStr) return 0;
  try {
    const { PublicKey } = require("@solana/web3.js");
    const { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
    const mint = new PublicKey(mintStr);
    const owner = typeof ownerPubkey === "string" ? new PublicKey(ownerPubkey) : ownerPubkey;
    // pump.fun mints are Token-2022; try that first, then legacy in case LATTICE_MINT is an SPL mint.
    for (const prog of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
      const ata = getAssociatedTokenAddressSync(mint, owner, false, prog);
      try {
        const r = await connection.getTokenAccountBalance(ata);
        if (r && r.value) return Number(r.value.uiAmount || 0);
      } catch (_) {
        // no ATA under this program -> try next
      }
    }
    return 0;
  } catch (e) {
    console.warn("[tiers] balance read failed:", e.message || e);
    return 0;
  }
}

module.exports = { TIERS, intervalForBalance, tierIndexForBalance, latticeBalanceOf };
