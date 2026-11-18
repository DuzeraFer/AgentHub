'use strict';
// Tiny local HTTP server that Claude Code hooks POST to.
// POST /hook/<EventName>  body = the hook's JSON input  ->  responds with hook JSON output.

const http = require('node:http');

const DEFAULT_PORT = 47821;
const HOLD_LIMIT_MS = 9.5 * 60 * 1000; // hooks are configured with a 600s timeout

function startServer(store, { port = DEFAULT_PORT, host = '127.0.0.1', usage = null } = {}) {
  const server = http.createServer((req, res) => {
    // Glance's status line command forwards Claude Code's status line JSON here.
    if (req.method === 'POST' && /^\/usage\/?$/.test(req.url || '')) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on('end', () => {
        try {
          if (usage) usage.ingestStatusLine(JSON.parse(body));
        } catch {}
        res.writeHead(204);
        res.end();
      });
      return;
    }
    const match = /^\/hook\/([A-Za-z]+)\/?$/.exec(req.url || '');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'glance' }));
      return;
    }
    if (req.method !== 'POST' || !match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const event = match[1];
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy();
    });
    req.on('end', async () => {
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = {};
      }
      if (payload && typeof payload === 'object') payload._host = String(req.headers['x-glance-host'] || '');
      let result;
      try {
        result = store.handle(event, payload);
      } catch (err) {
        result = {};
      }

      if (result && typeof result.then === 'function') {
        const requestId = result.requestId;
        const timer = setTimeout(() => store.cancel(requestId), HOLD_LIMIT_MS);
        res.on('close', () => {
          // Hook process was killed (timeout / Ctrl-C): drop the card.
          if (!res.writableEnded) store.cancel(requestId);
        });
        result = await result;
        clearTimeout(timer);
      }
      if (res.writableEnded || res.destroyed) return;
      const out = result && Object.keys(result).length ? JSON.stringify(result) : '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(out);
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { startServer, DEFAULT_PORT };
