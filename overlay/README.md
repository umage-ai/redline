# @umage.ai/redline-overlay

The [Redline](https://github.com/umage-ai/redline) review overlay as browser modules, for products that
embed it: a browser extension, a review site, a snippet on a customer's page. Reviewers pin comments, text
changes and sketches on the live page; your code decides where the notes go.

No server parts, no dependencies, nothing runs on import. The dev-server integrations (Vite, Astro, Next,
Angular, Node, .NET) are in [`@umage.ai/redline`](https://www.npmjs.com/package/@umage.ai/redline), which ships
the same modules as `@umage.ai/redline/overlay`.

```js
import { mount, httpTransport } from '@umage.ai/redline-overlay';

const rl = await mount({
  transport: myStore,             // load / create / update / remove / assetUrl (+ optional message, subscribe, edit)
  shadowMode: 'closed',           // a store-published extension
  hostTag: 'acme-review', namespace: 'acme',
  theme: { '--ink': '#0a84ff' },
  strings: { comment: 'Kommentar', notes: 'Noter' },   // any UI text, see strings.js
  config: { statuses: [{ id: 'open' }, { id: 'review', label: 'In review', color: '#ffb020' }, { id: 'fixed', done: true }] },
  gate: async el => { el.append(signInForm()); await signedIn(); },   // before any note loads
});
rl.api.addSlot({ id: 'workspace', render: el => el.append(workspaceChip()) });
// …
rl.unmount();
```

To change one call of a transport, wrap it: `{ ...httpTransport('/api/review'), create: r => base.create(tag(r)) }`.

Building blocks on their own: `/anchor` (describe and re-find an element), `/sketch`, `/capture`
(screenshots), `/shield` (keep the page from seeing overlay events), `/styles`, `/transport`, `/strings`.

Every option and how they fit: [docs/SETUPS.md › Embedding the overlay](https://github.com/umage-ai/redline/blob/main/docs/SETUPS.md#embedding-the-overlay-in-your-product).
Decisions: D49 (mountable) and D50 (note model, gate, slots, strings) in
[docs/DECISIONS.md](https://github.com/umage-ai/redline/blob/main/docs/DECISIONS.md).

MIT licensed.
