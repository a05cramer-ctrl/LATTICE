"use strict";
// LATTICE state store: Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN) with an
// in-memory fallback so local dev never crashes. Keys:
//   coin:<mint>      hash   one coin record (see api/state.js shape)
//   coins            zset   mint scored by createdAt
//   burns:<mint>     list   JSON burn receipts, newest first
//   burns:recent     list   JSON {mint,symbol,sig,sol,tokens,ts}, newest first, capped at 50
//   stats            hash   coins, burns, solBurned (lamports), tokensBurned (raw units)
//   pending:<mint>   string JSON launch draft from build-create (TTL 1h)
//   lock:tick        string NX lock so two ticks never overlap

const RECENT_CAP = 50;

let client = null;
let memory = null;

function hasUpstash() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function redis() {
  if (client) return client;
  const { Redis } = require("@upstash/redis");
  client = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
    automaticDeserialization: false,
  });
  return client;
}

// ---------- in-memory fallback (per process; fine for `vercel dev` / tests) ----------
function mem() {
  if (memory) return memory;
  if (!process.env.LATTICE_SILENT_KV) {
    console.warn("[kv] KV_REST_API_URL/KV_REST_API_TOKEN missing - using in-memory store");
  }
  memory = { hashes: new Map(), zsets: new Map(), lists: new Map(), strings: new Map() };
  return memory;
}

const memBackend = {
  async hgetall(key) {
    const h = mem().hashes.get(key);
    return h ? { ...h } : null;
  },
  async hset(key, obj) {
    const m = mem();
    const h = m.hashes.get(key) || {};
    for (const [k, v] of Object.entries(obj)) h[k] = String(v);
    m.hashes.set(key, h);
  },
  async hincrby(key, field, n) {
    const m = mem();
    const h = m.hashes.get(key) || {};
    h[field] = String(BigInt(h[field] || "0") + BigInt(n));
    m.hashes.set(key, h);
    return h[field];
  },
  async zadd(key, score, member) {
    const m = mem();
    const z = m.zsets.get(key) || new Map();
    z.set(member, score);
    m.zsets.set(key, z);
  },
  async zrevrange(key) {
    const z = mem().zsets.get(key);
    if (!z) return [];
    return [...z.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  },
  async lpush(key, value, cap) {
    const m = mem();
    const l = m.lists.get(key) || [];
    l.unshift(value);
    if (cap && l.length > cap) l.length = cap;
    m.lists.set(key, l);
  },
  async lrange(key, start, stop) {
    const l = mem().lists.get(key) || [];
    return l.slice(start, stop === -1 ? undefined : stop + 1);
  },
  async get(key) {
    const e = mem().strings.get(key);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) {
      mem().strings.delete(key);
      return null;
    }
    return e.v;
  },
  async set(key, value, opts = {}) {
    const m = mem();
    if (opts.nx && (await this.get(key)) !== null) return null;
    m.strings.set(key, { v: value, exp: opts.ex ? Date.now() + opts.ex * 1000 : 0 });
    return "OK";
  },
  async del(key) {
    mem().strings.delete(key);
  },
};

const upstashBackend = {
  async hgetall(key) {
    const r = await redis().hgetall(key);
    return r && Object.keys(r).length ? r : null;
  },
  async hset(key, obj) {
    const flat = {};
    for (const [k, v] of Object.entries(obj)) flat[k] = String(v);
    await redis().hset(key, flat);
  },
  async hincrby(key, field, n) {
    return redis().hincrby(key, field, Number(n));
  },
  async zadd(key, score, member) {
    await redis().zadd(key, { score, member });
  },
  async zrevrange(key) {
    return redis().zrange(key, 0, -1, { rev: true });
  },
  async lpush(key, value, cap) {
    await redis().lpush(key, value);
    if (cap) await redis().ltrim(key, 0, cap - 1);
  },
  async lrange(key, start, stop) {
    return redis().lrange(key, start, stop);
  },
  async get(key) {
    return redis().get(key);
  },
  async set(key, value, opts = {}) {
    const o = {};
    if (opts.nx) o.nx = true;
    if (opts.ex) o.ex = opts.ex;
    return redis().set(key, value, o);
  },
  async del(key) {
    await redis().del(key);
  },
};

