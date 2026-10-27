"use strict";
// pump.fun glue for LATTICE.
//   - buildCreateTx      : create_v2 (+ optional dev buy_v2), creator = per-coin burn wallet, fee payer = owner
//   - verifyCreateTx     : on-chain check of a launch signature (create_v2 for mint, creator == burn wallet, payer == owner)
//   - readCurves         : batched BondingCurve reads (<=100 per RPC call)
//   - snapshot           : pendingLamports / mcapSol / complete from a curve + balances
//   - buildClaimBuyBurnTx: sweep_creator_fee -> collect_creator_fee_v2 -> buy_exact_quote_in_v3 -> burn_checked, ONE tx
//   - graduated path     : claim (curve + AMM) tx, then Jupiter Swap v2 buy, then burn tx
//
// pump-sdk functions used (4.3.1): PUMP_SDK.createV2Instruction, PUMP_SDK.createV2AndBuyV2Instructions,
// PUMP_SDK.decodeBondingCurveNullable, PUMP_SDK.decodeGlobal, PUMP_SDK.decodeFeeConfig,
// PUMP_SDK.sweepCreatorFeeInstruction, PUMP_SDK.sweepPoolCreatorFeeInstruction,
// PUMP_SDK.buyExactQuoteInV3Instructions, getPumpProgram(null).methods.collectCreatorFeeV2 (raw builder,
// same one OnlinePumpSdk uses internally), OnlinePumpSdk.collectCoinCreatorFeeV2Instructions,
// getBuyTokenAmountFromSolAmount, getBuyV3TokenAmountFromQuoteAmount, bondingCurveMarketCap,
// bondingCurvePda, creatorVaultPda, canonicalPumpPoolPda, userVolumeAccumulatorPda, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, PUMP_PROGRAM_ID, pumpIdl.

const {
  PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram,
} = require("@solana/web3.js");
const {
  NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createBurnCheckedInstruction, createCloseAccountInstruction, unpackAccount,
} = require("@solana/spl-token");
const BN = require("bn.js");
const sdk = require("@pump-fun/pump-sdk");
const { BorshInstructionCoder } = require("@coral-xyz/anchor");
const rpc = require("./rpc");
const connection = () => rpc.connection();
const getAccountsBatched = (...a) => rpc.getAccountsBatched(...a);

const {
  PUMP_SDK, OnlinePumpSdk, PUMP_PROGRAM_ID, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, pumpIdl,
  bondingCurvePda, creatorVaultPda, canonicalPumpPoolPda, userVolumeAccumulatorPda,
  getBuyTokenAmountFromSolAmount, getBuyV3TokenAmountFromQuoteAmount, bondingCurveMarketCap, getPumpProgram,
} = sdk;

const DECIMALS = 6;
const LAMPORTS = 1e9;
// Rent floors (lamports). System account 0 bytes: 890_880. Token-2022 ATA (~170 B): ~2_074_080. UVA 137 B: 1_844_400.
const RENT_SYSTEM = 890880;
const RENT_ATA_2022 = 2074080;
const RENT_UVA = 1844400;
const SAFETY_LAMPORTS = 300000; // slack left in the burn wallet so the tx never fails on an off-by-rent
const BUY_SLIPPAGE_PCT = 3; // min_tokens_out floor; the floor is what we burn, remainder is burned next tick
const CU_PRICE_MICRO = Number(process.env.CU_PRICE_MICRO || 100000); // priority fee per CU

const ixCoder = new BorshInstructionCoder(pumpIdl);
const offlineProgram = getPumpProgram(null);

// ---------- global / fee config cache (60 s) ----------
let cfgCache = { at: 0, global: null, feeConfig: null };
async function loadConfig() {
  if (Date.now() - cfgCache.at < 60000 && cfgCache.global) return cfgCache;
  const [g, f] = await getAccountsBatched([GLOBAL_PDA, PUMP_FEE_CONFIG_PDA]);
  if (!g) throw new Error("pump Global account not found");
  if (!f) throw new Error("pump FeeConfig account not found");
  cfgCache = { at: Date.now(), global: PUMP_SDK.decodeGlobal(g), feeConfig: PUMP_SDK.decodeFeeConfig(f) };
  return cfgCache;
}

function pk(x) {
  return typeof x === "string" ? new PublicKey(x) : x;
}

