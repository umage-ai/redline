// Source writers: apply a text change straight to what renders it (D20), the port of
// src/server/writers.ts. Writers are tried in order; the first that returns a result (not null)
// decides. File writers are dev-only; online mode only runs writers that don't touch files
// (a CMS draft writer such as UmageAI.Redline.Optimizely's).

using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using UmageAI.Redline.Notes;

namespace UmageAI.Redline.Editing;

public sealed class EditRequest
{
    public required string From { get; init; }
    public required string To { get; init; }
    public string? Html { get; init; }
    public required string Tag { get; init; }
    public required string Url { get; init; }
    /// <summary>Where the element is written (repo-relative), when the page says.</summary>
    public SourceLoc? Source { get; set; }
    /// <summary>Several elements with this tag and text on the page: which one (static .html has no source location). D25.</summary>
    public Nth? Nth { get; init; }
    /// <summary>CMS content/property behind the element (data-redline-cms), when a CMS integration stamped it.</summary>
    public JsonObject? Cms { get; init; }
}

public sealed record SourceLoc(string File, int? Line, int? Col);

public sealed class Inspection
{
    public required List<Token> Tokens { get; init; }
    public bool Braces { get; init; }
    public bool SelfClose { get; init; }
    public bool Razor { get; init; }
    /// <summary>Characters the source writes as references ("—" → "&amp;mdash;"); new text keeps that spelling (D24).</summary>
    public Dictionary<string, string> Spell { get; init; } = new();
}

public sealed class EditResult
{
    public bool Ok { get; init; }
    public string? File { get; init; }
    public int? Line { get; init; }
    public string? Writer { get; init; }
    public string? Reason { get; init; }
    public Inspection? Inspect { get; init; }

    public static EditResult Fail(string reason, string? writer = null) => new() { Ok = false, Reason = reason, Writer = writer };

    public JsonObject ToJson()
    {
        var o = new JsonObject { ["ok"] = Ok };
        if (Ok)
        {
            o["file"] = File;
            if (Line is not null) o["line"] = Line;
            o["writer"] = Writer;
            if (Inspect is not null)
                o["inspect"] = new JsonObject
                {
                    ["tokens"] = new JsonArray(Inspect.Tokens.Select(t =>
                    {
                        var j = new JsonObject { ["k"] = t.K, ["raw"] = t.Raw };
                        if (t.Text is not null) j["text"] = t.Text;
                        if (t.Tag is not null) j["tag"] = t.Tag;
                        if (t.K == "open") j["close"] = t.Close;
                        return (JsonNode)j;
                    }).ToArray()),
                    // The rich editor encodes `{}` when braces is set; Razor has its own escape (@@),
                    // applied when the edit is written, so the overlay treats it like HTML.
                    ["braces"] = Inspect.Braces,
                    ["selfClose"] = Inspect.SelfClose,
                    ["spell"] = new JsonObject(Inspect.Spell.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)kv.Value))),
                };
        }
        else
        {
            o["reason"] = Reason;
            if (Writer is not null) o["writer"] = Writer;
        }
        return o;
    }
}

public sealed class WriterContext
{
    /// <summary>Repo root (notes and source paths are relative to it).</summary>
    public required string Root { get; init; }
    /// <summary>The app's content root.</summary>
    public required string ServerRoot { get; init; }
    /// <summary>wwwroot: where static .html pages are served from.</summary>
    public string? WebRoot { get; init; }
    public bool DryRun { get; init; }
    public bool Inspect { get; init; }
    /// <summary>Online mode: no source files to edit; only content writers run.</summary>
    public bool Online { get; init; }
    public HttpContext? HttpContext { get; init; }
    /// <summary>Repo-relative path → absolute, or null if it's outside the root, in node_modules/bin/obj or the notes folder.</summary>
    public required Func<string, string?> Resolve { get; init; }
}

public interface ISourceWriter
{
    string Name { get; }
    /// <summary>True when the writer edits files (dev only); false for content writers (CMS drafts) that may run online.</summary>
    bool WritesFiles { get; }
    /// <summary>null = not mine, try the next writer.</summary>
    Task<EditResult?> ApplyAsync(EditRequest req, WriterContext ctx, CancellationToken ct = default);
}

public static class SourceWriters
{
    // File types whose markup we can edit, and how expressions look in them.
    static readonly Dictionary<string, MarkupSyntax> Markup = new(StringComparer.OrdinalIgnoreCase)
    {
        [".cshtml"] = MarkupSyntax.Razor, [".razor"] = MarkupSyntax.Razor,
        [".html"] = MarkupSyntax.Html, [".htm"] = MarkupSyntax.Html,
        [".astro"] = MarkupSyntax.Braces, [".svelte"] = MarkupSyntax.Braces, [".jsx"] = MarkupSyntax.Braces, [".tsx"] = MarkupSyntax.Braces, [".vue"] = MarkupSyntax.Braces,
    };

    static readonly UTF8Encoding Utf8 = new(false);

    public static IReadOnlyList<ISourceWriter> Defaults() => new ISourceWriter[] { new MarkupWriter(), new StaticHtmlWriter() };

