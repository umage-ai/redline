// Markdown <-> notes: a port of src/server/format.ts that writes the same bytes. The markdown is
// the single source of truth: the overlay writes it through the store, an agent edits it by hand
// (ticks [x], adds "> " replies). Keep the two in step: the golden fixtures in test/golden are run
// by both test suites (test/unit/golden.test.ts and dotnet/tests GoldenTests).

using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Umage.Redline.Notes;

public static class NoteFormat
{
    const string S = Js.WhitespaceClass;
    // JS `.` stops at \n, \r, U+2028 and U+2029; JS `$` (no m flag) only matches at the very end.
    const string Dot = @"[^\n\r\u2028\u2029]";
    static readonly Regex AnchorRe = new($@"^<!--{S}*redline{S}+(\{{{Dot}*\}}){S}*-->{S}*\z", RegexOptions.CultureInvariant);
    static readonly Regex HeadRe = new($@"^###{S}+\[([ xX])\]", RegexOptions.CultureInvariant);
    static readonly Regex AssetRe = new($@"^!\[(screenshot|sketch)\]\({Dot}*\){S}*\z", RegexOptions.CultureInvariant);
    static readonly Regex ReplyRe = new($@"^>{S}?", RegexOptions.CultureInvariant);
    static readonly Regex WsRun = new($@"{S}+", RegexOptions.CultureInvariant);

    public const string PagePreamble = """
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
""";

    static readonly Dictionary<string, string> TypeLabel = new() { ["comment"] = "Comment", ["sketch"] = "Sketch", ["text"] = "Text change" };

    public static string Clip(string? s, int n)
    {
        var t = Js.Trim(WsRun.Replace(s ?? "", " "));
        return t.Length > n ? Js.TrimEnd(t.Substring(0, n - 1)) + "…" : t;
    }

    static string? Str(JsonNode? n) => n is null ? null : Js.Str(n);

    /// <summary>Property access like JS `a?.b`: null unless <paramref name="n"/> is an object.</summary>
    static JsonNode? P(JsonNode? n, string key) => n is JsonObject o ? o[key] : null;

    /// <summary>JSON.parse: duplicate keys allowed (the last wins, at the first position), numbers as doubles.</summary>
    public static JsonNode? ParseJson(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return Convert(doc.RootElement);
    }

    static JsonNode? Convert(JsonElement e)
    {
        switch (e.ValueKind)
        {
            case JsonValueKind.Object:
                var o = new JsonObject();
                foreach (var p in e.EnumerateObject()) o[p.Name] = Convert(p.Value);
                return o;
            case JsonValueKind.Array:
                var a = new JsonArray();
                foreach (var x in e.EnumerateArray()) a.Add(Convert(x));
                return a;
            case JsonValueKind.String: return JsonValue.Create(e.GetString()!);
            case JsonValueKind.Number: return JsonValue.Create(e.GetDouble());
            case JsonValueKind.True: return JsonValue.Create(true);
            case JsonValueKind.False: return JsonValue.Create(false);
            default: return null;
        }
    }

    public static string HeadingFor(Note n)
    {
        var parts = new List<string>();
        var type = n.Data["type"];
        parts.Add(type is null ? "" : TypeLabel.TryGetValue(Js.Str(type), out var label) ? label : Js.Str(type));
        var t = n.Data["target"];
        if (Js.Truthy(n.Data["whole"]) || !Js.Truthy(t)) parts.Add("whole page");
        else
        {
            var tag = P(t, "tag");
            var text = P(t, "text");
            parts.Add($"`{(tag is null ? "element" : Js.Str(tag))}`" + (Js.Truthy(text) ? $" “{Clip(Js.Str(text), 50)}”" : ""));
            if (Js.Truthy(P(t, "testid"))) parts.Add($"[data-testid=\"{Js.Str(P(t, "testid"))}\"]");
            else if (Js.Truthy(P(t, "id"))) parts.Add($"#{Js.Str(P(t, "id"))}");
            var cms = P(t, "cms");
            if (Js.Truthy(P(cms, "property")))
            {
                var what = string.Join(" ", new[] { P(cms, "type"), P(cms, "content") }.Where(Js.Truthy).Select(Js.Str));
                var name = Js.Truthy(P(cms, "name")) ? $" “{Clip(Js.Str(P(cms, "name")), 40)}”" : "";
                parts.Add($"CMS {(what.Length > 0 ? what : "content")}{name} › {Js.Str(P(cms, "property"))}");
            }
            else if (Js.Truthy(P(t, "source")))
            {
                var src = P(t, "source")!;
                parts.Add(Js.Str(P(src, "file")) + (Js.Truthy(P(src, "line")) ? $":{Js.Str(P(src, "line"))}" : ""));
            }
            else if (P(t, "components") is JsonArray comps && comps.Count > 0) parts.Add($"<{Js.Str(comps[0])}>");
        }
        return $"### [{(n.Done ? "x" : " ")}] {string.Join(" · ", parts)}";
    }

