# Redline — /da/om-os

<!--
  Written by the Redline overlay (dev only) for a coding agent. The full guide is the
  redline skill (.agents/skills/redline/SKILL.md, installed by `npx redline init`).
  Each note: a "### [ ]" heading naming the element and where it lives in source,
  an anchor comment (JSON: url, selector, xpath, source file:line, component chain,
  viewport, app folder in a monorepo, …; paths are repo-relative), the instruction, optional screenshot/sketch images, and an optional
  "> " reply. Screenshots mark the target with a red box.
  To close a note: tick it ("### [x]") and add a one-line "> " reply saying what
  changed. To ask back: leave it open and put the question in the reply.
  Never edit or delete the <!-- redline … --> comment; never reorder notes.
-->

Page: http://localhost:5173/da/om-os?q=1#top

### [ ] Comment · `p` “Ærlig talt — æøå ÆØÅ 😀 emoji, tab here, a really…” · <Om>
<!-- redline {"id":"mg2uni0001","type":"comment","page":"/da/om-os","url":"http://localhost:5173/da/om-os?q=1#top","at":"2026-10-14 08:30","target":{"tag":"p","text":"Ærlig talt — æøå ÆØÅ 😀 emoji, tab\there, a really long paragraph text that goes on and on beyond fifty characters","html":"<p>Ærlig talt — æøå</p>","components":["Om","Layout"],"fx":0.123,"fy":1e-7}} -->

Brug “gåseøjne” og emoji 🎉. Backslash \ and "quotes" and </script> and -->.

- list item
- another

### [ ] Comment · `div` · src/components/Card.tsx
<!-- redline {"id":"mg2uni0002","type":"comment","page":"/da/om-os","url":"http://localhost:5173/da/om-os?q=1#top","at":"2026-10-14 08:31","target":{"tag":"div","source":{"file":"src/components/Card.tsx"},"html":"control \u0001 char, \u001f,  del and \u2028 line sep"}} -->

No line number in the source.

> Which card? There are three.

### [x] Comment · `nav` · <Header>
<!-- redline {"id":"mg2uni0003","type":"comment","page":"/da/om-os","url":"http://localhost:5173/da/om-os?q=1#top","at":"2026-10-14 08:32","target":{"tag":"nav","components":["Header","Layout"]}} -->

Component only, no source.
