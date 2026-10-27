# Setups

Last updated: 2026-10-27 · Cap: 200 lines · Which way to run Redline, for people and for AI agents choosing one.

Redline has one overlay (the browser part) and one note format. What changes between setups is **where
the overlay runs** and **where the notes are kept**. Pick the first row that fits.

| # | Setup | Use it when | Notes are kept in | Status |
|---|---|---|---|---|
| 1 | **Local dev** | You review your own app on your own dev server | `.redline/*.md` in the repo | ✅ JS/TS, on npm. .NET: works, not on NuGet yet |
| 2 | **Shared notes in dev** | Several people review the same app from their own dev servers | A remote store: the hub, or your own | ✅ Node. Hub: example, not on npm yet |
| 3 | **Deployed review** | Reviewers (editors, customers, QA) use a staging or production site | A database or remote store behind the site | 🟡 .NET online mode: works, not published. Node: building blocks only |
| 4 | **Your own backend** | Notes should land in your systems (tickets, CMS, feedback tooling) | Wherever your backend puts them | ✅ The protocol is stable. The hub is the example to copy |

Rules that hold in every setup:

- **The browser only talks to its own site** (`/__redline/*`). When notes go to a remote store, the server
  makes those calls and holds the token. The token never reaches the page.
- **Nothing runs outside dev unless you opt in.** The opt-ins are .NET `o.Online = true` (setup 3) and
  `buildSource` for stamps in a build (setup 3, Node).
- **Agents get the same notes in every setup**, through files (setup 1) or the MCP tools
  `list_notes`, `get_note` and `update_note` (all setups).
- **Markdown in the repo is the default.** Every other store is opt-in.

---

## 1. Local dev (default)

- **For:** one developer, or a reviewer on the same machine, with an AI agent applying the notes.
- **Overlay runs in:** the framework's dev server. It is gone from builds.
- **Notes:** `<repo>/.redline/pages/<page>.md`, plus screenshots in `.redline/assets/`. The folder is gitignored.
- **Agent gets them:** by reading the markdown, guided by the skill that `npx redline init` installs; or with
  `npx redline mcp` (stdio); or `POST /__redline/mcp` on the dev server (loopback only; through `next dev`, tokens only).
- **Install (JS/TS):** `npm i -D @umage.ai/redline`, `npx redline init`, then one line of config:

| Stack | Config |
|---|---|
| Vite: React, Vue, Svelte/SvelteKit, Solid, Preact | `plugins: [redline(), react()]` from `@umage.ai/redline/vite` |
| Astro | `integrations: [redline()]` from `@umage.ai/redline/astro` |
| Angular CLI 17+ | `serve` builder `@umage.ai/redline:dev-server` in `angular.json` |
| Next.js 15+ (webpack or Turbopack) | `withRedline(config)` from `@umage.ai/redline/next` in `next.config`, plus `<Redline />` from `@umage.ai/redline/next/script` in the root layout |
| Other Node servers (Express, http) | `redlineMiddleware()` from `@umage.ai/redline/server` → `app.use(api); app.use(inject)` |
| ASP.NET Core, Razor, Blazor, Optimizely | `AddRedline()`. **Not on NuGet yet**: build the packages from `dotnet/` ([dotnet/README.md](../dotnet/README.md)) |

- **Status:** ✅ `@umage.ai/redline` on npm, with every framework above covered by e2e tests. .NET is tested
  (unit and browser) but unpublished.
- **Not for:** sharing notes between people. Each checkout has its own `.redline/`.
- **Details:** [README.md](../README.md) "Setup in a repo".

## 2. Shared notes in dev (remote store)

- **For:** a team reviewing the same app, each on their own dev server, who want one set of notes: who
  filed what, replies, and a green pin when a note is resolved.
- **Overlay runs in:** each person's dev server, exactly as in setup 1.
- **Notes:** a remote store that speaks [the protocol](PROTOCOL.md). Two choices:
  - **The hub** (`npx @umage.ai/redline-hub`, [hub/README.md](../hub/README.md)): projects, personal tokens,
    MCP per project, a web UI, one SQLite file. It binds to localhost; on a network, keep it behind a VPN and HTTPS.
    **It is an example**, a working reference for setup 4 and a quick way to share notes. It is not a hardened product.
  - **Your own backend** (setup 4).
- **Agent gets them:** MCP from the store (the hub: `<hub>/p/<project>/mcp` with an agent token), or
  `redline mcp` through a running dev server.
- **Install:** setup 1, plus two environment variables on each dev server. No code changes:

```bash
REDLINE_STORE_URL=http://127.0.0.1:4780/p/my-project   # the store's base URL
REDLINE_STORE_TOKEN=rht_…                              # this person's token
```

  .NET: `o.UseRemoteStore(url, token)`. In code (Node): `redline({ store: remoteStore({ url, token }) })`.
  The panel's **Copy prompt** names `.redline/` files, so with a remote store it is hidden; set `prompt` (.NET `Prompt`)
  to your own text, e.g. `'Apply the open Redline notes with the redline MCP tools ({open} open on {page}).'` (D47).
- **Status:** ✅ Node, live updates included. 🟡 .NET client: unit-tested, polls (no live feed yet). 🟡 Hub:
  tested end to end (overlay → hub → green pin), version 0.1.0, not on npm yet.