function toV0Tx(payer, instructions, blockhash, signers = []) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  // Sign only with keypairs the message requires (signing with a non-signer throws).
  const required = msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
  const use = signers.filter((s) => required.includes(s.publicKey.toBase58()));
  if (use.length) tx.sign(use);
  return tx;
}

function budgetIxs(units) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO }),
  ];
}

// ---------- create ----------
/**
 * Build the launch tx. Fee payer = owner (Phantom signs). Mint keypair signs here.
 * Returns { tx: base64 v0 tx, mint, burnWallet }.
 */
async function buildCreateTx({ owner, name, symbol, uri, burnWallet, devBuySol = 0, mintKeypair }) {
  const ownerPk = pk(owner);
  const creator = pk(burnWallet);
  const mintKp = mintKeypair || Keypair.generate();
  const conn = connection();
  const ixs = [...budgetIxs(devBuySol > 0 ? 300000 : 200000)];

  if (devBuySol > 0) {
    const { global, feeConfig } = await loadConfig();
    const quoteAmount = new BN(Math.round(devBuySol * LAMPORTS));
    const amount = getBuyTokenAmountFromSolAmount({
      global, feeConfig, mintSupply: global.tokenTotalSupply, bondingCurve: null, amount: quoteAmount, quoteMint: NATIVE_MINT,
    });
    ixs.push(...await PUMP_SDK.createV2AndBuyV2Instructions({
      global, mint: mintKp.publicKey, name, symbol, uri, creator, user: ownerPk,
      amount, quoteAmount, mayhemMode: false, slippage: 5,
    }));
  } else {
    ixs.push(await PUMP_SDK.createV2Instruction({
      mint: mintKp.publicKey, name, symbol, uri, creator, user: ownerPk, mayhemMode: false,
    }));
  }

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = toV0Tx(ownerPk, ixs, blockhash, [mintKp]);
  return {
    tx: Buffer.from(tx.serialize()).toString("base64"),
    mint: mintKp.publicKey.toBase58(),
    burnWallet: creator.toBase58(),
  };
}

// ---------- verify ----------
/**
 * Fetch `sig` and prove it is a successful create_v2 for `mint` with creator == burnWallet and fee payer == owner.
 * Returns { ok, error?, blockTime }.
 */
async function verifyCreateTx({ sig, mint, owner, burnWallet }) {
  const conn = connection();
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return { ok: false, error: "transaction not found yet" };
  if (tx.meta && tx.meta.err) return { ok: false, error: "transaction failed on chain" };

  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta && tx.meta.loadedAddresses });
  const payer = keys.get(0);
  if (!payer || payer.toBase58() !== pk(owner).toBase58()) return { ok: false, error: "fee payer is not the owner" };

  const mintStr = pk(mint).toBase58();
  const burnStr = pk(burnWallet).toBase58();
  const ixs = msg.compiledInstructions || [];
  let found = false;
  for (const ci of ixs) {
    const prog = keys.get(ci.programIdIndex);
    if (!prog || !prog.equals(PUMP_PROGRAM_ID)) continue;
    let decoded;
    try { decoded = ixCoder.decode(Buffer.from(ci.data)); } catch { continue; }
    if (!decoded || decoded.name !== "create_v2") continue;
    const ixMint = keys.get(ci.accountKeyIndexes[0]);
    const ixUser = keys.get(ci.accountKeyIndexes[5]);
    const creator = decoded.data.creator;
    if (!ixMint || ixMint.toBase58() !== mintStr) return { ok: false, error: "create_v2 is for a different mint" };
    if (!creator || creator.toBase58() !== burnStr) return { ok: false, error: "creator is not the derived burn wallet" };
    if (!ixUser || ixUser.toBase58() !== pk(owner).toBase58()) return { ok: false, error: "create_v2 user is not the owner" };
    found = true;
    break;
  }
  if (!found) return { ok: false, error: "no create_v2 instruction in transaction" };
  return { ok: true, blockTime: tx.blockTime ? tx.blockTime * 1000 : Date.now() };
}