    /// <summary>Shared tail of the file writers: inspect, dry run or write what was located.</summary>
    internal static async Task<EditResult> Finish(string file, string rel, Located loc, string before, MarkupSyntax syntax, EditRequest req, string writer, WriterContext ctx, CancellationToken ct)
    {
        if (!loc.Ok) return EditResult.Fail(loc.Reason!, writer);
        var ext = Path.GetExtension(rel);
        if (ctx.Inspect)
            return new EditResult { Ok = true, File = rel, Line = loc.Line, Writer = writer, Inspect = new Inspection
            {
                Tokens = loc.Analysis!.Tokens!, Braces = syntax == MarkupSyntax.Braces, SelfClose = ext is ".jsx" or ".tsx", Razor = syntax == MarkupSyntax.Razor,
                Spell = SourceEdit.Spellings(string.Concat(loc.Analysis.Tokens!.Where(t => t.K == "text").Select(t => t.Raw))),
            } };
        var plan = SourceEdit.Apply(before, loc, req.To, req.Html, syntax);
        if (!plan.Ok) return EditResult.Fail(plan.Reason!, writer);
        if (!ctx.DryRun)
        {
            if (await File.ReadAllTextAsync(file, ct) != before) return EditResult.Fail("the file changed while editing; try again", writer);
            await File.WriteAllTextAsync(file, plan.Content!, HasBom(file) ? new UTF8Encoding(true) : Utf8, ct);
        }
        return new EditResult { Ok = true, File = rel, Line = plan.Line, Writer = writer };
    }

    static bool HasBom(string file)
    {
        using var f = File.OpenRead(file);
        Span<byte> b = stackalloc byte[3];
        return f.Read(b) == 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF;
    }

    /// <summary>Razor (.cshtml/.razor), plain .html and JS-framework templates: the element at the reported file:line:col.</summary>
    public sealed class MarkupWriter : ISourceWriter
    {
        public string Name => "markup";
        public bool WritesFiles => true;

        public async Task<EditResult?> ApplyAsync(EditRequest req, WriterContext ctx, CancellationToken ct = default)
        {
            var src = req.Source;
            if (src is null || string.IsNullOrEmpty(src.File) || src.Line is null) return null;
            if (!Markup.TryGetValue(Path.GetExtension(src.File), out var syntax)) return null;
            var file = ctx.Resolve(src.File);
            if (file is null) return EditResult.Fail($"{src.File} is outside the project", Name);
            string before;
            try { before = await File.ReadAllTextAsync(file, ct); }
            catch (IOException) { return EditResult.Fail($"can't read {src.File}", Name); }
            var loc = SourceEdit.LocateAt(before, req.Tag, src.Line.Value, src.Col, req.From, syntax);
            return await Finish(file, src.File, loc, before, syntax, req, Name, ctx, ct);
        }
    }

    /// <summary>
    /// Plain .html pages served from wwwroot (no source location): the one element with exactly this
    /// text, or the <see cref="EditRequest.Nth"/> one when the file has as many such elements as the page.
    /// </summary>
    public sealed class StaticHtmlWriter : ISourceWriter
    {
        public string Name => "static-html";
        public bool WritesFiles => true;

        public async Task<EditResult?> ApplyAsync(EditRequest req, WriterContext ctx, CancellationToken ct = default)
        {
            if (!string.IsNullOrEmpty(req.Source?.File) || ctx.WebRoot is null) return null;
            string p;
            try { p = Uri.UnescapeDataString(new Uri(req.Url).AbsolutePath); } catch (UriFormatException) { return null; }
            var candidates = p.EndsWith('/') ? new[] { p + "index.html" }
                : System.Text.RegularExpressions.Regex.IsMatch(p, @"\.html?$") ? new[] { p } : new[] { p + ".html", p + "/index.html" };
            foreach (var c in candidates)
            {
                var abs = Path.GetFullPath(Path.Combine(ctx.WebRoot, c.TrimStart('/')));
                var rel = Path.GetRelativePath(ctx.Root, abs).Replace('\\', '/');
                var file = ctx.Resolve(rel);
                if (file is null || !File.Exists(file)) continue;
                var before = await File.ReadAllTextAsync(file, ct);
                return await Finish(file, rel, SourceEdit.LocateUnique(before, req.Tag, req.From, MarkupSyntax.Html, req.Nth), before, MarkupSyntax.Html, req, Name, ctx, ct);
            }
            return null;
        }
    }

    public static async Task<EditResult> RunAsync(IEnumerable<ISourceWriter> writers, EditRequest req, WriterContext ctx, CancellationToken ct = default)
    {
        if (!ctx.Inspect && req.Html is null)
        {
            if (req.To.Contains('\n') || req.To.Contains('\r')) return EditResult.Fail("line breaks need markup; save it as a note instead");
            if (req.To == req.From) return EditResult.Fail("nothing changed");
        }
        foreach (var w in writers)
        {
            if (ctx.Online && w.WritesFiles) continue;
            var r = await w.ApplyAsync(req, ctx, ct);
            if (r is not null) return r;
        }
        return EditResult.Fail(req.Source is { File: { Length: > 0 } f } ? $"no writer handles {(Path.GetExtension(f) is { Length: > 0 } e ? e : f)}" : "the page reports no source location for this element");
    }

    /// <summary>The guard behind <see cref="WriterContext.Resolve"/>.</summary>
    public static string? ResolveInside(string root, string notesDir, string rel)
    {
        var abs = Path.GetFullPath(Path.Combine(root, rel));
        var r = Path.GetRelativePath(root, abs);
        if (r == "." || r.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(r)) return null;
        var parts = r.Split('\\', '/');
        if (parts.Contains("node_modules") || parts.Contains(".git") || parts.Contains("bin") || parts.Contains("obj")) return null;
        if (r.Replace('\\', '/').StartsWith(notesDir.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase)) return null;
        return abs;
    }
}
