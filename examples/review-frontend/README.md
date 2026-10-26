# Review frontend: Redline on a deployed site, for reviewers only

A worked example of [setup 3](../../docs/SETUPS.md#3-deployed-review-staging-production) in a Node app, taken
from a production system and made generic. Reviewers (QA, customers in acceptance testing, content
editors, partners) file notes on the real site; everyone else never gets the overlay.

## Pick a shape (none is required)

What every shape needs: the overlay and `/__redline` only for authorized reviewers, and a store that acts
as the signed-in reviewer ([store.ts](store.ts)). How you get there depends on your infrastructure:

| Shape | How | Good when | Costs |
|---|---|---|---|
| **A. Two frontends, gateway picks** (this README's main path) | Normal image without Redline; review image with stamps + middleware; the gateway routes reviewers | You have a gateway with header/cookie routing and can deploy a second service | A routing rule, a second image and process; both must ship from the same release |
| **B. One server, reviewers-only middleware** ([same-server.ts](same-server.ts)) | `app.use(reviewersOnly(api, isReviewer))`, same for `inject`, in your existing server | No easy gateway, a simple deploy, or a bundle too large to build twice | One build for everyone: with stamps, every visitor's HTML names your source files and components; without, notes lose file:line |
| **C. A separate review environment** | The review image of A at its own URL (staging, `review.example.com`), no routing rule | You already deploy a staging or review environment reviewers can reach | Reviewers test that environment, not production; its data may differ |

A gives the strongest isolation: normal users never download a byte of Redline. B is the least work.
The rest of this README walks through A; [same-server.ts](same-server.ts) and [store.ts](store.ts) cover B,
and C is A without the gateway section.

## Shape A: two frontends

```
browser ──cookie review-mode=on──▶ gateway ──(signed in + flag set?)──▶ review frontend ──▶ your notes API
                                      │                                   (same build + stamps
                                      └──otherwise──────────────────────▶ normal frontend   + Redline middleware)
```

| File | What it shows |
|---|---|
| [gateway.ts](gateway.ts) | The routing decision: strip the internal header, check cookie + server-side flag, fail to normal |
| [switch.ts](switch.ts) | The reviewer's switch: who carries the cookie, when the flag (15 min TTL) is written or dropped |
| [store.ts](store.ts) | A `NoteStore` that calls your notes API **as the signed-in reviewer** (their session cookie) |
| [server.ts](server.ts) | The review image's server: Redline's middleware in front of your app's handler (A, C) |
| [same-server.ts](same-server.ts) | `reviewersOnly(mw, isReviewer)`: Redline inside your one server, for reviewers only (B) |

### How a request reaches the review frontend

1. The reviewer turns the switch on (a profile setting). Your app saves it, sets the httpOnly
   `review-mode=on` cookie and writes a flag such as `review:enabled:<userId>` with a short TTL.
2. The gateway, after authentication, **strips any `x-review-frontend` header the client sent**, and sets
   it only when the cookie is there **and** the flag exists. Without the cookie it looks nothing up.
3. A route matching `x-review-frontend: on` (ordered before the catch-all) proxies to the review frontend.
4. The review frontend checks again: its store calls your notes API with the reviewer's session, and the
   API refuses anyone who may not review. The cookie only ever *selects*; it never authorizes.

### The two images

Build the same commit twice:

```bash
docker build -t app .                                   # normal: no stamps, no Redline
docker build -t app-review --build-arg REVIEW=1 \
             --build-arg REVIEW_BUILD=$(git rev-parse --short HEAD) .
```

- `REVIEW=1` builds with `redline({ buildSource: process.env.REVIEW === '1' })` in `vite.config.ts`, so
  elements carry `data-redline-src="src/…:line:col Component"`, and starts `server.ts` instead of the
  framework's own server.
- **Both frontends must come from the same release.** A page and its hashed asset chunks are only
  consistent within one build.
- Cost: one more Node process (about 100–150 MB).

## Rules worth keeping

- **Author comes from the session**, in your notes API. Never from the page, and never one token per server,
  which would put every reviewer's name on everyone's notes.
- **Scope notes** the way your app scopes data: by tenant or organization (from the page path or the
  session), so a reviewer sees what they may see. Delete notes of deleted tenants.
- **Retention:** delete closed notes after a while (30 days works) with a periodic sweep.
- **Visibility on the overlay:** open notes, and resolved ones until a few minutes after their author has
  seen them, at most 24 h ([PROTOCOL.md](../../docs/PROTOCOL.md) "Which notes to list").
- **Limits:** cap note JSON (256 KB), screenshots (15 MB) and sketches (2 MB) in the API.
- **Agents** read notes through your own API or MCP with their own tokens, scoped (read vs. triage).
  The review frontend refuses `/__redline/mcp`.
- **Screenshots show whatever is on the reviewer's screen**, customer data included. Decide who may review.

## Operating it (shape A)

Shape B turns off with `isReviewer` (or by removing the two `reviewersOnly` lines); shape C by
stopping the review environment. Shape A has more moving parts:

- **Off for everyone:** stop the review frontend, then delete the flags (`review:enabled:*`) and the saved
  switches. Otherwise reviewers with the cookie get 502s until the flags expire.
- **A reviewer is stuck on the review frontend:** delete their `review-mode` cookie, or switch off. A lost
  right to review stops the routing within the flag's TTL, and the notes API refuses at once.

| Symptom | Cause |
|---|---|
| Switched on, but no overlay | No cookie in this browser (open any page once while signed in), or the flag is missing |
| Saving fails with "Your session has ended" | The session expired: sign in again |
| Notes have no file:line | The page came from the normal build, or the review image was built without `REVIEW=1` |
| Every page is a 502 for one reviewer | The review frontend is down: see "Off for everyone" |

On ASP.NET Core you don't need a second image: online mode (`o.Online = true`) gates the overlay per user
in the same app. See [dotnet/README.md](../../dotnet/README.md).
