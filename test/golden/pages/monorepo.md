# Redline — apps/web · /settings

<!--
  Written by the Redline overlay (dev only) for a coding agent. The full guide is the
  redline skill (.agents/skills/redline/SKILL.md, installed by `npx redline init`).
  Each note: a "### [ ]" heading naming the reviewer's label if any (Bug, UX, …), the
  element and where it lives in source,
  an anchor comment (JSON: url, selector, xpath, source file:line, component chain,
  CMS content and property, viewport, app folder in a monorepo, …; paths are repo-relative), the instruction, optional screenshot/sketch images, and an optional
  "> " reply. Screenshots mark the target with a red box.
  To close a note: tick it ("### [x]") and add a one-line "> " reply saying what
  changed. To ask back: leave it open and put the question in the reply.
  Never edit or delete the <!-- redline … --> comment; never reorder notes.
-->

Page: http://localhost:5174/settings

### [ ] Comment · `label` “E-mail” · [data-testid="email-label"] · apps/web/src/Settings.vue:10
<!-- redline {"id":"mg3mono001","type":"comment","page":"/settings","app":"apps/web","url":"http://localhost:5174/settings","at":"2026-10-15 12:00","target":{"tag":"label","testid":"email-label","text":"E-mail","source":{"file":"apps/web/src/Settings.vue","line":10,"col":3}},"author":"anna@example.com"} -->

Say “Email”.

### [ ] Text change · `h2` “Welcome” · CMS StartPage 5_12 “Start page” › Heading
<!-- redline {"id":"mg3mono002","type":"text","page":"/settings","app":"apps/web","url":"http://localhost:5174/settings","at":"2026-10-15 12:01","target":{"tag":"h2","text":"Welcome","source":{"file":"Views/Home/Index.cshtml","line":7,"col":5},"cms":{"content":"5_12","property":"Heading","name":"Start page","type":"StartPage","lang":"en","edit":"/EPiServer/CMS/#context=epi.cms.contentdata:///5_12"}},"from":"Welcome","to":"Welcome back"} -->

```diff
- Welcome
+ Welcome back
```

### [ ] Comment · `p` · CMS content › MainBody
<!-- redline {"id":"mg3mono003","type":"comment","page":"/settings","app":"apps/web","url":"http://localhost:5174/settings","at":"2026-10-15 12:02","target":{"tag":"p","cms":{"property":"MainBody"},"source":{"file":"Views/Shared/Layout.cshtml","line":3}},"extra":{"custom":["kept",1,true,null],"big":12345678901234567000,"neg":-0.5}} -->

Unknown keys survive.
