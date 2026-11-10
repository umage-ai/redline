# Frameworks

Last updated: 2026-11-10 · Cap: 150 lines · Setup per framework, monorepos, and how each stack finds a note's source file:line.

Every setup starts the same way:

```bash
npm install -D @umage.ai/redline
npx redline init        # agent guide + AGENTS.md section, .redline/ in .gitignore (docs/USAGE.md "Coding agents")
```

Then press **Alt+Shift+R** in the running app. Every option and its default: [OPTIONS.md](OPTIONS.md). Which setup
(local, shared, deployed, own backend): [SETUPS.md](SETUPS.md).

## Vite (React, Vue, Svelte/SvelteKit, Solid, Preact)

`vite.config.ts`. Put Redline first, before the framework plugin:

```ts
import redline from '@umage.ai/redline/vite'

export default defineConfig({ plugins: [redline(), react()] })   // or vue(), sveltekit(), solid(), preact()
```

## Astro

`astro.config.mjs`. It only activates under `astro dev`:

```js
import redline from '@umage.ai/redline/astro'

export default defineConfig({ integrations: [redline()] })
```

## Angular (CLI 17+)

`angular.json`: swap the `serve` builder; the options are `@angular/build:dev-server`'s plus `redline`.
In dev it turns on Angular's template source locations, so notes point at the template line. `ng build` is untouched.

```json
"serve": { "builder": "@umage.ai/redline:dev-server", "options": { "buildTarget": "app:build:development", "redline": { "directEdit": true } } }
```

## Next.js (15+, webpack or Turbopack; only `next dev`)

Wrap the config; put `<Redline />` last in the root layout's `<body>` (Pages Router: `pages/_document.tsx`).
`next dev` listens on your network and `/__redline/*` has no login, so Redline checks each caller's own address, as
Next's server received it, and answers this machine only (see `network` in [USAGE.md](USAGE.md#options-in-brief)).

```tsx
export default withRedline(nextConfig, { directEdit: true })   // next.config.ts, from '@umage.ai/redline/next'; keeps nextConfig's type (NextConfig)
<body>{children}<Redline /></body>   // app/layout.tsx, from '@umage.ai/redline/next/script'; renders nothing outside development
```

## ASP.NET Core, Blazor, Optimizely CMS (upcoming, not on NuGet yet)

`UmageAI.Redline.AspNetCore` / `UmageAI.Redline.Optimizely`, then `AddRedline()`. Notes name the `.cshtml`/`.razor` line
or the CMS property; an online mode serves editors on a live site. See [dotnet/README.md](../dotnet/README.md).

## Other Node dev servers

`redlineMiddleware()` → `{ api, inject }` from `@umage.ai/redline/server`.
**Working on Redline** itself: `npm link` a built checkout.

## Monorepos

They work without extra setup: each app adds the plugin to its own dev server. Notes from every app go to one
`.redline/` at the repo root, tagged with the app (`pages/apps-web--settings.md`); each app pins only its own (the
panel's **All** tab lists the rest). Source paths are repo-relative. `npx redline init` anywhere sets up the repo root
(`--here`: this folder). `app` names the app (default: the dev server's folder, e.g. `apps/web`).

## How source locations are found

| Stack | Source of `file:line` | Components |
|---|---|---|
| Svelte 5 / SvelteKit | `__svelte_meta` (built into Svelte dev builds) | `__svelte_meta.parent` chain |
| Astro | `data-astro-source-file/-loc` (snapshotted at parse time, because Astro's dev toolbar strips them) | `.astro` files up the tree |
| React 19 (Vite) | The plugin stamps `data-redline-src="file:line:col Component"` on HTML elements in `.jsx`/`.tsx` during dev | Fiber owner chain, with router and provider plumbing filtered out |
| Solid, Preact (Vite) | The same JSX stamp | The components the stamped elements are written in |
| Next.js 15+ | The same JSX stamp, from a loader `withRedline` adds (webpack and Turbopack) | Client components that own the element, then every Server Component around it (page, route-group layouts, root layout) |
| Vue 3 (Vite) | The plugin stamps HTML elements in `.vue` templates during dev | `__vueParentComponent` chain |
| Angular 17+ | `data-ng-source-location` (Angular's `enableTemplateSourceLocations`, turned on by the builder in dev) | `ng.getOwningComponent`, then the host components around it |
| Razor, Blazor (.NET) | Debug builds compile `.cshtml`/`.razor` copies stamped with `data-redline-src`; Optimizely adds CMS content + property | Stamped files up the tree |
| Anything else | n/a | n/a. The selector, test id and text still identify the element. |

`jsxSource: false` / `vueSource: false` turn the stamps off; `buildSource: true` keeps them in `vite build` for a review
build ([USAGE.md](USAGE.md#extending)).
