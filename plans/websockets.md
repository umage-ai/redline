# Plan: one WebSocket per tab instead of event streams

Status: plan (2026-11-24), follows D72. Not started. Delete this file once it ships or is dropped.

## Why

D72 cuts each tab down to one EventSource and lets hidden tabs go, but every visible tab still takes one of the
browser's 6 HTTP/1.1 connections to the dev server, and MCP can't reach a tab that has been hidden for 15 s.
WebSockets don't use that pool (browsers keep a separate, much larger limit for them; Vite's HMR socket is
why HMR never hit this). One socket per tab, carrying everything, removes the problem instead of rationing it.

## Shape

- **One endpoint**, `GET /__redline/ws` (Upgrade). Messages are JSON text frames `{ ch, type, data }`; channels:
  - `live`: `hello`, `ask` (server → page); `reply`, `moved` (page → server). These replace the POSTs.
  - `notes`: `change`, from the store's change feed.
  - `agent`: the status feed (`hello`, `status`, `clis`), and `agent:<session>` for a CLI window's output
    (`hello` with scrollback, `data`, `start`, `exit`). The page subscribes and unsubscribes with `sub` / `unsub`.
  - Plugins (voice etc.) can register a channel on the server.
- **Server, no dependency** (`src/server/socket.ts`): the RFC 6455 handshake (`Sec-WebSocket-Accept`), text frames
  in both directions (client frames are masked; lengths 7/16/64-bit), ping/pong every 25 s, close; one size cap
  per message (2 MB, like the live reply). About 150 lines plus tests; the `ws` package would be a first
  runtime dependency of the core, which we have avoided so far.
- **Guards:** a browser can't add headers to a WebSocket, so `x-redline` is out. Instead the `Origin` header must
  be the server's own origin or a `cors` origin (browsers always send it, so this does the same job). `live` and
  `agent` channels stay this machine only (`localCall`); the agent's token goes in the `sub` message.
- **Where upgrades arrive:** connect middleware never sees an upgrade, so each integration hooks the HTTP server:
  - Vite and Astro: `configureServer` → `server.httpServer.on('upgrade')`, only for our path (Vite's HMR keeps its own).
  - Next (`withRedline`): the handler runs on its own loopback port, and Next's rewrites don't carry upgrades. The
    page connects straight to that port (a cross-origin WebSocket is allowed; the Origin check admits the app's).
  - `redlineMiddleware` (Express etc.): a new `attachRedline(server)` that adds the upgrade handler. Without it, SSE.
  - .NET: ASP.NET Core's built-in `UseWebSockets`, same messages; until it's ported, SSE as today.
- **Client:** `transport.live` connects over a socket when `/config` lists `socket`, and falls back to the
  EventSource when the socket fails within 3 s (proxies, tunnels). The agent panel and the CLI window subscribe
  through the overlay's socket (extension API: `rl.channel(name)`) instead of opening their own streams.
  `gatedFeed` stays. With the pool problem gone, the grace for hidden tabs can grow to minutes, so MCP reaches
  background tabs again (revisits D72).

## Workstreams

1. **WS codec and server** (`socket.ts`): handshake, frames, ping, close, caps, Origin check; unit tests against
   a raw TCP client (masking, 126/127 lengths, split frames, oversize, bad origin).
2. **Channels in the handler:** `live` and `notes` on the socket; `/live` and `/events` stay for SSE clients.
   `mcp-live.test.ts` runs both ways.
3. **Integrations:** the Vite/Astro upgrade hook, Next's direct port, `attachRedline`; the e2e fixtures cover
   all of them (Next is the risky one).
4. **Client:** a socket `transport.live` with SSE fallback; `rl.channel()` (API v-next); the agent panel and
   terminal move onto it; the agent bridge keeps its own SSE for hosts other than Redline.
5. **.NET** (later): `UseWebSockets` with the same messages; golden tests for the message shapes.
6. **Docs:** D73 (supersedes the "not WebSockets yet" part of D72), PROTOCOL.md (the socket as an option for
   hosted stores), OPTIONS, STATE, L-entry for whatever bites.

Order: 1 → 2 → 4 (Vite first) → 3 → 6, then 5. Each step ships on its own: SSE remains the fallback throughout.

## Not chosen (for now)

- **One stream per browser** (a SharedWorker, or one tab elected through Web Locks relaying over BroadcastChannel):
  O(1) connections without new server code, but MCP asks must be routed to a given tab, leader hand-over on
  close is fiddly, and SharedWorker support is uneven. A fallback if sockets meet resistance.
- **Riding Vite's HMR socket** (`server.ws` custom events): no new server code on Vite, but the injected script
  isn't a Vite module (no `import.meta.hot`), it's Vite-only (not Next, not `redlineMiddleware`) and ties us to
  Vite internals.
- **HTTPS in dev** (HTTP/2 multiplexes everything on one connection): the best fix for anyone who can do it,
  so the D72 toast already suggests it. It can't be the default, because of certificates.
