#!/usr/bin/env node
// `redline-hub`: one shared place for a team's Redline notes (D44). Localhost by default.
//
//   npx @umage.ai/redline-hub                   # http://127.0.0.1:4780, data in ./redline-hub.db
//   npx @umage.ai/redline-hub --host 0.0.0.0    # reachable from other machines (warns)
//   npx @umage.ai/redline-hub reset-admin       # print a new admin key

import path from 'node:path';
import { openDb } from './db.ts';
import { createHub, VERSION } from './server.ts';
import { HELP, hostWarning, parseArgs } from './args.ts';

// node:sqlite still announces itself as experimental on Node 22-24; that line is noise here.
function quietSqliteWarning() {
  const emit = process.emitWarning.bind(process);
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (String((w as Error)?.message ?? w).includes('SQLite')) return;
    return (emit as (...a: unknown[]) => void)(w, ...rest);
  }) as typeof process.emitWarning;
}

async function main() {
  let o: ReturnType<typeof parseArgs>;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`redline-hub: ${(e as Error).message}`); process.exit(2); }
  if (o.help) { process.stdout.write(HELP); return; }
  quietSqliteWarning();
  if (!process.getBuiltinModule?.('node:sqlite')) {
    console.error(`redline-hub needs Node 22.13 or later (node:sqlite); this is ${process.version}.`);
    process.exit(1);
  }
  const file = path.resolve(o.db);
  const db = openDb(file);

  if (o.cmd === 'reset-admin') {
    console.log(`New admin key (the old one and its sessions stop working):\n\n  ${db.adminKey(true)}\n`);
    db.close();
    return;
  }

  const key = db.adminKey();
  const hub = createHub({ db, publicUrl: o.publicUrl });
  try { await hub.listen(o.port, o.host); } catch (e) {
    console.error(`redline-hub: cannot listen on ${o.host}:${o.port}: ${(e as Error).message}`);
    process.exit(1);
  }
  const warn = hostWarning(o.host);
  console.log(`\n  Redline hub ${VERSION}  ${hub.publicUrl}\n  Data: ${file}\n`);
  if (key) console.log(`  Admin key (shown once; keep it):  ${key}\n  Sign in:  ${hub.publicUrl}/#key=${key}\n`);
  else console.log('  Sign in with the admin key printed at first start (lost it? redline-hub reset-admin).\n');
  if (warn) console.warn(warn + '\n');

  const stop = () => { db.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
