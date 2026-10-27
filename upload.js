"use strict";
// POST /api/upload  multipart: name, symbol, description, image, twitter?, telegram?, website?
// -> { ok, uri, image }   (image + metadata JSON pinned to Filebase IPFS)
const { ok, fail, methodGuard, readMultipart, HttpError } = require("../lib/http");

const MAX_IMAGE = 4 * 1024 * 1024;
const SYMBOL_RE = /^[A-Z0-9]{1,13}$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

async function filebaseAdd(buf, filename, contentType) {
  const token = process.env.FILEBASE_IPFS_TOKEN;
  if (!token) throw new HttpError(500, "FILEBASE_IPFS_TOKEN not set");
  const form = new FormData();
  form.append("file", new Blob([buf], { type: contentType }), filename);
  const r = await fetch("https://rpc.filebase.io/api/v0/add?cid-version=1", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await r.text();
  if (!r.ok) throw new HttpError(502, `filebase ${r.status}: ${text.slice(0, 200)}`);
  // Response is JSON (possibly one line per file). Take the last line with a Hash.
  let cid = null;
  for (const line of text.trim().split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j.Hash) cid = j.Hash;
    } catch { /* ignore */ }
  }
  if (!cid) throw new HttpError(502, "filebase: no CID in response");
  return `https://ipfs.filebase.io/ipfs/${cid}`;
}

function cleanUrl(v, max = 200) {
  const s = String(v || "").trim().slice(0, max);
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

module.exports = async (req, res) => {
  if (!methodGuard(req, res, "POST")) return;
  try {
    const { fields, files } = await readMultipart(req, MAX_IMAGE + 64 * 1024);
    const name = String(fields.name || "").trim();
    const symbol = String(fields.symbol || "").trim().toUpperCase();
    const description = String(fields.description || "").trim().slice(0, 1000);
    if (!name || name.length > 32) return fail(res, 400, "name must be 1-32 chars");
    if (!SYMBOL_RE.test(symbol)) return fail(res, 400, "symbol must match ^[A-Z0-9]{1,13}$");
    const img = files.image;
    if (!img || !img.data || !img.data.length) return fail(res, 400, "image required");
    if (img.data.length > MAX_IMAGE) return fail(res, 413, "image must be <= 4MB");
    if (!IMAGE_TYPES.has(String(img.type).toLowerCase())) return fail(res, 400, "image must be png/jpg/gif/webp");

    const ext = (img.filename && img.filename.split(".").pop()) || "png";
    const image = await filebaseAdd(img.data, `${symbol.toLowerCase()}.${ext.slice(0, 5)}`, img.type);

    const meta = {
      name, symbol, description, image, showName: true,
      twitter: cleanUrl(fields.twitter), telegram: cleanUrl(fields.telegram), website: cleanUrl(fields.website),
    };
    for (const k of ["twitter", "telegram", "website"]) if (!meta[k]) delete meta[k];
    const uri = await filebaseAdd(Buffer.from(JSON.stringify(meta)), "metadata.json", "application/json");
    if (uri.length > 200) return fail(res, 500, "metadata uri too long");
    return ok(res, { uri, image });
  } catch (e) {
    console.error("[upload]", e);
    return fail(res, e.status || 500, e.message || "upload failed");
  }
};

module.exports.config = { api: { bodyParser: false } };
