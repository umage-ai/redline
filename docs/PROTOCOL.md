# Remote store protocol

Last updated: 2026-10-26 · Cap: 200 lines · The contract a hosted note store implements (D40–D42).

Redline keeps notes as markdown in the repo by default. A **remote store** keeps them on another
server instead, so everyone reviewing the same app sees the same notes, live. The dev server (or the
app's own server, through `redlineMiddleware` or the .NET package) is the client: it holds the token
and makes the calls. The browser keeps talking to `/__redline` on its own origin, so the token never
reaches the page and no CORS is needed.

```
browser ──/__redline/*──▶ your server (Redline middleware) ──HTTPS + Bearer──▶ remote store
```

Which setup needs a remote store, and when to build your own: [SETUPS.md](SETUPS.md) (setups 2–4).

Use one:

- Node: `redline({ store: remoteStore({ url, token }) })` (from `@umage.ai/redline/server`), or set
  `REDLINE_STORE_URL` and `REDLINE_STORE_TOKEN` in the dev server's environment and change nothing else.
- .NET: `o.UseRemoteStore(url, token)`.
- Reference server: `notesProtocol(store, { base, authorize, unauthorized })` serves this protocol over
  any `NoteStore` (the tests run against it; it also shares one markdown store between dev servers).
  A store refuses with its own words by throwing an error with a 4xx `status`.
- Ready to run: `npx @umage.ai/redline-hub` ([hub/README.md](../hub/README.md), D44): projects,
  personal tokens, MCP per project and a UI, on `notesProtocol`. The store URL is `<hub>/p/<project>`.

## Calls

All under the store's base URL. JSON in and out (`application/json`), except assets and events.
Every call carries `Authorization: Bearer <token>`, or whatever the client forwards for the person behind
the request (`remoteStore({ headers: ctx => … })`, D45): on a site many reviewers share, their own session
or personal token, so the store knows who is asking.

| Call | Answer |
|---|---|
| `GET /version` | `{ "version": "…" }`. Any string that changes whenever a **visible** note changes. Called on every overlay poll (every 2 s while the overlay is open, 6 s otherwise), so keep it cheap |
| `GET /notes` | `{ "version": "…", "notes": [Note…] }`: the notes the caller may see (below) |
| `POST /notes` | Body `{ "note": {…}, "screenshot"?: "data:image/png;base64,…", "sketch"?: "<svg…" }`. Answer: the stored note |
| `PATCH /notes/{id}` | Body: any of `body`, `reply`, `to` (strings), `done`, `seen` (booleans). Answer: the note, or 404 |
| `DELETE /notes/{id}` | `{ "ok": true }`, or 404 |
| `GET /assets/{name}` | The screenshot (`<id>.png`) or sketch (`<id>.svg`), with its content type, or 404 |
| `GET /events` | Optional change feed, below. 404 when there is none |

**Errors.** Any non-2xx answer with `{ "error": "…" }`. The sentence reaches the reviewer as written,
so make it say what to change ("Review notes are switched off for this project"). Use 401 for a
missing or wrong token, 403 for a caller who may not do this, 404 for an unknown note.

**Ids.** Lowercase base36, 4–24 characters (`[a-z0-9]{4,24}`); the overlay routes on them. A store may
keep a valid `note.id` the client sends, or assign its own.

## The note

The same object the markdown anchor holds (`Note` in `src/shared/types.ts`): `id`, `type`
(`comment` / `text` / `sketch`), `page`, `app`, `url`, `title`, `at`, `whole`, `target` (selector,
xpath, test id, text, **source file:line**, **components**, box), `viewport`, `scroll`, `theme`,
`from`/`to` (text notes), `errors`, `build`, plus `body`, `reply` and `done`. Keep fields you don't
know: newer clients add them.

`screenshot` and `sketch` on a stored note are asset names (`<id>.png`), or paths ending in one; the
overlay fetches `/assets/<last segment>`.

### Fields only the store sets

The middleware strips these from anything a page sends, and the markdown store never writes the last
four. A remote store fills them for each caller:

| Field | Meaning |
|---|---|
| `author` | Who filed the note: the person the token belongs to. **Never** taken from the request |
| `mine` | `true` when the caller is the note's author |
| `resolvedAt` | ISO 8601 time the note was resolved. The overlay shows such a note **green**, with its reply, whatever "show done" says |
| `seen` | The author has seen it resolved |
| `href` | The note in the store's own UI (http/https only; anything else is not rendered) |

## Which notes to list

The store decides; this is the behaviour the overlay is built for (D42):

- **Open** notes: always.
- **Resolved** notes (`done: true`, `resolvedAt` set): for a while, so the reviewer sees the fix
  land. When the author's overlay shows one, it sends `PATCH {"seen": true}` once; stop listing the
  note soon after that (minutes). Stop after a fixed window (e.g. 24 h) if the author never looks.
  Ignore `seen` from anyone but the author (`notesProtocol` drops it).
- **Dismissed** or older resolved notes: never. They live on in the store's own UI.

Listing fewer notes is how a note disappears from the page: the overlay drops pins it is no longer given.

## Change feed (optional)

`GET /events` answers `text/event-stream` and sends an event whenever a visible note changes:

```
retry: 5000

event: change
data: {}
```

Send `: keep-alive` comments (every 25 s or so) so proxies keep the stream open. The client
re-reads `/notes` on each `change` and after every reconnect, so a lost event costs a few seconds, not
a note. The Node client reconnects with backoff (1 s up to 30 s) and gives up on 404. The middleware
holds one feed per server and fans it out to every open overlay over its own `/__redline/events`; it
only offers that when the store has a feed (`/config` says `events: true`), and polling stays on as
the safety net.

## Security notes for implementers

- Tokens are personal: a token acts as one person, and that person is the `author`. Store them hashed.
- Scope every call to what the token's owner may see; a note id from another scope is a 404.
- Note bodies, text diffs and console errors are reviewer input. Treat them as untrusted wherever they
  go next, above all into an AI model's context.
- Screenshots show whatever was on the reviewer's screen. Where reviewers can see other people's data,
  decide where notes may be filed from before turning a remote store on.
- Size limits: the reference server accepts 30 MiB per request (screenshots travel in the body).
