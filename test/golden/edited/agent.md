# Redline — /checkout

Some preamble text a human added. It is not a note.

### [X] Comment · `button` “Pay” · src/Checkout.tsx:20
<!-- redline {"id":"mg4edit001","type":"comment","page":"/checkout","url":"http://localhost:5173/checkout","at":"2026-10-15 09:00","target":{"tag":"button","text":"Pay","source":{"file":"src/Checkout.tsx","line":20}}} -->
Make it green.
Second line right after.
> Done: now uses the success colour.
>Second reply line without space.

### [ ] This heading text is regenerated anyway
<!--   redline   {"id":"mg4edit002","type":"text","page":"/checkout","url":"http://localhost:5173/checkout","at":"2026-10-15 09:01","from":"Totl","to":"Total","done":true}   -->

```diff
- Totl
+ Total
```

   Indented body line.

![screenshot](../assets/whatever.png)

### [ ] A note without an anchor comment is dropped
Nothing here.

### [x] Broken anchor json keeps the note only if an id came from somewhere
<!-- redline {"id": broken} -->
Dropped too.

### [ ] Sketch
<!-- redline {"id":"mg4edit003","type":"sketch","page":"/checkout","url":"http://localhost:5173/checkout","at":"2026-10-15 09:02","whole":true,"sketch":"../assets/mg4edit003.svg","body":"ignored","reply":"ignored too"} -->
Body after.

![sketch](../assets/mg4edit003.svg)
> Question back?
