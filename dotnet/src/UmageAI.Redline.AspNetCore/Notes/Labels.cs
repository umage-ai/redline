using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace UmageAI.Redline.Notes;

/// <summary>A label a reviewer can tag a note with (D46): a chip in the popover. Mirrors LabelDef in src/shared/labels.ts.</summary>
/// <param name="Name">What the note stores and its markdown heading shows, e.g. "Bug".</param>
/// <param name="Color">Any CSS colour, for the chip's dot and the card's tag.</param>
public sealed record RedlineLabel(string Name, string? Color = null)
{
    /// <summary>The default list: Bug, UX, Idea and Copy (DEFAULT_LABELS in src/shared/labels.ts).</summary>
    public static List<RedlineLabel> Defaults() => new()
    {
        new("Bug", "#ff5c5c"), new("UX", "#b48cff"), new("Idea", "#ffcc4d"), new("Copy", "#5cb8ff"),
    };
}

/// <summary>Cleaning labels the way src/shared/labels.ts does, so both servers store the same bytes.</summary>
public static class Labels
{
    static readonly Regex WsRun = new($"{Js.WhitespaceClass}+", RegexOptions.CultureInvariant);

    /// <summary>A label as stored: one line, trimmed, at most 30 characters; "" when there is none (cleanLabel).</summary>
    public static string Clean(JsonNode? v) =>
        v is JsonValue j && j.TryGetValue<string>(out var s) ? Clean(s) : "";

    public static string Clean(string? s)
    {
        var t = Js.Trim(WsRun.Replace(s ?? "", " "));
        return Js.Trim(t.Length > 30 ? t.Substring(0, 30) : t);
    }

    /// <summary>The list as /config hands it to the overlay: names cleaned, empty and duplicate names dropped (normalizeLabels).</summary>
    public static JsonArray ToConfig(IEnumerable<RedlineLabel> labels)
    {
        var out_ = new JsonArray();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var l in labels)
        {
            var name = Clean(l.Name);
            if (name.Length == 0 || !seen.Add(name)) continue;
            var o = new JsonObject { ["name"] = name };
            if (!string.IsNullOrWhiteSpace(l.Color)) o["color"] = l.Color.Trim();
            out_.Add(o);
        }
        return out_;
    }
}
