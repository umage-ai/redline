# Setups

Last updated: 2026-11-10 · Cap: 200 lines · Which way to run Redline, for people and for AI agents choosing one.

Redline has one overlay (the browser part) and one note format. What changes between setups is **where
the overlay runs** and **where the notes are kept**. Pick the first row that fits.

| # | Setup | Use it when | Notes are kept in | Status |
|---|---|---|---|---|
| 1 | **Local dev** | You review your own app on your own dev server | `.redline/*.md` in the repo | ✅ JS/TS, on npm. .NET: works, not on NuGet yet |
| 2 | **Shared notes in dev** | Several people review the same app from their own dev servers | A remote store: the hub, or your own | ✅ Node. Hub: example, not on npm yet |
| 3 | **Deployed review** | Reviewers (editors, customers, QA) use a staging or production site | A database or remote store behind the site | 🟡 .NET online mode: works, not published. Node: building blocks only |
| 4 | **Your own backend** | Notes should land in your systems (tickets, CMS, feedback tooling) | Wherever your backend puts them | ✅ The protocol is stable. The hub is the example to copy |

Rules that hold in every setup:

- **The browser only talks to its own site** (`/__redline/*`). When notes go to a remote store, the server makes those calls and holds the token. The token never reaches the page. The one opt-in exception: [the API on another origin](#the-api-on-another-origin-d60).
- **Nothing runs outside dev unless you opt in.** The opt-ins are .NET `o.Online = true` (setup 3) and `buildSource` for stamps in a build (setup 3, Node).
- **Agents get the same notes in every setup**, through files (setup 1) or the MCP tools `list_notes`, `get_note` and `update_note` (all setups).
- **Markdown in the repo is the default.** Every other store is opt-in.

---

## 1. Local dev (default)

- **For:** one developer, or a reviewer on the same machine, with an AI agent applying the notes.
- **Overlay runs in:** the framework's dev server. It is gone from builds.
- **Notes:** `<repo>/.redline/pages/<page>.md`, plus screenshots in `.redline/assets/`. The folder is gitignored.
- **Agent gets them:** by reading the markdown, guided by the skill that `npx redline init` installs; or with `npx redline mcp` (stdio); or `POST /__redline/mcp` on the dev server (loopback only, `next dev` included). With `agent: true` and `@umage.ai/redline-agent` installed, the agent CLI runs from an agent toolbar in the overlay (apply notes, approve edits, live status, the terminal on demand; D53).
- **Install (JS/TS):** `npm i -D @umage.ai/redline`, `npx redline init`, then one line of config:

| Stack | Config |
|---|---|
| Vite: React, Vue, Svelte/SvelteKit, Solid, Preact | `plugins: [redline(), react()]` from `@umage.ai/redline/vite` |
| Astro | `integrations: [redline()]` from `@umage.ai/redline/astro` |
| Angular CLI 17+ | `serve` builder `@umage.ai/redline:dev-server` in `angular.json` |
| Next.js 15+ (webpack or Turbopack) | `withRedline(config)` from `@umage.ai/redline/next` in `next.config`, plus `<Redline />` from `@umage.ai/redline/next/script` in the root layout |
| Other Node servers (Express, http) | `redlineMiddleware()` from `@umage.ai/redline/server` → `app.use(api); app.use(inject)`; this machine only unless `network` says more (since 0.10) |
| ASP.NET Core, Razor, Blazor, Optimizely | `AddRedline()`. **Not on NuGet yet**: build the packages from `dotnet/` ([dotnet/README.md](../dotnet/README.md)) |

- **Status:** ✅ `@umage.ai/redline` on npm, every framework above covered by e2e tests. .NET: tested, unpublished.
- **Not for:** sharing notes between people. Each checkout has its own `.redline/`.
- **Network:** the API has no login, so the plugins answer this machine only. See below for anything else.
- **Launcher and toolbar:** reviewers can drag them (D51); `launcher: false` + `<button data-redline-open>` (or `="notes"`, …) replaces the button.
- **Details:** [FRAMEWORKS.md](FRAMEWORKS.md) and [USAGE.md](USAGE.md#launcher-and-toolbar).

### Reaching the dev server from elsewhere

The overlay's API has no login: whoever reaches it can read and write notes and screenshots, and with
`directEdit` the source. So the plugins answer a caller only if it is this machine (a loopback address and
a local Host, which also stops DNS rebinding). The `network` option adds callers: addresses and subnets
match the caller's address, host names the Host of a call from this machine; `true` lets everyone in.
A refused call logs one line naming the address or host to add.

| Situation | What Redline sees | Set |
|---|---|---|
| `next dev` (listens on the network by default) | the caller's own address: `withRedline` stamps it before Next's proxy hides it (D48) | nothing |
| A phone or colleague on the LAN (`vite --host`) | their address | `network: ['192.168.1.20']` or the subnet `'192.168.1.0/24'` |
| Dev server in Docker, browser on the host | the bridge gateway (`172.17.0.1` with Docker Desktop), for **every** caller | `-p 127.0.0.1:5173:5173`, then `network: ['172.17.0.1']` |
| nginx (or Caddy…) on this machine with its own domain | 127.0.0.1 and the Host nginx sends | `network: ['myapp.test']` if it passes `Host $host`; nothing if not |
| A proxy on another machine | the proxy's address, for everyone it lets through | the proxy's address, and restrict access in the proxy |

Behind a proxy or Docker's port forwarding, Redline can only see the proxy: allowing it allows everyone who
reaches the proxy, so keep the proxy (or the published port) on 127.0.0.1, or restrict it there. Redline
doesn't trust `X-Forwarded-For`. Vite 6+ has its own Host check: a custom domain also goes in `server.allowedHosts`.

## 2. Shared notes in dev (remote store)

- **For:** a team reviewing the same app, each on their own dev server, who want one set of notes: who filed what, replies, and a green pin when a note is resolved.
- **Overlay runs in:** each person's dev server, exactly as in setup 1.
- **Notes:** a remote store that speaks [the protocol](PROTOCOL.md). Two choices:
  - **The hub** (`npx @umage.ai/redline-hub`, [hub/README.md](../hub/README.md)): projects, personal tokens, MCP per project, a web UI, one SQLite file. It binds to localhost; on a network, keep it behind a VPN and HTTPS. **It is an example**, a working reference for setup 4 and a quick way to share notes. It is not a hardened product.
  - **Your own backend** (setup 4).
- **Agent gets them:** MCP from the store (the hub: `<hub>/p/<project>/mcp` with an agent token), or `redline mcp` through a running dev server.
- **Install:** setup 1, plus two environment variables on each dev server. No code changes:

```bash
REDLINE_STORE_URL=http://127.0.0.1:4780/p/my-project   # the store's base URL
REDLINE_STORE_TOKEN=rht_…                              # this person's token
```

  .NET: `o.UseRemoteStore(url, token)`. In code (Node): `redline({ store: remoteStore({ url, token }) })`. The panel's **Copy prompt** names `.redline/` files, so with a remote store it is hidden; set `prompt` (.NET `Prompt`) to your own text, e.g. `'Apply the open Redline notes with the redline MCP tools ({open} open on {page}).'` (D47).
- **Status:** ✅ Node, live updates included. 🟡 .NET client: unit-tested, polls (no live feed yet). 🟡 Hub: tested end to end (overlay → hub → green pin), version 0.1.0, not on npm yet.
- **Not for:** reviewers without a dev server. That is setup 3.

## 3. Deployed review (staging, production)

- **For:** people who don't run the code (content editors, customers, QA, stakeholders) giving feedback on a deployed site, with the notes reaching developers and their agents.
- **Overlay runs in:** the deployed app, **only for signed-in, authorized reviewers**. Everyone else gets no script and a 404 on the API.
- **Notes:** a database or remote store behind the site. The repo is not on the server.
- **Agent gets them:** `POST <site>/__redline/mcp` with a bearer token (a site token, or a reviewer's personal token), or MCP from the remote store.
- **.NET (most complete):** online mode, role- or policy-gated, with a SQL Server/SQLite store that records the author and personal MCP tokens. Optimizely defaults to the editor roles and the CMS database.

```csharp
services.AddRedline(o => { o.Online = true; o.Policy = "Reviewers"; o.UseSqlStore(() => new SqlConnection(cs)); });
```

- **Node: pick a shape** ([examples/review-frontend](../examples/review-frontend/README.md), from a system running shape A in production). None is required; all need the overlay for reviewers only, and a store that acts **as the signed-in reviewer** (`remoteStore({ url, headers: ctx => ({ cookie: ctx?.req.headers.cookie }) })`, or your own `NoteStore` reading `ctx.req`, D45). **Never** one token for the whole server: every reviewer's note would carry the same name.
  - **A. Two frontends, a gateway picks:** a normal image without Redline and a review image with stamps; the gateway routes reviewers (cookie + server-side flag). Strongest isolation; needs a gateway and a second deploy.
  - **B. One server:** `reviewersOnly(api, isReviewer)` and the same for `inject` in your existing server. No gateway, one build; but stamps then reach every visitor's HTML (file paths), or notes go without file:line.
  - **C. A separate review environment** (staging) running the review image at its own URL. No routing rule.
- **Status:** 🟡 .NET online mode is tested on the Optimizely sample, not yet on a deployed site, and is unpublished. ✅ Node: the review-frontend pattern runs in production elsewhere; the example's logic is unit-tested (`review-frontend.test.ts`), `buildSource` too, but not through a real image here.
- **Not for:** anonymous visitors. Screenshots show whatever is on the reviewer's screen, so decide who may file notes and from which sites (the hub's *allowed sites*, or your own check).
- **Details:** [dotnet/README.md](../dotnet/README.md) "Online mode", D34–D36, D43.

## 4. Your own backend (integration)

- **For:** notes that should become part of your systems: a ticket per note, a CMS task, a feedback inbox, analytics, notifications. Usually alongside setup 2 or 3.
- **How:** implement [the remote store protocol](PROTOCOL.md) (seven HTTP calls, bearer token, optional server-sent events) in any stack. Every Redline server then works with it unchanged.
- **Or skip HTTP:** a `NoteStore` inside your server that calls your service directly. Each method gets the request (`ctx.req`, D45), so it can act as the signed-in user ([store.ts](../examples/review-frontend/store.ts)). On .NET, an `INoteStore` reads the user through `IHttpContextAccessor`.
- **Start from:** `notesProtocol(store, { authorize })` (Node) to serve the protocol over your own `NoteStore`, or copy the hub (`hub/src/`, about 1 000 lines): projects, tokens, the D42 rules for resolved notes, MCP, UI.
- **Labels from your backend:** `labels` can be a function (`({ req }) => …`, may be async; .NET `LabelsFrom`), asked on every `/config` request, so the chips can come from your system or depend on the reviewer (D46).
- **Lighter option:** keep the default store and react with `hooks` (`onCreate`, …), e.g. to post new notes to chat.
- **Status:** ✅ protocol, Node and .NET clients, reference server (`remote.test.ts`, `RemoteStoreTests.cs`, `hub.test.ts`).
- **Rules your backend must keep:** set `author` from the token or session, never from the request body; scope every call to what that person may see (project, tenant); drop `seen` from anyone but the author; list resolved notes only for a while (PROTOCOL.md "Which notes to list"); delete closed notes after a retention period, and notes of deleted tenants; cap sizes (note JSON, screenshot, sketch).

### Embedding the overlay in your product

For a browser extension or a product with its own notes backend (D49, D50). `mount` runs nothing on import; each
part is an option with a default you can wrap or replace. The same modules come without the server parts as
`@umage.ai/redline-overlay`. With your own transport the page talks to your backend,
so the "own site only" rule above is then yours to keep.

```ts
import { mount, httpTransport } from '@umage.ai/redline/overlay';
const base = httpTransport();                       // the dev server's /__redline API, the default
const rl = await mount({
  transport: { ...base, create: req => base.create({ ...req, note: { ...req.note, body: req.note.body + ' #123' } }) },
  shadowMode: 'closed', hostTag: 'my-review', namespace: 'my-review',   // two overlays on one page don't collide
  captureErrors: false,                             // or () => errorsYouCollected
  screenshot: (req, next) => next(req),             // or your own capture (strict CSP, an extension worker)
  theme: { '--ink': '#0a84ff' },
  strings: { comment: 'Kommentar' },                // any UI text: the keys are in overlay/strings
  config: { statuses: [{ id: 'open' }, { id: 'fixed', label: 'Fixed', done: true, color: '#3ecf8e' }],
            launcher: false, draggable: true },     // your button opens it (data-my-review-open or rl.api.open()); D51
  gate: async el => { el.append(signInForm()); await signedIn(); },   // before notes load; modes off until then
});
rl.api.addSlot({ id: 'ws', render: el => el.append(workspaceChip()) });   // your element in the toolbar
rl.api.open();                                      // the extension API (D21); rl.unmount() undoes everything
```

A transport is `config`, `load(etag)`, `create`, `update`, `remove`, `assetUrl`, plus optional `edit` (Apply to file),
`subscribe` (live changes) and `message` (a reply box under each note's `messages` thread). Notes may carry
`status`, `messages` and `meta`; the markdown store keeps them. `rl.gate(fn)` locks again (sign-out). API v4 (D52):
`rl.on('error', ({ op, error }) => …)` (a 401 on `load` → `rl.gate(signIn)`), `beforeSave`, card decorators and actions,
`setPinStyle`, `addMode` (your own pick mode), `addSketchTool`. API v6 (D61): `addTargetEnricher((el, target) => ({ extra: … }))`
adds what the host knows about the picked element (an edit-mode property, a block id, a variant), and `beforeCreate` changes
or drops (`false`) a note just before the transport. Building blocks: `overlay/anchor`, `sketch`, `capture`,
`shield`, `styles`, `transport`, `strings`. **Status:** ✅ `embed.spec.ts` (Chrome); on npm as `@umage.ai/redline-overlay`.

### The script tag on another path (D60)

Hosts without a bundler (a CMS module route, an app under a path base) keep the self-starting `client.js` and tell it
where the API is: `window.redlineConfig = { apiBase: '/app/__redline' }` before the script, or
`<script type="module" src="/app/__redline/client.js" data-api="/app/__redline">`. The servers do it themselves with
`apiBase` (Node) / `ApiBase` (.NET), and .NET adds the request's `PathBase` ([dotnet/README.md](../dotnet/README.md)).
Comments, polling, screenshots, the live feed and Apply to file all go to that base. **Status:** ✅ `hosting.spec.ts`.

### The API on another origin (D60)

For hosts with no server Redline can run in: a headless frontend whose notes live in the CMS, a standalone Blazor
WebAssembly app whose API runs on another port. Where the host has a server, the same-origin proxy above stays the better choice.

- **The page** points `data-api` / `apiBase` at the full URL and picks one mode. **Cookies:** `credentials: 'include'` (or `data-credentials="include"`); every call and the live feed send them. The cookie must reach the API: same site (subdomains, another port) with `SameSite=Lax`, or `SameSite=None; Secure` across sites. **A header:** `window.redlineConfig = { apiBase, headers: async () => ({ authorization: 'Bearer ' + await token() }) }`, asked before every call; images load as blob URLs and the feed is read with fetch. With `mount()`: `httpTransport(url, { credentials, headers })`.
- **The API** lists the page's origin, exactly: `cors: ['https://www.example.com']` (Node) or `o.CorsOrigins.Add(…)` (.NET). Listed origins get preflights answered (`x-redline`, `authorization`, `content-type`, `if-none-match`), `GET, HEAD, POST, PATCH, DELETE`, credentials, and `etag` exposed so 304 polling works; `client.js` is served to them too (module scripts need CORS). Others get nothing new, and MCP and the agent panel never answer cross-origin. .NET online mode accepts their mutations.
- **Weaker than the proxy:** a token in page JS is readable by every script on that page (an XSS, a third-party tag), and cookies with `SameSite=None` ride along on cross-site requests. Acceptable for a review build or an editor-only frontend with short-lived, per-reviewer tokens; not for a public site with one shared token. **Status:** ✅ `hosting.spec.ts` (page and API on two ports, both modes), `MiddlewareTests.cs`, `OnlineTests.cs`.

### Inside an iframe (D60)

The self-starting script stays out of iframes unless the host opts in: `allowInIframe: true` on the server (every framed
page), or `window.redlineConfig.allowInIframe` / `data-allow-iframe` on the framed page's tag. A CMS preview frame, a
slide tool, a component workbench. How a parent's overlay and a frame's coexist:

- **One per window.** Each frame mounts its own `<redline-root>` on its own `<html>`; no styles or events cross frames.
- **Hotkey and keys** reach the focused document only, so Alt+Shift+R toggles that one. A same-origin parent can drive the frame's: `frame.contentWindow.postMessage({ redline: 'toggle' }, location.origin)` (`open`, `close`, `comment`, `text`, `sketch`, `notes`); messages from other origins are ignored. `data-launcher="false"` hides the frame's own launcher.
- **Clicks:** each overlay shields its own app while picking; the parent's UI (on-page editing) keeps working outside the frame.
- **Notes** carry the frame's own `url` and page; view state and positions are kept apart from the parent's.
- **Screenshots** are DOM captures of the frame; tab capture is off in frames (it would show the whole tab).
- **Status:** ✅ `iframe.spec.ts` (Chrome). The Optimizely package still keeps the overlay out of the CMS's own edit frames (D33).

---

## For AI agents choosing a setup

- The user wants feedback on **their own running app** → setup 1. Install the package and run `npx redline init`.
- They say **team** or **shared**, and everyone runs the code → setup 2. Suggest the hub to try it, or their backend.
- They say **staging**, **production**, **QA**, **editors**, **customers** or **CMS** → setup 3. On .NET use online mode; on Node, offer the shapes in examples/review-frontend: A (gateway + second image) only if they have a gateway and can deploy twice, else B (one server, reviewers-only middleware) or C (a review environment).
- They want notes **in Jira/Linear/their CMS/a feedback tool** → setup 4 (or `hooks` for a one-way push).
- Never put a store token in browser code, never enable the overlay for unauthenticated visitors, and never give a multi-reviewer site one store token: forward each reviewer's own credentials.
- Don't call the .NET packages or the hub published until STATE.md says so.
