// The MCP tools of src/mcp.ts (list_notes, get_note, update_note) served over Streamable HTTP
// at POST /__redline/mcp (D35): JSON-RPC in, JSON out, stateless (no sessions, no SSE stream).
// Agents connect with { "type": "http", "url": "https://site/__redline/mcp",
// "headers": { "Authorization": "Bearer rl_…" } }.

using System.Globalization;
using System.Text.Json.Nodes;
using Umage.Redline.Notes;

namespace Umage.Redline.Mcp;

public sealed class RedlineMcp
{
    static readonly string[] Versions = { "2025-06-18", "2025-03-26", "2024-11-05" };

    const string Instructions = "Redline holds UI feedback a reviewer pinned on the running app. list_notes, then get_note for each open one "
        + "(look at the screenshot), make the change in the code following the repo's conventions, then update_note with done=true and a "
        + "one-line reply. Keep to what the note asks; apply notes on the same element oldest first. Text notes show the current and wanted text.";

    readonly INoteStore _store;
    readonly string _label;
    readonly string _version;

    public RedlineMcp(INoteStore store, string label, string version)
    {
        _store = store;
        _label = label;
        _version = version;
    }

    static JsonObject Tools() => new()
    {
        ["tools"] = new JsonArray(
            new JsonObject
            {
                ["name"] = "list_notes",
                ["description"] = "List Redline UI feedback notes (comments, text changes, sketches the reviewer pinned on the running app). Start here; open notes are the work to do.",
                ["inputSchema"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new JsonObject
                    {
                        ["status"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("open", "done", "all"), ["description"] = "Default: open" },
                        ["page"] = new JsonObject { ["type"] = "string", ["description"] = "Only notes for this page path, e.g. /settings" },
                        ["app"] = new JsonObject { ["type"] = "string", ["description"] = "Monorepos: only notes from this app folder, e.g. apps/web" },
                    },
                },
            },
            new JsonObject
            {
                ["name"] = "get_note",
                ["description"] = "One note in full: where the element is in source (target.source file:line, components; target.cms for CMS content), selector/test id/text to find it, the instruction or text diff, the reply, and the screenshot (the target outlined in red; sketches drawn on top).",
                ["inputSchema"] = new JsonObject { ["type"] = "object", ["properties"] = new JsonObject { ["id"] = new JsonObject { ["type"] = "string" } }, ["required"] = new JsonArray("id") },
            },
            new JsonObject
            {
                ["name"] = "update_note",
                ["description"] = "Close or answer a note. After applying it: done=true and a one-line reply saying what changed and where (end with the short commit hash if you committed). If it is ambiguous or conflicts: leave done unset and put your question in reply; the reviewer sees replies live.",
                ["inputSchema"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new JsonObject { ["id"] = new JsonObject { ["type"] = "string" }, ["reply"] = new JsonObject { ["type"] = "string" }, ["done"] = new JsonObject { ["type"] = "boolean" } },
                    ["required"] = new JsonArray("id"),
                },
            }),
    };

    /// <summary>Handle one JSON-RPC message; null for notifications (no reply).</summary>
    public async Task<JsonObject?> HandleAsync(JsonObject msg, CancellationToken ct = default)
    {
        var id = msg["id"]?.DeepClone();
        var method = msg["method"] is JsonValue m && m.TryGetValue<string>(out var s) ? s : null;
        var p = msg["params"] as JsonObject;
        JsonObject Reply(JsonNode result) => new() { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = result };
        JsonObject Fail(int code, string message) => new() { ["jsonrpc"] = "2.0", ["id"] = id, ["error"] = new JsonObject { ["code"] = code, ["message"] = message } };
        var isNotification = !msg.ContainsKey("id");

        switch (method)
        {
            case "initialize":
                var asked = p?["protocolVersion"]?.GetValue<string>() ?? "";
                return Reply(new JsonObject
                {
                    ["protocolVersion"] = Versions.Contains(asked) ? asked : Versions[0],
                    ["capabilities"] = new JsonObject { ["tools"] = new JsonObject() },
                    ["serverInfo"] = new JsonObject { ["name"] = "redline", ["version"] = _version },
                    ["instructions"] = Instructions,
                });
            case "ping": return isNotification ? null : Reply(new JsonObject());
            case "tools/list": return Reply(Tools());
            case "tools/call":
                var name = p?["name"]?.GetValue<string>() ?? "";
                var args = p?["arguments"] as JsonObject ?? new JsonObject();
                try { return Reply(new JsonObject { ["content"] = await CallAsync(name, args, ct) }); }
                catch (ToolError e) { return Reply(new JsonObject { ["content"] = new JsonArray(Text($"Error: {e.Message}")), ["isError"] = true }); }
            default:
                if (method is not null && method.StartsWith("notifications/", StringComparison.Ordinal)) return null;
                return isNotification ? null : Fail(-32601, $"method not found: {method}");
        }
    }

