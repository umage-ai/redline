// The /__redline HTTP API the overlay talks to (port of src/server/handler.ts), the remote MCP
// endpoint, and the <script> injection into HTML pages. Same routes and JSON shapes as Node, so
// the one browser bundle (dist/client.js) works unchanged.

using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Umage.Redline.Editing;
using Umage.Redline.Mcp;
using Umage.Redline.Notes;
using Umage.Redline.Security;

namespace Umage.Redline.Hosting;

public sealed class RedlineMiddleware
{
    public const string ApiBase = "/__redline";
    public const string Mark = "data-redline-client";
    internal const string OverlayKey = "Umage.Redline.Overlay";

    /// <summary>True while rendering a page that gets the overlay (dev, or an authorized reviewer online; not CMS edit mode).</summary>
    public static bool IsOverlayRequest(HttpContext? http) => http?.Items.ContainsKey(OverlayKey) == true;
    const int MaxBody = 30 * 1024 * 1024;
    static readonly string[] GuidePaths = { ".agents/skills/redline/SKILL.md", ".claude/skills/redline/SKILL.md", ".github/skills/redline/SKILL.md" };
    static readonly string Version = typeof(RedlineMiddleware).Assembly.GetName().Version?.ToString(3) ?? "0";

    readonly RequestDelegate _next;
    readonly RedlineRuntime _rt;
    readonly ILogger _log;

    public RedlineMiddleware(RequestDelegate next, RedlineRuntime rt, ILogger<RedlineMiddleware> log)
    {
        _next = next;
        _rt = rt;
        _log = log;
    }

    public async Task InvokeAsync(HttpContext http)
    {
        if (!_rt.Enabled) { await _next(http); return; }
        var path = http.Request.Path.Value ?? "";
        if (path.StartsWith(ApiBase + "/", StringComparison.Ordinal))
        {
            try { await Api(http, path.Substring(ApiBase.Length)); }
            catch (Exception ex) when (!http.Response.HasStarted)
            {
                _log.LogWarning(ex, "[redline] {Method} {Path} failed", http.Request.Method, path);
                await Json(http, 500, new JsonObject { ["error"] = ex.Message });
            }
            return;
        }
        if (!HttpMethods.IsGet(http.Request.Method) || !http.Request.Headers.Accept.ToString().Contains("text/html", StringComparison.OrdinalIgnoreCase)
            || _rt.Options.Exclude?.Invoke(http) == true || await _rt.ReviewerAsync(http) is null)
        {
            await _next(http);
            return;
        }
        http.Items[OverlayKey] = true;   // integrations stamp extra metadata only on these pages
        var original = http.Response.Body;
        var tag = $"<script type=\"module\" src=\"{http.Request.PathBase}{ApiBase}/client.js\" {Mark}></script>";
        var online = _rt.Options.Online;
        var stream = new HtmlInjectionStream(original, http.Response, tag);
        http.Response.OnStarting(() =>
        {
            if (!HtmlInjectionStream.Injects(http.Response)) return Task.CompletedTask;
            http.Response.Headers.ContentLength = null;   // the body grows by the tag
            // A page with the overlay is personal (online): never let a cache hand it to someone else.
            if (online) http.Response.Headers.CacheControl = "no-store, private";
            return Task.CompletedTask;
        });
        http.Response.Body = stream;
        try
        {
            await _next(http);
            await stream.CompleteAsync(http.RequestAborted);
        }
        finally { http.Response.Body = original; }
    }

    static async Task Json(HttpContext http, int status, JsonNode body)
    {
        http.Response.StatusCode = status;
        http.Response.ContentType = "application/json; charset=utf-8";
        http.Response.Headers.CacheControl = "no-store";
        await http.Response.WriteAsync(body.ToJsonString(), Encoding.UTF8);
    }

    static Task NotFound(HttpContext http) => Json(http, 404, new JsonObject { ["error"] = "not found" });

