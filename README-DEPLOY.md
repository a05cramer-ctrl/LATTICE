# LATTICE backend — deploy notes

Vercel project, Node 20, CommonJS. `api/*.js` are the functions, `lib/*.js` shared code. Frontend is `index.html` + `config.js`.

## Env vars (names only — set values in Vercel → Settings → Environment Variables)

| Name | What |
| --- | --- |
| `HELIUS_API_KEY` | Helius mainnet RPC key |
| `OPS_WALLET_SECRET` | base58 secret key of the ops wallet. Pays tick tx fees + seeds each burn wallet with 0.003 SOL once. Keep ~0.2 SOL in it. |
| `BURN_MASTER_SEED` | long random string (>=32 chars). Every coin's burn wallet is derived from it: `Keypair.fromSeed(HMAC-SHA512(seed, mint)[0..32])`. Losing it = losing access to burn wallets. Never rotate after launch. |
| `CRON_SECRET` | random string; the tick endpoint requires it |
| `FILEBASE_IPFS_TOKEN` | Filebase IPFS RPC bearer token (image + metadata pinning) |
| `KV_REST_API_URL` | Upstash Redis REST url (Vercel Marketplace → Upstash sets both) |
| `KV_REST_API_TOKEN` | Upstash Redis REST token |
| `JUPITER_API_KEY` | Jupiter Swap v2 key (`x-api-key`), only used after a coin graduates |
| `LATTICE_MINT` | the $LATTICE CA once live; unset = everyone is tier 0 (180 s) |
| `SITE_URL` | https://… of the deployed site (used by the frontend copy; optional for the API) |
| `MIN_BURN_LAMPORTS` | optional, default `5000000` (0.005 SOL). A burn is skipped below this (“waiting for fees”). |
| `CU_PRICE_MICRO` | optional priority fee per CU, default `100000` |

Without `KV_REST_API_URL`/`KV_REST_API_TOKEN` the API falls back to an in-memory store (local dev only — every function invocation on Vercel is a fresh process, so data would vanish).

## Cron (the tick)

`vercel.json` declares `* * * * *` → `/api/tick`. Vercel sends `Authorization: Bearer <CRON_SECRET>` automatically when `CRON_SECRET` is set.

**Hobby plan crons only run once per day.** On Hobby, use cron-job.org instead:

1. cron-job.org → Create cronjob → URL `https://<your-domain>/api/tick`
2. Schedule: every 1 minute
3. Request method: `POST`
4. Advanced → Headers: `x-cron-key: <CRON_SECRET value>`
5. Timeout 30 s, enable “save responses” to see `{ok,processed,burned}`

Each tick: refreshes every coin's curve snapshot (batched `getMultipleAccountsInfo`, 3 keys per coin), then for coins whose timer is due it sends one tx per coin (max 8 per tick, ~24 s budget). Confirmations finish in the background (`waitUntil`) and the receipt is written only after the tx confirms.

## How the burn receipt proves itself on Solscan

Open `lastSig` / a `recent[].sig` on solscan.io. One transaction shows, in order:

1. `Pump: sweep_creator_fee` — moves the creator fee sitting on the bonding curve to the creator vault of the burn wallet
2. `Pump: collect_creator_fee_v2` — pays the vault out to the **burn wallet** (the coin's `creator` field on the curve is the burn wallet — visible on the mint's pump.fun page / `create_v2` tx)
3. `Pump: buy_exact_quote_in_v3` — the burn wallet spends that SOL on the curve
4. `Token-2022: BurnChecked` — the bought tokens are destroyed; the mint's supply drops by that amount

The burn wallet is derived from the mint and no one holds its key in plain form (only the master seed on the server), the platform takes 0%, and the launcher never touches the fees — every step is on one signature.

## Local dev

```
npm i
vercel dev
```
`node lib/_selftest.js` runs the offline checks (wallet derivation, tiers, instruction building).
