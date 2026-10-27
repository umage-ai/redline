# Redline — /checkout

<!--
  Written by the Redline overlay (dev only) for a coding agent. The full guide is the
  redline skill, if this repo has it (`npx redline init`); this comment covers the basics.
  Each note: a "### [ ]" heading naming the reviewer's label if any (Bug, UX, …), the
  element and where it lives in source,
  an anchor comment (JSON: url, selector, xpath, source file:line, component chain,
  CMS content and property, viewport, app folder in a monorepo, …; paths are repo-relative), the instruction, optional screenshot/sketch images, and an optional
  "> " reply. Screenshots mark the target with a red box.
  To close a note: tick it ("### [x]") and add a one-line "> " reply saying what
  changed. To ask back: leave it open and put the question in the reply.
  Never edit or delete the <!-- redline … --> comment; never reorder notes.
-->

Page: http://localhost:5173/checkout

### [x] Comment · `button` “Pay” · src/Checkout.tsx:20
<!-- redline {"id":"mg4edit001","type":"comment","page":"/checkout","url":"http://localhost:5173/checkout","at":"2026-10-15 09:00","target":{"tag":"button","text":"Pay","source":{"file":"src/Checkout.tsx","line":20}}} -->

Make it green.
Second line right after.

> Done: now uses the success colour.
> Second reply line without space.

### [ ] Text change · whole page
<!-- redline {"id":"mg4edit002","type":"text","page":"/checkout","url":"http://localhost:5173/checkout","at":"2026-10-15 09:01","from":"Totl","to":"Total"} -->

```diff
- Totl
+ Total
```

Indented body line.

### [ ] Sketch · whole page
<!-- redline {"id":"mg4edit003","type":"sketch","page":"/checkout","url":"http://localhost:5173/checkout","at":"2026-10-15 09:02","whole":true,"sketch":"../assets/mg4edit003.svg"} -->

Body after.

![sketch](../assets/mg4edit003.svg)

> Question back?