// ---------- reads ----------
/** For each mint: { curve, vaultLamports, walletLamports }. One batched RPC (3 keys per coin). */
async function readCoinStates(coins) {
  const keys = [];
  for (const c of coins) {
    keys.push(bondingCurvePda(pk(c.mint)));
    keys.push(creatorVaultPda(pk(c.burnWallet)));
    keys.push(pk(c.burnWallet));
  }
  const infos = keys.length ? await getAccountsBatched(keys) : [];
  return coins.map((c, i) => {
    const curveInfo = infos[i * 3];
    const vaultInfo = infos[i * 3 + 1];
    const walletInfo = infos[i * 3 + 2];
    let curve = null;
    try { curve = curveInfo ? PUMP_SDK.decodeBondingCurveNullable(curveInfo) : null; } catch { curve = null; }
    return {
      curve,
      vaultLamports: vaultInfo ? vaultInfo.lamports : 0,
      walletLamports: walletInfo ? walletInfo.lamports : 0,
    };
  });
}

/** What the next burn can spend, and the coin's market cap, from a state read. */
function snapshot(state) {
  const { curve, vaultLamports, walletLamports } = state;
  const onCurve = curve ? Number(curve.creatorFee.toString()) : 0;
  const inVault = Math.max(0, vaultLamports - RENT_SYSTEM);
  const inWallet = Math.max(0, walletLamports - RENT_SYSTEM);
  let mcapSol = 0;
  if (curve && !curve.virtualTokenReserves.isZero()) {
    const mc = bondingCurveMarketCap({
      mintSupply: curve.tokenTotalSupply, virtualQuoteReserves: curve.virtualQuoteReserves, virtualTokenReserves: curve.virtualTokenReserves,
    });
    mcapSol = Number(mc.toString()) / LAMPORTS;
  }
  return {
    pendingLamports: onCurve + inVault + inWallet,
    claimableLamports: onCurve + inVault,
    mcapSol,
    complete: !!(curve && curve.complete),
    hasCurve: !!curve,
  };
}

// ---------- claim + buy + burn (bonding curve) ----------
/**
 * One tx: [budget] sweep_creator_fee? -> collect_creator_fee_v2? -> (ATA) buy_exact_quote_in_v3 -> burn_checked.
 * Signers: ops (fee payer) + burn wallet. Returns { tx, spendLamports, burnAmountRaw, minTokensOut }.
 */
async function buildClaimBuyBurnTx({ mint, burnKp, opsKp, state }) {
  const mintPk = pk(mint);
  const burn = burnKp.publicKey;
  const { curve, vaultLamports, walletLamports } = state;
  if (!curve) throw new Error("bonding curve not found");
  if (curve.complete) throw new Error("curve complete; use graduated path");
  const { global, feeConfig } = await loadConfig();
  const conn = connection();

  const ata = getAssociatedTokenAddressSync(mintPk, burn, false, TOKEN_2022_PROGRAM_ID);
  const curveAta = getAssociatedTokenAddressSync(mintPk, bondingCurvePda(mintPk), true, TOKEN_2022_PROGRAM_ID);
  const uva = userVolumeAccumulatorPda(burn);
  const [ataInfo, curveAtaInfo, uvaInfo] = await getAccountsBatched([ata, curveAta, uva]);

  let existingTokens = 0n;
  if (ataInfo) {
    try { existingTokens = unpackAccount(ata, ataInfo, TOKEN_2022_PROGRAM_ID).amount; } catch { existingTokens = 0n; }
  }
  let curveBaseTokenBalance = new BN(0);
  if (curveAtaInfo) {
    try { curveBaseTokenBalance = new BN(unpackAccount(curveAta, curveAtaInfo, TOKEN_2022_PROGRAM_ID).amount.toString()); } catch { /* ignore */ }
  }

  // Lamports the burn wallet will hold after the claim legs land.
  const onCurve = Number(curve.creatorFee.toString());
  const inVault = Math.max(0, vaultLamports - RENT_SYSTEM);
  let available = walletLamports + onCurve + inVault;
  let reserve = RENT_SYSTEM + SAFETY_LAMPORTS;
  if (!ataInfo) reserve += RENT_ATA_2022;
  if (!uvaInfo) reserve += RENT_UVA;
  const spendLamports = Math.floor(available - reserve);
  if (spendLamports <= 0) throw new Error("nothing to spend after rent reserves");

  const spend = new BN(spendLamports);
  const tokensOut = getBuyV3TokenAmountFromQuoteAmount({
    global, feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: spend, curveBaseTokenBalance,
  });
  if (tokensOut.isZero()) throw new Error("quote returned zero tokens");

  const ixs = [...budgetIxs(400000)];
  if (onCurve > 0) {
    ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer: opsKp.publicKey, mint: mintPk, creator: burn, quoteMint: NATIVE_MINT }));
  }
  if (onCurve > 0 || inVault > 0) {
    ixs.push(await offlineProgram.methods.collectCreatorFeeV2().accountsPartial({
      creator: burn, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID, creatorVault: creatorVaultPda(burn),
    }).instruction());
  }
  const buyIxs = await PUMP_SDK.buyExactQuoteInV3Instructions({
    bondingCurve: curve, associatedUserAccountInfo: ataInfo || null, mint: mintPk, user: burn,
    amount: tokensOut, quoteAmount: spend, slippage: BUY_SLIPPAGE_PCT,
  });
  ixs.push(...buyIxs);
  // min_tokens_out as the SDK computed it (amount less slippage) is the guaranteed floor -> safe to burn.
  const minTokensOut = tokensOut.sub(tokensOut.muln(BUY_SLIPPAGE_PCT * 10).divn(1000));
  const burnAmountRaw = BigInt(minTokensOut.toString()) + existingTokens;
  if (burnAmountRaw <= 0n) throw new Error("burn amount is zero");
  ixs.push(createBurnCheckedInstruction(ata, mintPk, burn, burnAmountRaw, DECIMALS, [], TOKEN_2022_PROGRAM_ID));

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = toV0Tx(opsKp.publicKey, ixs, blockhash, [opsKp, burnKp]);
  return { tx, blockhash, lastValidBlockHeight, spendLamports, burnAmountRaw, minTokensOut: minTokensOut.toString() };
}