    static string AnchorJson(Note n)
    {
        var meta = new JsonObject();
        var id = n.Data["id"];
        if (id is not null) meta["id"] = id.DeepClone();
        foreach (var kv in n.Data)
        {
            if (kv.Key == "id") continue;
            var v = kv.Value;
            if (v is null) continue;
            if (v is JsonValue jv && jv.GetValueKind() == JsonValueKind.String && jv.GetValue<string>().Length == 0) continue;
            meta[kv.Key] = v.DeepClone();
        }
        // "--" would end the HTML comment early; U+2028/2029 would end the line for the anchor regex (L30).
        return Js.Stringify(meta).Replace("--", "\\u002d\\u002d").Replace("\u2028", "\\u2028").Replace("\u2029", "\\u2029");
    }

    static string DiffBlock(Note n)
    {
        static string Lines(string s, string p) => string.Join("\n", s.Split('\n').Select(l => p + l));
        return "```diff\n" + Lines(Str(n.Data["from"]) ?? "", "- ") + "\n" + Lines(Str(n.Data["to"]) ?? "", "+ ") + "\n```\n";
    }

    public static string SerializeNote(Note n)
    {
        var md = new StringBuilder();
        md.Append(HeadingFor(n)).Append("\n<!-- redline ").Append(AnchorJson(n)).Append(" -->\n\n");
        if (n.Get("type") == "text") md.Append(DiffBlock(n)).Append('\n');
        var body = Js.Trim(n.Body);
        if (body.Length > 0) md.Append(body).Append("\n\n");
        if (Js.Truthy(n.Data["screenshot"])) md.Append($"![screenshot]({Js.Str(n.Data["screenshot"])})\n\n");
        if (Js.Truthy(n.Data["sketch"])) md.Append($"![sketch]({Js.Str(n.Data["sketch"])})\n\n");
        var reply = Js.Trim(n.Reply);
        if (reply.Length > 0) md.Append(string.Join("\n", reply.Split('\n').Select(l => "> " + l))).Append("\n\n");
        return md.ToString();
    }

    public static string SerializePage(string page, string? url, IReadOnlyList<Note> notes)
    {
        var app = notes.Count > 0 ? notes[0].Data["app"] : null;
        var md = new StringBuilder($"# Redline — {(Js.Truthy(app) ? Js.Str(app) + " · " : "")}{page}\n\n{PagePreamble}\n\n");
        if (!string.IsNullOrEmpty(url)) md.Append($"Page: {url}\n\n");
        foreach (var n in notes) md.Append(SerializeNote(n));
        var s = md.ToString();
        var end = s.Length;
        while (end > 0 && s[end - 1] == '\n') end--;
        return end == s.Length ? s : s.Substring(0, end) + "\n";
    }

