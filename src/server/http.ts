// Small HTTP helpers shared by the dev-server handler and the remote store protocol.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Default cap on a request body: screenshots travel inside it. */
export const MAX_BODY = 30 * 1024 * 1024;

export function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** The request body as text; rejects (and drops the connection) past `max` bytes. */
export function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string> {
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
