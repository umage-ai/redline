// Running dev servers, so `redline mcp` can reach them (D22): <root>/<dir>/servers.json.
// A dev server registers its URL when it starts listening (Vite) or on its first
// /__redline request (any server: the Host header tells us). Dead entries are pruned
// by pid; the MCP server still checks each URL before using it.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ServerEntry { url: string; app: string; pid: number; at: string }

const file = (root: string, dir: string) => path.join(root, dir, 'servers.json');

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export async function readServers(root: string, dir = '.redline'): Promise<ServerEntry[]> {
  try {
    const list = JSON.parse(await fs.readFile(file(root, dir), 'utf8')) as ServerEntry[];
    return Array.isArray(list) ? list.filter(s => s && typeof s.url === 'string' && alive(s.pid)) : [];
  } catch { return []; }
}

let queue: Promise<unknown> = Promise.resolve();

/** Add or refresh this process's entry for `url`. Never throws: discovery is best effort. */
export function registerServer(root: string, dir: string, url: string, app: string): Promise<void> {
  const run = queue.then(async () => {
    try {
      const list = (await readServers(root, dir)).filter(s => s.url !== url);
      list.push({ url: url.replace(/\/+$/, ''), app, pid: process.pid, at: new Date().toISOString() });
      await fs.mkdir(path.join(root, dir), { recursive: true });
      await fs.writeFile(file(root, dir), JSON.stringify(list, null, 2) + '\n');
    } catch { /* read-only checkout etc. */ }
  });
  queue = run;
  return run;
}