function backend() {
  return hasUpstash() ? upstashBackend : memBackend;
}

// ---------- coin records ----------
const NUM_FIELDS = [
  "createdAt", "intervalSec", "lastBurnAt", "lastAttemptAt", "nextBurnAt", "burnCount",
  "pendingLamports", "mcapSol", "totalSolBurned", "totalTokensBurned", "latticeBalance",
];
const BOOL_FIELDS = ["complete"];

function parseCoin(h) {
  if (!h) return null;
  const c = { ...h };
  for (const f of NUM_FIELDS) if (f in c) c[f] = Number(c[f]);
  for (const f of BOOL_FIELDS) if (f in c) c[f] = c[f] === "true" || c[f] === "1";
  return c;
}

async function getCoin(mint) {
  return parseCoin(await backend().hgetall(`coin:${mint}`));
}

async function putCoin(coin) {
  const b = backend();
  await b.hset(`coin:${coin.mint}`, coin);
  await b.zadd("coins", Number(coin.createdAt) || Date.now(), coin.mint);
}

async function updateCoin(mint, patch) {
  await backend().hset(`coin:${mint}`, patch);
}

async function listCoins() {
  const b = backend();
  const mints = await b.zrevrange("coins");
  const out = [];
  for (const m of mints) {
    const c = parseCoin(await b.hgetall(`coin:${m}`));
    if (c) out.push(c);
  }
  return out;
}

// ---------- burns ----------
async function addBurn(burn) {
  // burn: {mint, symbol, sig, sol, tokens, ts, buySig?}
  const b = backend();
  const s = JSON.stringify(burn);
  await b.lpush(`burns:${burn.mint}`, s);
  await b.lpush("burns:recent", s, RECENT_CAP);
}

function parseList(rows) {
  return (rows || []).map((r) => {
    try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
  }).filter(Boolean);
}

async function getBurns(mint, limit = 200) {
  return parseList(await backend().lrange(`burns:${mint}`, 0, limit - 1));
}

async function recentBurns() {
  return parseList(await backend().lrange("burns:recent", 0, RECENT_CAP - 1));
}

// ---------- stats ----------
async function getStats() {
  const h = (await backend().hgetall("stats")) || {};
  return {
    coins: Number(h.coins || 0),
    burns: Number(h.burns || 0),
    solBurned: Number(h.solBurnedLamports || 0) / 1e9,
    tokensBurned: Number(h.tokensBurnedRaw || 0) / 1e6,
  };
}

async function incrStats({ coins = 0, burns = 0, solBurnedLamports = 0, tokensBurnedRaw = 0 }) {
  const b = backend();
  if (coins) await b.hincrby("stats", "coins", coins);
  if (burns) await b.hincrby("stats", "burns", burns);
  if (solBurnedLamports) await b.hincrby("stats", "solBurnedLamports", Math.round(solBurnedLamports));
  if (tokensBurnedRaw) await b.hincrby("stats", "tokensBurnedRaw", Math.round(tokensBurnedRaw));
}

// ---------- pending launches ----------
async function putPending(mint, obj) {
  await backend().set(`pending:${mint}`, JSON.stringify(obj), { ex: 3600 });
}
async function getPending(mint) {
  const v = await backend().get(`pending:${mint}`);
  if (!v) return null;
  try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
}
async function delPending(mint) {
  await backend().del(`pending:${mint}`);
}

// ---------- tick lock ----------
async function acquireLock(name, ttlSec) {
  const r = await backend().set(`lock:${name}`, String(Date.now()), { nx: true, ex: ttlSec });
  return r === "OK" || r === true;
}
async function releaseLock(name) {
  await backend().del(`lock:${name}`);
}

module.exports = {
  hasUpstash,
  getCoin, putCoin, updateCoin, listCoins,
  addBurn, getBurns, recentBurns,
  getStats, incrStats,
  putPending, getPending, delPending,
  acquireLock, releaseLock,
};