/** Seed a fresh burn wallet from ops (0.003 SOL) so it can pay its own rent accounts. */
async function buildSeedTx({ opsKp, burnWallet, lamports = 3000000 }) {
  const conn = connection();
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const ixs = [
    ...budgetIxs(5000),
    SystemProgram.transfer({ fromPubkey: opsKp.publicKey, toPubkey: pk(burnWallet), lamports }),
  ];
  return toV0Tx(opsKp.publicKey, ixs, blockhash, [opsKp]);
}

// ---------- graduated path ----------
/** Claim everything (curve sweep + collect_v2, pool sweep + AMM collect) into the burn wallet. Ops pays. */
async function buildGraduatedClaimTx({ mint, burnKp, opsKp, state }) {
  const mintPk = pk(mint);
  const burn = burnKp.publicKey;
  const conn = connection();
  const online = new OnlinePumpSdk(conn);
  const ixs = [...budgetIxs(300000)];
  const { curve, vaultLamports } = state;
  if (curve && !curve.creatorFee.isZero()) {
    ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer: opsKp.publicKey, mint: mintPk, creator: burn, quoteMint: NATIVE_MINT }));
  }
  if ((curve && !curve.creatorFee.isZero()) || vaultLamports > RENT_SYSTEM) {
    ixs.push(await offlineProgram.methods.collectCreatorFeeV2().accountsPartial({
      creator: burn, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID, creatorVault: creatorVaultPda(burn),
    }).instruction());
  }
  const poolInfo = await conn.getAccountInfo(canonicalPumpPoolPda(mintPk));
  if (poolInfo) {
    ixs.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer: opsKp.publicKey, mint: mintPk, coinCreator: burn, quoteMint: NATIVE_MINT }));
    ixs.push(...await online.collectCoinCreatorFeeV2Instructions(burn, NATIVE_MINT, TOKEN_PROGRAM_ID, opsKp.publicKey));
    // Ops pays, so the SDK does not close the burn wallet's WSOL ATA; unwrap it ourselves (burn wallet signs).
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, burn, false, TOKEN_PROGRAM_ID);
    ixs.push(createCloseAccountInstruction(wsolAta, burn, burn, [], TOKEN_PROGRAM_ID));
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  return { tx: toV0Tx(opsKp.publicKey, ixs, blockhash, [opsKp, burnKp]), blockhash, lastValidBlockHeight };
}

