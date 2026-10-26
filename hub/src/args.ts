// The CLI's arguments and its warning for a hub reachable from other machines (cli.ts).

import { VERSION } from './server.ts';

export const HELP = `redline-hub ${VERSION}: a shared store for Redline notes, with projects, tokens, MCP and a UI.

Usage: redline-hub [serve] [options]
       redline-hub reset-admin [--db <file>]

Options:
  --port <n>          Port (default 4780; 0 picks a free one)
  --host <addr>       Address to listen on (default 127.0.0.1, this machine only)
  --db <file>         SQLite database (default ./redline-hub.db)
  --public-url <url>  The hub's address as others reach it (behind a proxy or tunnel)
  -h, --help          This help

Then point a dev server at a project:  REDLINE_STORE_URL=<hub>/p/<project>  REDLINE_STORE_TOKEN=<token>
`;

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i;

/** The warning for a hub reachable from other machines, or null on loopback. */
export function hostWarning(host: string): string | null {
  if (LOOPBACK.test(host)) return null;
  return [
    `⚠  redline-hub is listening on ${host}: anyone who can reach this machine can reach it.`,
    '   Tokens guard the notes, but the hub speaks plain HTTP and has no SSO, rate limits or backups.',
    '   Keep it on a private network (VPN) and put HTTPS in front (a reverse proxy or tunnel), then pass --public-url.',
  ].join('\n');
}

export function parseArgs(argv: string[]) {
  const o = { cmd: 'serve', port: 4780, host: '127.0.0.1', db: 'redline-hub.db', publicUrl: undefined as string | undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--port') { o.port = Number(val()); if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port takes 0-65535'); }
    else if (a === '--host') o.host = val();
    else if (a === '--db') o.db = val();
    else if (a === '--public-url') { o.publicUrl = val(); if (!/^https?:\/\//.test(o.publicUrl)) throw new Error('--public-url must start with http:// or https://'); }
    else if (a === 'serve' || a === 'reset-admin') o.cmd = a;
    else throw new Error(`unknown argument ${a} (see --help)`);
  }
  return o;
}
