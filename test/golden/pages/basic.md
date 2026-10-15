# Redline — /agents

<!--
  Written by the Redline overlay (dev only) for a coding agent. The full guide is the
  redline skill (.agents/skills/redline/SKILL.md, installed by `npx redline init`).
  Each note: a "### [ ]" heading naming the element and where it lives in source,
  an anchor comment (JSON: url, selector, xpath, source file:line, component chain,
  CMS content and property, viewport, app folder in a monorepo, …; paths are repo-relative), the instruction, optional screenshot/sketch images, and an optional
  "> " reply. Screenshots mark the target with a red box.
  To close a note: tick it ("### [x]") and add a one-line "> " reply saying what
  changed. To ask back: leave it open and put the question in the reply.
  Never edit or delete the <!-- redline … --> comment; never reorder notes.
-->

Page: http://localhost:5173/agents

### [ ] Comment · `button` “Save -- draft” · [data-testid="save"] · src/Form.svelte:42
<!-- redline {"id":"mg1abc2def","type":"comment","page":"/agents","url":"http://localhost:5173/agents","title":"Agents · Acme","at":"2026-10-13 10:00","target":{"selector":"main > section:nth-of-type(2) > [data-testid=\"save\"]","testid":"save","xpath":"/html/body/main/section[2]/button","tag":"button","text":"Save \u002d\u002d draft","role":"button","name":"Save draft","html":"<button data-testid=\"save\" class=\"btn\">Save \u002d\u002d draft</button>","source":{"file":"src/Form.svelte","line":42,"col":7},"components":["Form","Page"],"box":[120,340,96,32],"fx":0.5,"fy":0.25},"viewport":[1280,800,1.5],"scroll":[0,120],"theme":"dark","screenshot":"../assets/mg1abc2def.png","errors":["TypeError: x is undefined"]} -->

Make this secondary.

Second paragraph with `code` and <b>html</b>.

![screenshot](../assets/mg1abc2def.png)

### [x] Text change · `h1` “Old title” · #title
<!-- redline {"id":"mg1abc3xyz","type":"text","page":"/agents","url":"http://localhost:5173/agents","at":"2026-10-13 10:05","target":{"tag":"h1","text":"Old title","id":"title"},"from":"Old\ntitle","to":"New title “quoted” & <tagged>"} -->

```diff
- Old
- title
+ New title “quoted” & <tagged>
```

> Changed in src/Page.astro:3.
> Second reply line.

### [ ] Sketch · whole page
<!-- redline {"id":"mg1abc4sk","type":"sketch","page":"/agents","url":"http://localhost:5173/agents","at":"2026-10-13 10:06","whole":true,"sketch":"../assets/mg1abc4sk.svg","screenshot":"../assets/mg1abc4sk.png"} -->

Move the chart here →

![screenshot](../assets/mg1abc4sk.png)

![sketch](../assets/mg1abc4sk.svg)
