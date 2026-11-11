# OSC 7501: program status, as the agent bridge reads it

A program in a terminal reports what it is doing in an escape sequence the terminal doesn't print.
This is the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status)
as `src/program-status.ts` implements it (the rules CodeShellManager uses too). Claude Code speaks it; so
can any CLI, with `src/emit.ts`.

## The handshake

1. At start the program writes the probe, `ESC ] 7501 ; ? ST`, and right after it a DA1 query, `ESC [ c`.
2. A terminal that knows 7501 answers the probe with the same sequence, `ESC ] 7501 ; ? ESC \`, **before**
   its DA1 answer (`ESC [ ? 1 ; 2 c`). The DA1 is the program's "no more replies" sentinel: if the DA1 answer
   arrives first, the terminal doesn't speak 7501, and the program stays quiet.
3. The bridge answers both itself, in stream order, before any viewer could (`OscScanner` finds them in the
   output). Windows: only node-pty's bundled ConPTY passes the OSC through to the program's input; the one
   in Windows drops it and answers DA1 itself, first, so Claude Code never reports (`useConptyDll: true`).

## A report

`ESC ] 7501 ; key=value:key=value… ST` (ST is `ESC \`; BEL is accepted too). At most 4096 bytes in all.

| Key | Value | Rules |
|---|---|---|
| `state` | `idle`, `working`, `done`, `blocked`, `error`, `clear` | required; anything else drops the report |
| `kind` | `permission`, `question`, `auth` | only with `blocked`, else ignored |
| `progress` | `0`–`100` | absent: indeterminate |
| `app` | `[A-Za-z0-9_.+-]{1,32}` | the program's name (`claude-code`); bad: ignored |
| `id` | segments as `app`, `/`-separated, ≤ 8 deep, ≤ 128 bytes | a record; absent: the root record; bad: report dropped |
| `msg` | standard base64 of UTF-8, ≤ 2048 bytes decoded | one line: a control or line break drops the report; invisible format characters are stripped |
| `title` | as `msg`, ≤ 192 bytes | |

Keys are lower-case letters, ≤ 16 characters (longer: report dropped); unknown keys are ignored; values use
`[A-Za-z0-9_.,+/=-]` (others: that pair ignored); a repeated key: the last wins. Everything is untrusted output:
a report that breaks a rule is dropped whole, never partly applied.

## Records and the status shown

Each report replaces its record (by `id`); `clear` removes a record and its children, or all without an `id`.
The status shown is the record with the highest rank, **blocked > working > error > done > idle**; ties go to the
root record, then the newest. When the program ends, or a new prompt starts, working, blocked and idle records go;
done and error stay until someone looks (`acknowledge`). A program that never reported: output activity stands in
(working while output came in the last 1.5 s).

## Emitting

```js
import { programStatus } from '@umage.ai/agent-bridge/emit';
const status = programStatus({ app: 'my-cli' });
await status.detect();            // optional: true when the terminal answered the probe first
status.working('Reading files', { progress: 20 });
status.blocked('permission', 'Edit src/App.tsx?');
status.done('Changed 3 files');
```

`report7501(state, fields)` returns the sequence as a string. Values are cleaned before sending (a line break
becomes a space, `msg` is cut to 2048 bytes, a bad `app` is left out), so the bridge never drops a report.
