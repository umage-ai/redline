// Small HTTP helpers for the bridge's routes (copies of the host's, so the bridge stands alone).

import type { IncomingMessage, ServerResponse } from 'node:http';

export function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** The request body as text; rejects (and drops the connection) past `max` bytes. */
export function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
const LOCAL_HOST = /^(localhost|[^:/]+\.localhost|127(\.\d+){3}|\[::1\])(:\d+)?$/i;

/**
 * A caller on this machine: a loopback peer that asked for a loopback host name (a DNS-rebound name
 * that resolves to 127.0.0.1 still says its own name in Host). Built in, not an option (D63).
 */
export function isLocal(req: IncomingMessage): boolean {
  if (!LOOPBACK.test(req.socket?.remoteAddress ?? '')) return false;
  const h = req.headers;
  const host = String(h['x-forwarded-host'] ?? h.host ?? '').split(',')[0].trim();
  return LOCAL_HOST.test(host);
}

/** A page on another origin: an Origin header that isn't this server's own host. */
export function foreignOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}
