// A small HTTP layer built on node:http (no framework): routing, JSON bodies, static files,
// security headers and rate limiting.
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- routing ----------
export function createRouter() {
  const routes = [];
  const add = (method) => (path, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)')) + '/?$');
    routes.push({ method, re, keys, handlers });
  };
  return {
    get: add('GET'),
    post: add('POST'),
    find(method, pathname) {
      let pathMatched = false;
      for (const route of routes) {
        const match = route.re.exec(pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = {};
        route.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1])));
        return { route, params, pathMatched };
      }
      return { pathMatched };
    },
  };
}

// ---------- rate limiting (in memory, fixed window) ----------
export function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (ctx) => {
    const id = key(ctx);
    const now = Date.now();
    let entry = hits.get(id);
    if (!entry || entry.reset <= now) hits.set(id, (entry = { count: 0, reset: now + windowMs }));
    if (++entry.count > max * config.rateScale) {
      const seconds = Math.ceil((entry.reset - now) / 1000);
      throw new HttpError(429, `Too many requests. Try again in ${seconds} s.`, 'rate_limited');
    }
  };
}

// ---------- helpers ----------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limit = 64 * 1024) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large', 'too_large');
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
    throw new HttpError(415, 'Send JSON (Content-Type: application/json)', 'bad_content_type');
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    return data && typeof data === 'object' ? data : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON', 'bad_json');
  }
}

function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(root, pathname, res) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (relative.endsWith('/')) relative += 'index.html';
  const file = normalize(join(root, relative));
  if (!file.startsWith(root + sep)) throw new HttpError(403, 'Forbidden');
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new HttpError(404, 'Not found', 'not_found');
  }
  if (!info.isFile()) throw new HttpError(404, 'Not found', 'not_found');
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// ---------- request handler ----------
export function createHandler({ router, publicDir }) {
  return async (req, res) => {
    securityHeaders(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        return await serveStatic(publicDir, url.pathname, res);
      }
      const { route, params, pathMatched } = router.find(req.method, url.pathname);
      if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found', 'not_found');
      const ctx = {
        req,
        params,
        query: Object.fromEntries(url.searchParams),
        body: await readJsonBody(req),
        ip: clientIp(req),
        user: null,
        status: 200,
      };
      for (const handler of route.handlers) {
        const out = await handler(ctx);
        if (out !== undefined) return sendJson(res, ctx.status, out);
      }
      throw new HttpError(500, 'Handler returned nothing');
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) {
        return sendJson(res, error.status, { error: { message: error.message, code: error.code } });
      }
      console.error('[http]', error);
      sendJson(res, 500, { error: { message: 'Something went wrong on the server', code: 'server_error' } });
    }
  };
}
