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

### [ ] Bug · Comment · `button` “Pay now” · [data-testid="pay"] · src/Checkout.tsx:18
<!-- redline {"id":"mh1lab1bug","type":"comment","page":"/checkout","url":"http://localhost:5173/checkout","at":"2026-10-26 09:00","label":"Bug","target":{"tag":"button","text":"Pay now","testid":"pay","source":{"file":"src/Checkout.tsx","line":18}}} -->

Double-clicking charges twice.

### [x] Copy · Text change · `h1` “Check out”
<!-- redline {"id":"mh1lab2cpy","type":"text","page":"/checkout","url":"http://localhost:5173/checkout","at":"2026-10-26 09:02","label":"Copy","target":{"tag":"h1","text":"Check out"},"from":"Check out","to":"Checkout"} -->

```diff
- Check out
+ Checkout
```

> Fixed in src/Checkout.tsx:4.

### [ ] Needs a design review · “late… · Sketch · whole page
<!-- redline {"id":"mh1lab3idea","type":"sketch","page":"/checkout","url":"http://localhost:5173/checkout","at":"2026-10-26 09:05","whole":true,"label":"Needs a design review · “later”, or never","sketch":"../assets/mh1lab3idea.svg"} -->

![sketch](../assets/mh1lab3idea.svg)
