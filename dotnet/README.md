# Redline for .NET

> **Upcoming.** These packages are not published to NuGet yet; they are still being tested. Build them from this
> repo with `dotnet pack dotnet/Redline.slnx -o <folder>` and add that folder as a local package source to try them.

Redline is a review overlay for web UIs: a reviewer pins comments, text changes and sketches on the
running app (Alt+Shift+R), and an AI agent applies them. These packages bring it to ASP.NET Core:
Razor Pages, MVC, Blazor (Server, WebAssembly, streaming, enhanced navigation) and Optimizely CMS 12/13.
The overlay in the browser is the same one the npm package ships; notes are the same markdown, so the
same agent guide (`npx @umage.ai/redline init`) and `redline mcp` work. Product overview:
[github.com/umage-ai/redline](https://github.com/umage-ai/redline).

| Package | For |
|---|---|
| `UmageAI.Redline.AspNetCore` | Any ASP.NET Core app (.NET 8, 9, 10). Brings `UmageAI.Redline.Build`. |
| `UmageAI.Redline.Build` | Source stamps on `.cshtml`/`.razor` (Debug builds). Reference it directly in a Blazor `.Client` project. |
| `UmageAI.Redline.Optimizely` | Optimizely CMS 12 (.NET 8) and 13 (.NET 10). |

## Setup

```bash
dotnet add package UmageAI.Redline.AspNetCore
```

```csharp
builder.Services.AddRedline();                         // Development only, middleware first in the pipeline
builder.Services.AddRedline(o => o.DirectEdit = true); // text mode may write static text into .cshtml/.razor
```

Run the app in Development and press **Alt+Shift+R**. Notes land in `<repo>/.redline/` (the nearest
folder with `.git`); add `.redline/` to `.gitignore` and install the agent guide with
`npx @umage.ai/redline init`. Settings can also come from configuration (`"Redline": { "Dir": … }`).
`o.PageKey = RedlinePageKey.Path` groups notes by path only, so a page whose views are hash links
(a slide deck's `#/3`) keeps one notes file; the default `Route` also splits by `#/…` routes.

Blazor WebAssembly components live in the `.Client` project; give it the stamps too:
`<PackageReference Include="UmageAI.Redline.Build" Version="…" PrivateAssets="all" />`.

## What a note knows

- **Source line.** Razor keeps no source positions at runtime, so a Debug build compiles copies of the
  `.cshtml`/`.razor` files in which each HTML element carries `data-redline-src="path:line:col"`
  (`obj/…/redline-src/`; lines are unchanged and PDBs map back to the originals, so breakpoints and
  errors point at your files). Components, tag helpers (`<partial>`, `<environment>`), `<text>` and
  head elements are not stamped. Off in Release, design-time and `dotnet watch` builds;
  `<RedlineSourceStamps>false</RedlineSourceStamps>` turns it off, `true` forces it on.
- **Component chain** from the stamped ancestors (`Counter`, `MainLayout`, `App`).
- **CMS content** (Optimizely): content id, name, type, language, edit link and property.
- Everything else the overlay records anywhere: selector, test id, text, screenshot, viewport.

## Direct edits

With `DirectEdit`, text mode writes the change into the `.cshtml`/`.razor` file when the element's
content there is static: text and inline markup. Anything with `@` (expressions, code, directive
attributes), tag helpers (`asp-*`) and components is refused, and the edit is saved as a note instead.
A typed `@` is written as `@@`. Character references compare decoded (the full HTML set: `&mdash;`,
`&rarr;`, …), and new text keeps the file's spelling (a file that writes `&mdash;` keeps `&mdash;`).
Plain `.html` pages in `wwwroot` have no source line: the element with that text is edited, and when
several show the same text, the one the reviewer picked, provided the file has as many as the page.

## Optimizely CMS

```csharp
services.AddCms();
services.AddRedlineOptimizely();   // after AddCms
```

```cshtml
@* _ViewImports.cshtml: lets epi-property elements say which property they show *@
@addTagHelper *, UmageAI.Redline.Optimizely
```

- The overlay runs in view mode, never in the CMS UI or edit/preview frames (Optimizely's own
  on-page editing owns those).
- `Html.PropertyFor`, `epi-property` and content area items mark their output with
  `data-redline-cms="<content id>|<property>"` (only on pages that get the overlay). A note on CMS text
  names the content and property ("CMS StartPage 6 “Start” › Heading") instead of the template line.
- Text mode on a plain string property saves a **draft** of the content (never published), with the
  signed-in editor's own access rights. Rich text, content areas and other types become notes.

## Online mode (staging, production)

```csharp
services.AddRedline(o =>
{
    o.Online = true;
    o.Policy = "Reviewers";                 // or o.Roles.Add("WebEditors")
    o.UseSqlStore(() => new SqlConnection(cs));
});
```

Only signed-in users who pass the policy (or have one of the roles) get the overlay and the
`/__redline` API; everyone else gets no script and 404s. Mutations need the `x-redline` header and a
same-origin request. Notes go to the database (four `Redline*` tables, created on first use; SQL
Server or SQLite) and record the author. File writers are off; Optimizely content drafts still work.
`AddRedlineOptimizely` with `o.Online = true` defaults to the editor roles and the CMS database.

## Agents: MCP

- **Development:** `npx @umage.ai/redline mcp` finds the running app through `.redline/servers.json`.
- **Remote (any mode):** `POST /__redline/mcp` serves the same tools (`list_notes`, `get_note`,
  `update_note`) over MCP's Streamable HTTP transport. It needs a bearer token: a site token
  (configure its SHA-256 in `o.Mcp.TokenHashes`; make one with `RedlineTokens.Create()`) or, online,
  a personal token a reviewer creates in the overlay's panel ("Agent access"). In development,
  loopback requests need no token unless site tokens are configured.

```json
{ "mcpServers": { "redline": { "type": "http", "url": "https://site.example/__redline/mcp",
  "headers": { "Authorization": "Bearer rl_…" } } } }
```

That is `.mcp.json` for Claude Code; Cursor (`.cursor/mcp.json`) and VS Code (`.vscode/mcp.json`,
under `"servers"`) take the same entry.

## Limits

- The overlay calls `/__redline` at the site root; apps under a `PathBase` aren't supported yet.
- Responses compressed by the app (gzip/br before Redline's middleware) get no overlay.
- Hot reload compiles the original files: elements of an edited component lose their stamp until the
  next build.