- **Not for:** reviewers without a dev server. That is setup 3.

## 3. Deployed review (staging, production)

- **For:** people who don't run the code (content editors, customers, QA, stakeholders) giving feedback on a
  deployed site, with the notes reaching developers and their agents.
- **Overlay runs in:** the deployed app, **only for signed-in, authorized reviewers**. Everyone else gets no
  script and a 404 on the API.
- **Notes:** a database or remote store behind the site. The repo is not on the server.
- **Agent gets them:** `POST <site>/__redline/mcp` with a bearer token (a site token, or a reviewer's
  personal token), or MCP from the remote store.
- **.NET (most complete):** online mode, role- or policy-gated, with a SQL Server/SQLite store that records
  the author and personal MCP tokens. Optimizely defaults to the editor roles and the CMS database.

```csharp
services.AddRedline(o => { o.Online = true; o.Policy = "Reviewers"; o.UseSqlStore(() => new SqlConnection(cs)); });
```

- **Node: pick a shape** ([examples/review-frontend](../examples/review-frontend/README.md), from a system
  running shape A in production). None is required; all need the overlay for reviewers only, and a store that
  acts **as the signed-in reviewer** (`remoteStore({ url, headers: ctx => ({ cookie: ctx?.req.headers.cookie }) })`,
  or your own `NoteStore` reading `ctx.req`, D45). **Never** one token for the whole server: every reviewer's
  note would carry the same name.
  - **A. Two frontends, a gateway picks:** a normal image without Redline and a review image with stamps; the
    gateway routes reviewers (cookie + server-side flag). Strongest isolation; needs a gateway and a second deploy.
  - **B. One server:** `reviewersOnly(api, isReviewer)` and the same for `inject` in your existing server. No
    gateway, one build; but stamps then reach every visitor's HTML (file paths), or notes go without file:line.
  - **C. A separate review environment** (staging) running the review image at its own URL. No routing rule.
- **Status:** 🟡 .NET online mode is tested on the Optimizely sample, not yet on a deployed site, and is
  unpublished. ✅ Node: the review-frontend pattern runs in production elsewhere; the example's logic is
  unit-tested (`review-frontend.test.ts`), `buildSource` too, but not through a real image here.
- **Not for:** anonymous visitors. Screenshots show whatever is on the reviewer's screen, so decide who
  may file notes and from which sites (the hub's *allowed sites*, or your own check).
- **Details:** [dotnet/README.md](../dotnet/README.md) "Online mode", D34–D36, D43.

## 4. Your own backend (integration)

- **For:** notes that should become part of your systems: a ticket per note, a CMS task, a feedback inbox,
  analytics, notifications. Usually alongside setup 2 or 3.
- **How:** implement [the remote store protocol](PROTOCOL.md) (seven HTTP calls, bearer token, optional
  server-sent events) in any stack. Every Redline server then works with it unchanged.
- **Or skip HTTP:** a `NoteStore` inside your server that calls your service directly. Each method gets the
  request (`ctx.req`, D45), so it can act as the signed-in user ([store.ts](../examples/review-frontend/store.ts)).
  On .NET, an `INoteStore` reads the user through `IHttpContextAccessor`.
- **Start from:** `notesProtocol(store, { authorize })` (Node) to serve the protocol over your own `NoteStore`,
  or copy the hub (`hub/src/`, about 1 000 lines): projects, tokens, the D42 rules for resolved notes, MCP, UI.
- **Labels from your backend:** `labels` can be a function (`({ req }) => …`, may be async; .NET `LabelsFrom`),
  asked on every `/config` request, so the chips can come from your system or depend on the reviewer (D46).
- **Lighter option:** keep the default store and react to events with `hooks`
  (`onCreate`, `onUpdate`, `onRemove`), e.g. to post each new note to a chat channel.
- **Status:** ✅ the protocol, the Node and .NET clients, and the reference server are tested (`remote.test.ts`,
  `RemoteStoreTests.cs`, `hub.test.ts`).
- **Rules your backend must keep:** set `author` from the token or session, never from the request body;
  scope every call to what that person may see (project, tenant); drop `seen` from anyone but the author;
  list resolved notes only for a while (PROTOCOL.md "Which notes to list"); delete closed notes after a
  retention period, and notes of deleted tenants; cap sizes (note JSON, screenshot, sketch).

---

## For AI agents choosing a setup

- The user wants feedback on **their own running app** → setup 1. Install the package and run `npx redline init`.
- They say **team** or **shared**, and everyone runs the code → setup 2. Suggest the hub to try it, or their backend.
- They say **staging**, **production**, **QA**, **editors**, **customers** or **CMS** → setup 3. On .NET use online
  mode; on Node, offer the shapes in examples/review-frontend: A (gateway + second image) only if they have a
  gateway and can deploy twice, else B (one server, reviewers-only middleware) or C (a review environment).
- They want notes **in Jira/Linear/their CMS/a feedback tool** → setup 4 (or `hooks` for a one-way push).
- Never put a store token in browser code, never enable the overlay for unauthenticated visitors, and never
  give a multi-reviewer site one store token: forward each reviewer's own credentials.
- Don't call the .NET packages or the hub published until STATE.md says so.