/** Jupiter Swap v2: SOL -> mint, taker = burn wallet. Returns { sig } or throws. */
async function jupiterBuy({ mint, burnKp, lamports }) {
  const key = process.env.JUPITER_API_KEY;
  if (!key) throw new Error("JUPITER_API_KEY not set");
  const headers = { "x-api-key": key, "Content-Type": "application/json" };
  const q = new URLSearchParams({
    inputMint: NATIVE_MINT.toBase58(), outputMint: pk(mint).toBase58(), amount: String(lamports),
    taker: burnKp.publicKey.toBase58(), slippageBps: "300",
  });
  const orderRes = await fetch(`https://api.jup.ag/swap/v2/order?${q}`, { headers });
  if (!orderRes.ok) throw new Error(`jupiter order ${orderRes.status}: ${await orderRes.text()}`);
  const order = await orderRes.json();
  if (!order.transaction || !order.requestId) throw new Error("jupiter order missing transaction/requestId");
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([burnKp]);
  const execRes = await fetch("https://api.jup.ag/swap/v2/execute", {
    method: "POST", headers,
    body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString("base64"), requestId: order.requestId }),
  });
  if (!execRes.ok) throw new Error(`jupiter execute ${execRes.status}: ${await execRes.text()}`);
  const exec = await execRes.json();
  if (exec.status && String(exec.status).toLowerCase() !== "success") throw new Error(`jupiter execute status ${exec.status}: ${exec.error || ""}`);
  return { sig: exec.signature || exec.txSignature || null, outAmount: exec.outputAmountResult || order.outAmount || null };
}

/** Burn the whole token balance in the burn wallet's ATA (graduated path, separate tx). */
async function buildBurnAllTx({ mint, burnKp, opsKp }) {
  const mintPk = pk(mint);
  const burn = burnKp.publicKey;
  const conn = connection();
  const ata = getAssociatedTokenAddressSync(mintPk, burn, false, TOKEN_2022_PROGRAM_ID);
  const info = await conn.getAccountInfo(ata);
  if (!info) throw new Error("no token account to burn from");
  const amount = unpackAccount(ata, info, TOKEN_2022_PROGRAM_ID).amount;
  if (amount <= 0n) throw new Error("token balance is zero");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const ixs = [...budgetIxs(50000), createBurnCheckedInstruction(ata, mintPk, burn, amount, DECIMALS, [], TOKEN_2022_PROGRAM_ID)];
  return { tx: toV0Tx(opsKp.publicKey, ixs, blockhash, [opsKp, burnKp]), blockhash, lastValidBlockHeight, burnAmountRaw: amount };
}

/** Exact SOL spent by the burn wallet and tokens burned, read from a confirmed tx. Null fields when unreadable. */
async function readReceipt(sig, burnWallet, mint) {
  try {
    const tx = await connection().getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx || !tx.meta) return null;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const burnStr = pk(burnWallet).toBase58();
    let solSpent = null;
    for (let i = 0; i < keys.length; i++) {
      if (keys.get(i).toBase58() === burnStr) {
        solSpent = (tx.meta.preBalances[i] - tx.meta.postBalances[i]) / LAMPORTS;
        break;
      }
    }
    // tokens burned = tokens bought (into ATA) - tokens left; from the burn instruction we know exact: use post supply delta if present
    let tokensBurned = null;
    const mintStr = pk(mint).toBase58();
    const pre = (tx.meta.preTokenBalances || []).find((b) => b.mint === mintStr && b.owner === burnStr);
    const post = (tx.meta.postTokenBalances || []).find((b) => b.mint === mintStr && b.owner === burnStr);
    if (pre || post) {
      const preAmt = pre ? Number(pre.uiTokenAmount.uiAmount || 0) : 0;
      const postAmt = post ? Number(post.uiTokenAmount.uiAmount || 0) : 0;
      // bought - burned = post - pre ; we don't know bought here, caller passes burn amount. Return the net to help.
      tokensBurned = { pre: preAmt, post: postAmt };
    }
    return { solSpent, tokensBalance: tokensBurned, fee: tx.meta.fee / LAMPORTS, blockTime: tx.blockTime ? tx.blockTime * 1000 : null };
  } catch {
    return null;
  }
}

module.exports = {
  DECIMALS, LAMPORTS, RENT_SYSTEM,
  loadConfig, buildCreateTx, verifyCreateTx, readCoinStates, snapshot,
  buildClaimBuyBurnTx, buildSeedTx, buildGraduatedClaimTx, jupiterBuy, buildBurnAllTx, readReceipt,
};