    sealed class ToolError : Exception { public ToolError(string m) : base(m) { } }

    static JsonObject Text(string text) => new() { ["type"] = "text", ["text"] = text };

    static string? Arg(JsonObject args, string key) => args[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    async Task<JsonArray> CallAsync(string name, JsonObject args, CancellationToken ct)
    {
        if (name == "list_notes")
        {
            var status = Arg(args, "status") ?? "open";
            var page = Arg(args, "page");
            var app = args.ContainsKey("app") ? Arg(args, "app") ?? "" : null;
            var notes = (await _store.ListAsync(ct)).Where(n =>
                (status == "all" || (status == "done") == n.Done) &&
                (string.IsNullOrEmpty(page) || n.Page == page) && (app is null || (n.App ?? "") == app)).ToList();
            var head = $"{notes.Count} {(status == "all" ? "" : status + " ")}note{(notes.Count == 1 ? "" : "s")} from {_label}";
            return new JsonArray(Text(notes.Count > 0 ? $"{head}:\n\n{string.Join("\n\n", notes.Select(Summary))}" : head + "."));
        }
        var id = Arg(args, "id") ?? "";
        if (name == "get_note")
        {
            var n = (await _store.ListAsync(ct)).FirstOrDefault(x => x.Id == id) ?? throw new ToolError($"no note with id {id}");
            var outp = new JsonArray(Text($"{(n.File is not null ? $"In {n.File}:\n\n" : "")}{NoteFormat.SerializeNote(n).Trim()}"));
            if (n.Screenshot is { Length: > 0 } shot && await _store.AssetAsync(shot.Split('/').Last(), ct) is { } a)
                outp.Add(new JsonObject { ["type"] = "image", ["data"] = Convert.ToBase64String(a.Data), ["mimeType"] = a.ContentType });
            return outp;
        }
        if (name == "update_note")
        {
            var patch = new NotePatch();
            if (Arg(args, "reply") is { } reply) patch.Reply = System.Text.RegularExpressions.Regex.Replace(reply, @"\s*\n\s*", " ").Trim();
            if (args["done"] is JsonValue d && d.TryGetValue<bool>(out var done)) patch.Done = done;
            if (patch.IsEmpty) throw new ToolError("give reply and/or done");
            var n = await _store.UpdateAsync(id, patch, ct) ?? throw new ToolError($"no note with id {id}");
            return new JsonArray(Text(Summary(n)));
        }
        throw new ToolError($"unknown tool {name}");
    }

    static string Summary(Note n)
    {
        var where = string.Join(" · ", new[] { n.Page, string.IsNullOrEmpty(n.App) ? "" : $"app {n.App}" }.Where(x => !string.IsNullOrEmpty(x)));
        var lines = new List<string>
        {
            $"- {n.Id} [{(n.Done ? "done" : "open")}] {System.Text.RegularExpressions.Regex.Replace(NoteFormat.HeadingFor(n), @"^### \[[ x]\] ", "")}",
            $"  {where} · {RelativeAge(n.At) ?? n.At}" + (string.IsNullOrEmpty(n.Author) ? "" : $" · by {n.Author}"),
        };
        if (n.Type == "text") { lines.Add($"  - {n.From ?? ""}"); lines.Add($"  + {n.To ?? ""}"); }
        if (n.Body.Length > 0) lines.AddRange(n.Body.Split('\n').Select(l => $"  {l}"));
        if (n.Reply.Length > 0) lines.Add($"  > {n.Reply}");
        return string.Join("\n", lines);
    }

    /// <summary>Port of relativeAge in src/shared/age.ts.</summary>
    public static string? RelativeAge(string? at, DateTime? now = null)
    {
        if (at is null || !DateTime.TryParseExact(at, "yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var t)) return null;
        var min = Math.Max(0, (int)Math.Floor(((now ?? DateTime.Now) - t).TotalMinutes));
        static string N(int v, string unit) => $"{v} {unit}{(v == 1 ? "" : "s")} ago";
        if (min < 1) return "just now";
        if (min < 60) return $"{min} min ago";
        var h = min / 60;
        if (h < 24) return $"{h} h ago";
        var d = h / 24;
        if (d < 14) return N(d, "day");
        if (d < 60) return N(d / 7, "week");
        if (d < 365) return N(d / 30, "month");
        return N(d / 365, "year");
    }
}