    static async Task<string> ReadBody(HttpContext http)
    {
        var len = http.Request.ContentLength;
        if (len > MaxBody) throw new InvalidOperationException("body too large");
        using var reader = new StreamReader(http.Request.Body, Encoding.UTF8);
        var buf = new char[8192];
        var sb = new StringBuilder();
        int n;
        while ((n = await reader.ReadAsync(buf, http.RequestAborted)) > 0)
        {
            sb.Append(buf, 0, n);
            if (sb.Length > MaxBody) throw new InvalidOperationException("body too large");
        }
        return sb.ToString();
    }

    static async Task<JsonObject?> ReadJson(HttpContext http) => NoteFormat.ParseJson(await ReadBody(http)) as JsonObject;

    async Task Api(HttpContext http, string p)
    {
        var method = http.Request.Method;
        if (p == "/mcp") { await McpEndpoint(http); return; }

        var reviewer = await _rt.ReviewerAsync(http);
        if (reviewer is null) { await NotFound(http); return; }   // online: nothing here for anonymous or unauthorized users
        if (http.Request.Host.HasValue) _rt.Register($"{http.Request.Scheme}://{http.Request.Host}");
        var store = _rt.Store;

        if (HttpMethods.IsGet(method) && p == "/client.js") { await Bytes(http, "text/javascript; charset=utf-8", _rt.ClientJs); return; }
        if (HttpMethods.IsGet(method) && p == "/config") { await Json(http, 200, Config(reviewer.Identity?.Name)); return; }
        if (HttpMethods.IsGet(method) && p.StartsWith("/assets/", StringComparison.Ordinal))
        {
            var a = await store.AssetAsync(p.Substring(8), http.RequestAborted);
            if (a is null) { await NotFound(http); return; }
            // SVG sketches are served as images, never as documents that could run script.
            http.Response.Headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'";
            http.Response.Headers["X-Content-Type-Options"] = "nosniff";
            await Bytes(http, a.ContentType, a.Data);
            return;
        }
        if (HttpMethods.IsGet(method) && p == "/ext/tokens.js" && PersonalTokens)
        {
            await Bytes(http, "text/javascript; charset=utf-8", RedlineRuntime.ReadResource("Umage.Redline.tokens.js"));
            return;
        }
        var ext = System.Text.RegularExpressions.Regex.Match(p, @"^/ext/(\d+)\.js$");
        if (HttpMethods.IsGet(method) && ext.Success)
        {
            var i = int.Parse(ext.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
            var file = i < _rt.Options.Extensions.Count ? Path.GetFullPath(Path.Combine(_rt.Context.ServerRoot, _rt.Options.Extensions[i])) : null;
            if (file is null || !File.Exists(file)) { await NotFound(http); return; }
            await Bytes(http, "text/javascript; charset=utf-8", await File.ReadAllBytesAsync(file, http.RequestAborted));
            return;
        }
        if (HttpMethods.IsGet(method) && p == "/notes")
        {
            var version = await store.VersionAsync(http.RequestAborted);
            if (http.Request.Headers.IfNoneMatch.ToString() == $"\"{version}\"") { http.Response.StatusCode = 304; return; }
            http.Response.Headers.ETag = $"\"{version}\"";
            var notes = await store.ListAsync(http.RequestAborted);
            await Json(http, 200, new JsonObject { ["version"] = version, ["root"] = store.Dir, ["notes"] = new JsonArray(notes.Select(n => (JsonNode)n.ToJson()).ToArray()) });
            return;
        }
        if (HttpMethods.IsGet(method) && p == "/tokens" && PersonalTokens)
        {
            var list = await _rt.Tokens!.TokensAsync(reviewer.Identity!.Name!, http.RequestAborted);
            await Json(http, 200, new JsonObject { ["tokens"] = new JsonArray(list.Select(t => (JsonNode)new JsonObject { ["id"] = t.Id, ["name"] = t.Name, ["created"] = t.Created.ToString("u"), ["lastUsed"] = t.LastUsed?.ToString("u") }).ToArray()) });
            return;
        }

        // Mutations need the custom header: a cross-site page can't send it without a CORS
        // preflight, which we never answer. Online (cookie auth) also checks the origin.
        if (http.Request.Headers["x-redline"] != "1") { await Json(http, 403, new JsonObject { ["error"] = "missing x-redline header" }); return; }
        if (_rt.Options.Online && !SameOrigin(http)) { await Json(http, 403, new JsonObject { ["error"] = "cross-origin request" }); return; }

        if (HttpMethods.IsPost(method) && p == "/notes")
        {
            var body = await ReadJson(http);
            var noteObj = body?["note"] as JsonObject;
            if (noteObj is null || !Js.Truthy(noteObj["page"]) || !Js.Truthy(noteObj["type"])) { await Json(http, 400, new JsonObject { ["error"] = "note.page and note.type are required" }); return; }
            noteObj = (JsonObject)noteObj.DeepClone();
            FixTarget(noteObj["target"] as JsonObject);
            // set here, never by the page
            noteObj.Remove("app");
            if (_rt.Context.App.Length > 0) noteObj["app"] = _rt.Context.App;
            noteObj.Remove("author");
            if (_rt.Options.Online && reviewer.Identity?.Name is { } who) noteObj["author"] = who;
            var draft = new Note(noteObj);
            await _rt.Hook(h => h.OnCreatingAsync(draft, http), "onCreating");
            var req = new NewNoteRequest(noteObj, Str(body!["screenshot"]), Str(body["sketch"]));
            var note = await store.CreateAsync(req, http.RequestAborted);
            await _rt.Hook(h => h.OnCreateAsync(note), "onCreate");
            await Json(http, 200, note.ToJson());
            return;
        }
        var m = System.Text.RegularExpressions.Regex.Match(p, "^/notes/([a-z0-9]+)$");
        if (m.Success && HttpMethods.IsPatch(method))
        {
            var patch = NotePatch.FromJson(await ReadJson(http));
            var n = await store.UpdateAsync(m.Groups[1].Value, patch, http.RequestAborted);
            if (n is null) { await NotFound(http); return; }
            await _rt.Hook(h => h.OnUpdateAsync(n, patch), "onUpdate");
            await Json(http, 200, n.ToJson());
            return;
        }
        if (m.Success && HttpMethods.IsDelete(method))
        {
            var id = m.Groups[1].Value;
            if (!await store.RemoveAsync(id, http.RequestAborted)) { await NotFound(http); return; }
            await _rt.Hook(h => h.OnRemoveAsync(id), "onRemove");
            await Json(http, 200, new JsonObject { ["ok"] = true });
            return;
        }
        if (HttpMethods.IsPost(method) && p == "/edit") { await Edit(http); return; }
        if (HttpMethods.IsPost(method) && p == "/tokens" && PersonalTokens)
        {
            var body = await ReadJson(http);
            var (token, hash) = RedlineTokens.Create();
            var id = await _rt.Tokens!.AddTokenAsync(reviewer.Identity!.Name!, Str(body?["name"]), hash, http.RequestAborted);
            await Json(http, 200, new JsonObject { ["id"] = id, ["token"] = token, ["url"] = $"{http.Request.Scheme}://{http.Request.Host}{http.Request.PathBase}{ApiBase}/mcp" });
            return;
        }
        var tm = System.Text.RegularExpressions.Regex.Match(p, "^/tokens/([A-Za-z0-9_-]+)$");
        if (tm.Success && HttpMethods.IsDelete(method) && PersonalTokens)
        {
            var ok = await _rt.Tokens!.RevokeTokenAsync(reviewer.Identity!.Name!, tm.Groups[1].Value, http.RequestAborted);
            await (ok ? Json(http, 200, new JsonObject { ["ok"] = true }) : NotFound(http));
            return;
        }
        await Json(http, 404, new JsonObject { ["error"] = "unknown endpoint" });
    }

    bool PersonalTokens => _rt.Options.Online && _rt.Options.Mcp.Enabled && _rt.Options.Mcp.PersonalTokens && _rt.Tokens is not null;

    JsonObject Config(string? user)
    {
        var ext = new JsonArray();
        for (var i = 0; i < _rt.Options.Extensions.Count; i++) ext.Add($"{ApiBase}/ext/{i}.js");
        foreach (var u in _rt.Options.ExtensionUrls) ext.Add(u);
        if (PersonalTokens) ext.Add($"{ApiBase}/ext/tokens.js");
        var guide = _rt.Options.Online ? null : GuidePaths.FirstOrDefault(g => File.Exists(Path.Combine(_rt.Context.Root, g)));
        var o = new JsonObject
        {
            ["hotkey"] = _rt.Options.Hotkey,
            ["launcher"] = _rt.Options.Launcher,
            ["dir"] = _rt.Store.Dir,
            ["app"] = _rt.Context.App,
            ["directEdit"] = _rt.Writers.Count > 0,
            ["extensions"] = ext,
            ["guide"] = guide,
        };
        if (_rt.Options.Online) { o["online"] = true; o["user"] = user; }
        return o;
    }

    void FixTarget(JsonObject? target)
    {
        if (target?["source"] is JsonObject src && src["file"] is JsonValue f && f.TryGetValue<string>(out var file) && file.Length > 0)
            src["file"] = RedlinePaths.NormaliseSource(file, _rt.Context.Root, _rt.Context.ServerRoot);
    }

    static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>A JSON number that is an integer (Number.isInteger), else null.</summary>
    static int? WholeNumber(JsonNode? n) => n is JsonValue v && v.TryGetValue<double>(out var d) && d == Math.Floor(d) && d >= int.MinValue && d <= int.MaxValue ? (int)d : null;

    static int? Int(JsonNode? n) => n is JsonValue v && v.TryGetValue<double>(out var d) ? (int)d : null;

    /// <summary>Online mode: a mutation must come from this site (Origin, else Sec-Fetch-Site).</summary>
    bool SameOrigin(HttpContext http)
    {
        var origin = http.Request.Headers.Origin.ToString();
        if (origin.Length > 0)
        {
            var self = $"{http.Request.Scheme}://{http.Request.Host}";
            return string.Equals(origin, self, StringComparison.OrdinalIgnoreCase) || _rt.Options.AllowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase);
        }
        var site = http.Request.Headers["Sec-Fetch-Site"].ToString();
        return site.Length == 0 || site is "same-origin" or "none";
    }

