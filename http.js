"use strict";
// Tiny helpers for Vercel Node functions (req, res): JSON responses, body parsing, multipart.

function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!headers["Cache-Control"]) res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function ok(res, obj, headers) {
  return send(res, 200, { ok: true, ...obj }, headers);
}

function fail(res, status, error) {
  return send(res, status, { ok: false, error: String(error && error.message ? error.message : error) });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function methodGuard(req, res, method) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return false;
  }
  if (req.method !== method) {
    fail(res, 405, `use ${method}`);
    return false;
  }
  return true;
}

async function readRawBody(req, limitBytes = 5 * 1024 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    // Vercel may have parsed it already.
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === "string") return Buffer.from(req.body);
    return Buffer.from(JSON.stringify(req.body));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRawBody(req, 1024 * 1024);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/**
 * Minimal multipart/form-data parser. Returns { fields: {name: string}, files: {name: {filename, type, data}} }.
 */
async function readMultipart(req, limitBytes = 4.5 * 1024 * 1024) {
  const ct = String(req.headers["content-type"] || "");
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!/multipart\/form-data/i.test(ct) || !m) throw new HttpError(400, "expected multipart/form-data");
  const boundary = Buffer.from("--" + (m[1] || m[2]).trim());
  const body = await readRawBody(req, limitBytes);

  const fields = {};
  const files = {};
  let pos = body.indexOf(boundary);
  if (pos < 0) throw new HttpError(400, "malformed multipart body");
  pos += boundary.length;
  for (;;) {
    // after boundary: either "--" (end) or CRLF then part
    if (body.slice(pos, pos + 2).toString() === "--") break;
    if (body.slice(pos, pos + 2).toString() === "\r\n") pos += 2;
    const headerEnd = body.indexOf("\r\n\r\n", pos);
    if (headerEnd < 0) break;
    const headerText = body.slice(pos, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    const next = body.indexOf(boundary, dataStart);
    if (next < 0) break;
    let dataEnd = next;
    if (body.slice(dataEnd - 2, dataEnd).toString() === "\r\n") dataEnd -= 2;
    const data = body.slice(dataStart, dataEnd);

    const nameM = /name="([^"]*)"/i.exec(headerText);
    const fileM = /filename="([^"]*)"/i.exec(headerText);
    const typeM = /content-type:\s*([^\r\n]+)/i.exec(headerText);
    const name = nameM ? nameM[1] : "";
    if (fileM) {
      files[name] = { filename: fileM[1], type: typeM ? typeM[1].trim() : "application/octet-stream", data };
    } else {
      fields[name] = data.toString("utf8");
    }
    pos = next + boundary.length;
  }
  return { fields, files };
}

function requireCronAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new HttpError(500, "CRON_SECRET not set");
  const h = req.headers || {};
  const key = h["x-cron-key"];
  const auth = String(h["authorization"] || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (key === secret || bearer === secret) return true;
  throw new HttpError(401, "unauthorized");
}

module.exports = { send, ok, fail, HttpError, methodGuard, readRawBody, readJson, readMultipart, requireCronAuth };
