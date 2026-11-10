# Redline — /en/about

<!--
  Written by the Redline overlay (dev only) for a coding agent. The full guide is the
  redline skill, if this repo has it (`npx redline init`); this comment covers the basics.
  Each note: a "### [ ]" heading naming the reviewer's label if any (Bug, UX, …), the
  element and where it lives in source,
  an anchor comment (JSON: url, selector, xpath, source file:line, component chain,
  CMS content and property, host context (extra), viewport, app folder in a monorepo, …; paths are repo-relative), the instruction, optional screenshot/sketch images, and an optional
  "> " reply. Screenshots mark the target with a red box.
  To close a note: tick it ("### [x]") and add a one-line "> " reply saying what
  changed. To ask back: leave it open and put the question in the reply.
  Never edit or delete the <!-- redline … --> comment; never reorder notes.
-->

Page: https://cms.example/en/about

### [ ] Comment · `h2` “Our story” · CMS 42_7 › Heading
<!-- redline {"id":"mhextra1","type":"comment","page":"/en/about","url":"https://cms.example/en/about","at":"2026-11-10 09:00","target":{"tag":"h2","text":"Our story","cms":{"content":"42_7","property":"Heading","node":"c3f0-91ab","nodeType":"HeroBlock"},"extra":{"epiProperty":"MainBody","blockId":117,"variant":"B","flag":true,"ratio":0.25,"note":"a \u002d\u002d b \"q\""}}} -->

Shorter, please.