    async Task Edit(HttpContext http)
    {
        // Direct source edit (D20). ?inspect=1 returns the element's source tokens (for the rich
        // editor); ?dry=1 only checks, so the overlay can offer "Apply to file" or not.
        if (_rt.Writers.Count == 0) { await Json(http, 404, new JsonObject { ["error"] = "direct edits are off (DirectEdit option)" }); return; }
        var body = await ReadJson(http);
        var q = http.Request.Query;
        var inspect = q["inspect"] == "1";
        var from = Str(body?["from"]);
        var tag = Str(body?["tag"]);
        var to = Str(body?["to"]);
        if (from is null || tag is null || (!inspect && to is null)) { await Json(http, 400, new JsonObject { ["error"] = "from, to and tag are required" }); return; }
        SourceLoc? source = null;
        if (body!["source"] is JsonObject s && Str(s["file"]) is { Length: > 0 } file)
            source = new SourceLoc(RedlinePaths.NormaliseSource(file, _rt.Context.Root, _rt.Context.ServerRoot), Int(s["line"]), Int(s["col"]));
        var edit = new EditRequest
        {
            From = from, To = inspect ? from : to!, Html = Str(body["html"]), Tag = tag.ToLowerInvariant(),
            Url = Str(body["url"]) ?? "", Source = source,
            Nth = body["nth"] is JsonObject nth && WholeNumber(nth["index"]) is int index && WholeNumber(nth["count"]) is int count ? new Nth(index, count) : null, Cms = body["cms"]?.DeepClone() as JsonObject,
        };
        var dry = inspect || q["dry"] == "1";
        var ctx = new WriterContext
        {
            Root = _rt.Context.Root, ServerRoot = _rt.Context.ServerRoot, WebRoot = _rt.Context.WebRoot,
            DryRun = dry, Inspect = inspect, Online = _rt.Options.Online, HttpContext = http,
            Resolve = rel => SourceWriters.ResolveInside(_rt.Context.Root, _rt.Context.Dir, rel),
        };
        var result = await SourceWriters.RunAsync(_rt.Writers, edit, ctx, http.RequestAborted);
        if (result.Ok && !dry) await _rt.Hook(h => h.OnSourceWriteAsync(edit, result), "onSourceWrite");
        await Json(http, 200, result.ToJson());
    }