    public static List<Note> ParsePage(string md)
    {
        var notes = new List<Note>();
        Note? cur = null;
        var body = new List<string>();
        var reply = new List<string>();
        var inDiff = false;

        void Flush()
        {
            if (cur is null) return;
            cur.Body = Js.Trim(string.Join("\n", body));
            cur.Reply = Js.Trim(string.Join("\n", reply));
            if (Js.Truthy(cur.Data["id"])) notes.Add(cur);
            cur = null; body = new(); reply = new();
        }

        foreach (var line in md.Replace("\r\n", "\n").Split('\n'))
        {
            var head = HeadRe.Match(line);
            if (head.Success)
            {
                Flush();
                cur = new Note(done: head.Groups[1].Value != " ");
                continue;
            }
            if (cur is null) continue;                       // preamble
            var anchor = AnchorRe.Match(line);
            if (anchor.Success)
            {
                try { if (ParseJson(anchor.Groups[1].Value) is JsonObject o) cur.Merge(o); }
                catch (Exception) { /* keep going */ }
                continue;
            }
            if (inDiff) { if (line.StartsWith("```", StringComparison.Ordinal)) inDiff = false; continue; }
            if (cur.Get("type") == "text" && line.StartsWith("```diff", StringComparison.Ordinal)) { inDiff = true; continue; }
            if (AssetRe.IsMatch(line)) continue;             // regenerated from the anchor
            if (ReplyRe.IsMatch(line)) { reply.Add(ReplyRe.Replace(line, "", 1)); continue; }
            body.Add(line);
        }
        Flush();
        return notes;
    }

    public static string PageSlug(string page)
    {
        var s = Regex.Replace(page, "^/+|/+$", "");
        // JS toLowerCase uses full case mapping: \u0130 becomes i + combining dot.
        s = s.Replace("\u0130", "i\u0307").ToLowerInvariant();
        s = Regex.Replace(s, "[^a-z0-9._-]+", "-");
        s = Regex.Replace(s, "^-+|-+$", "");
        if (s.Length == 0) return "index";
        if (s.Length <= 80) return s;
        var h = 0;
        unchecked { foreach (var c in s) h = h * 31 + c; }
        return s.Substring(0, 70) + "-" + Js.Base36((uint)h);
    }

    /// <summary>The page file name: one per URL path, prefixed with the app in a monorepo ("apps-web--settings.md").</summary>
    public static string PageFile(string page, string? app) => (string.IsNullOrEmpty(app) ? "" : PageSlug(app) + "--") + PageSlug(page) + ".md";

    public sealed record IndexRow(string Page, string? App, string File, int Open, int Done);

    public static string SerializeIndex(IReadOnlyList<IndexRow> pages)
    {
        var open = pages.Sum(p => p.Open);
        var md = new StringBuilder("# Redline — UI feedback\n\n<!-- Generated by Redline on every change; do not edit. Notes live in pages/*.md. -->\n\n");
        md.Append($"**{open} open note{(open == 1 ? "" : "s")}** across {pages.Count(p => p.Open > 0)} page(s).\n\n");
        if (pages.Count == 0) return md.ToString();
        var apps = pages.Any(p => !string.IsNullOrEmpty(p.App));
        md.Append(apps ? "| App | Page | Open | Done | File |\n|---|---|---:|---:|---|\n" : "| Page | Open | Done | File |\n|---|---:|---:|---|\n");
        // String.prototype.localeCompare: ICU root collation, as the invariant culture uses.
        var cmp = CultureInfo.InvariantCulture.CompareInfo;
        var sorted = pages.ToList();
        StableSort(sorted, (a, b) =>
        {
            var c = b.Open - a.Open;
            if (c != 0) return c;
            c = cmp.Compare(a.App ?? "", b.App ?? "", CompareOptions.None);
            return c != 0 ? c : cmp.Compare(a.Page, b.Page, CompareOptions.None);
        });
        foreach (var p in sorted)
        {
            var app = apps ? (!string.IsNullOrEmpty(p.App) ? $"`{p.App}`" : "(root)") + " | " : "";
            md.Append($"| {app}`{p.Page}` | {p.Open} | {p.Done} | [{p.File}]({p.File}) |\n");
        }
        return md.ToString();
    }

    static void StableSort<T>(List<T> list, Comparison<T> cmp)
    {
        var sorted = list.Select((x, i) => (x, i)).OrderBy(p => p, Comparer<(T x, int i)>.Create((a, b) => { var c = cmp(a.x, b.x); return c != 0 ? c : a.i - b.i; })).Select(p => p.x).ToList();
        list.Clear();
        list.AddRange(sorted);
    }
}
