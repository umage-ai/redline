// The other end of OSC 7501 (PROTOCOL-7501.md): a small emitter a CLI imports to report its status to
// the terminal it runs in. No dependencies; Node only (it writes to a stream, reads the answer from stdin).
//
//   import { programStatus } from '@umage.ai/agent-bridge/emit';
//   const status = programStatus({ app: 'my-cli' });
//   if (await status.detect()) { … }       // optional: the terminal answered the probe
//   status.working('Reading files'); … status.done('Changed 3 files');
//
// Without detect(), reports are written anyway: a terminal that doesn't know 7501 ignores an OSC it
// doesn't recognise. Values are checked here the way the bridge checks them, so a report is never dropped.

import type { Readable, Writable } from 'node:stream';

const ESC = '\x1b', ST = ESC + '\\';
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;

export type EmitState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export interface EmitFields { msg?: string; title?: string; progress?: number; kind?: 'permission' | 'question' | 'auth'; id?: string }

/** One report as the escape sequence to write: `ESC ] 7501 ; state=working:app=x:msg=<base64> ESC \`. */
export function report7501(state: EmitState | 'clear', fields: EmitFields & { app?: string } = {}): string {
  const pairs = [`state=${state}`];
  if (fields.app && SEGMENT.test(fields.app)) pairs.push(`app=${fields.app}`);
  if (fields.id && fields.id.split('/').length <= 8 && fields.id.split('/').every(s => SEGMENT.test(s))) pairs.push(`id=${fields.id}`);
  if (state === 'blocked' && fields.kind) pairs.push(`kind=${fields.kind}`);
  if (fields.progress !== undefined && Number.isInteger(fields.progress) && fields.progress >= 0 && fields.progress <= 100) pairs.push(`progress=${fields.progress}`);
  for (const [key, max] of [['msg', 2048], ['title', 192]] as const) {
    const v = fields[key];
    if (!v) continue;
    // One line, no controls, at most `max` bytes of UTF-8 (cut on a character boundary).
    let text = v.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
    while (Buffer.byteLength(text) > max) text = [...text].slice(0, -1).join('');
    if (text) pairs.push(`${key}=${Buffer.from(text, 'utf8').toString('base64')}`);
  }
  return `${ESC}]7501;${pairs.join(':')}${ST}`;
}

/** The probe a program sends at start, and the DA1 query it sends right after as the "no more replies" sentinel. */
export const PROBE = `${ESC}]7501;?${ST}${ESC}[c`;

export interface ProgramStatusOptions { app?: string; out?: Writable; input?: Readable }

/** A reporter bound to one program (`app`) and output stream (stdout). */
export function programStatus(o: ProgramStatusOptions = {}) {
  const out = o.out ?? process.stdout;
  const send = (state: EmitState | 'clear', f: EmitFields = {}) => { out.write(report7501(state, { ...f, app: o.app })); };
  return {
    /**
     * Asks the terminal whether it speaks 7501: true when its answer comes before the DA1 answer,
     * false on the DA1 answer alone or after `ms`. Reads `input` (stdin, put in raw mode by the caller).
     */
    detect(ms = 1000): Promise<boolean> {
      const input = o.input ?? process.stdin;
      return new Promise(resolve => {
        let buf = '';
        const done = (v: boolean) => { clearTimeout(timer); input.off('data', on); resolve(v); };
        const on = (d: Buffer | string) => {
          buf += d.toString();
          if (buf.includes(`${ESC}]7501;?`)) done(true);
          else if (/\x1b\[\?[\d;]*c/.test(buf)) done(false);
        };
        const timer = setTimeout(() => done(false), ms);
        input.on('data', on);
        out.write(PROBE);
      });
    },
    idle: (f?: EmitFields) => send('idle', f),
    working: (msg?: string, f?: EmitFields) => send('working', { ...f, msg }),
    done: (msg?: string, f?: EmitFields) => send('done', { ...f, msg }),
    error: (msg?: string, f?: EmitFields) => send('error', { ...f, msg }),
    blocked: (kind: 'permission' | 'question' | 'auth', msg?: string, f?: EmitFields) => send('blocked', { ...f, kind, msg }),
    /** Removes a record (and its children), or every record without `id`. */
    clear: (id?: string) => send('clear', id ? { id } : {}),
  };
}