    /* ---------- remote MCP (D35) ---------- */

    async Task McpEndpoint(HttpContext http)
    {
        if (!_rt.Options.Mcp.Enabled) { await NotFound(http); return; }
        var user = await McpCaller(http);
        if (user is null)
        {
            http.Response.Headers.WWWAuthenticate = "Bearer realm=\"redline\"";
            await Json(http, 401, new JsonObject { ["error"] = "a bearer token is required" });
            return;
        }
        if (!HttpMethods.IsPost(http.Request.Method))
        {
            // No server-initiated stream: the tools are plain request/response.
            http.Response.Headers.Allow = "POST";
            http.Response.StatusCode = 405;
            return;
        }
        JsonNode? msg;
        try { msg = NoteFormat.ParseJson(await ReadBody(http)); }
        catch (JsonException) { await Json(http, 400, new JsonObject { ["jsonrpc"] = "2.0", ["id"] = null, ["error"] = new JsonObject { ["code"] = -32700, ["message"] = "parse error" } }); return; }
        var label = _rt.Options.Online ? $"{http.Request.Host} ({_rt.Store.Dir})" : $"dev server {http.Request.Scheme}://{http.Request.Host}";
        var mcp = new RedlineMcp(_rt.Store, label, Version);
        if (msg is JsonArray batch)
        {
            var replies = new JsonArray();
            foreach (var item in batch.OfType<JsonObject>()) if (await mcp.HandleAsync(item, http.RequestAborted) is { } r) replies.Add(r);
            if (replies.Count == 0) { http.Response.StatusCode = 202; return; }
            await Json(http, 200, replies);
            return;
        }
        if (msg is not JsonObject one) { await Json(http, 400, new JsonObject { ["error"] = "expected a JSON-RPC message" }); return; }
        var reply = await mcp.HandleAsync(one, http.RequestAborted);
        if (reply is null) { http.Response.StatusCode = 202; return; }
        await Json(http, 200, reply);
    }

    /// <summary>Who is calling the MCP endpoint: a configured or personal bearer token, or (dev, loopback, no tokens configured) the local agent.</summary>
    async Task<string?> McpCaller(HttpContext http)
    {
        var auth = http.Request.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            var token = auth.Substring(7).Trim();
            if (token.Length == 0) return null;
            if (RedlineTokens.Matches(token, _rt.Options.Mcp.TokenHashes)) return "token";
            if (_rt.Tokens is not null && _rt.Options.Mcp.PersonalTokens) return await _rt.Tokens.UserForTokenAsync(RedlineTokens.Hash(token), http.RequestAborted);
            return null;
        }
        if (!_rt.Options.Online && _rt.Options.Mcp.AllowLocalWithoutToken && _rt.Options.Mcp.TokenHashes.Count == 0
            && http.Connection.RemoteIpAddress is { } ip && IPAddress.IsLoopback(ip))
            return "local";
        return null;
    }

    static async Task Bytes(HttpContext http, string type, byte[] data)
    {
        http.Response.ContentType = type;
        http.Response.Headers.CacheControl = "no-store";
        http.Response.ContentLength = data.Length;
        await http.Response.Body.WriteAsync(data, http.RequestAborted);
    }
}
