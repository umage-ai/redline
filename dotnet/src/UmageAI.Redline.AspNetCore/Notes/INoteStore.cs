namespace UmageAI.Redline.Notes;

/// <summary>
/// Where notes are kept (D19). The markdown store is the default in development; online mode
/// uses a database (<see cref="SqlNoteStore"/>). <c>File</c> on a note is optional: it is only
/// shown to the reviewer and named in the copied agent prompt.
/// </summary>
public interface INoteStore
{
    /// <summary>Shown to the reviewer as where notes go (".redline", "database", a CMS name).</summary>
    string Dir { get; }
    /// <summary>Changes whenever any note changes; the overlay polls with it as an ETag, so keep it cheap.</summary>
    Task<string> VersionAsync(CancellationToken ct = default);
    Task<IReadOnlyList<Note>> ListAsync(CancellationToken ct = default);
    /// <summary>Assign the id (keep a valid requested one) and <c>at</c>, keep the screenshot/sketch, return the note.</summary>
    Task<Note> CreateAsync(NewNoteRequest req, CancellationToken ct = default);
    Task<Note?> UpdateAsync(string id, NotePatch patch, CancellationToken ct = default);
    Task<bool> RemoveAsync(string id, CancellationToken ct = default);
    /// <summary>A note's screenshot (<c>&lt;id&gt;.png</c>) or sketch (<c>&lt;id&gt;.svg</c>) by file name, or null.</summary>
    Task<NoteAsset?> AssetAsync(string name, CancellationToken ct = default);
}

public sealed record NoteAsset(string ContentType, byte[] Data);

public static class NoteIds
{
    /// <summary>Note ids are lowercase base36, 4–24 chars; custom stores should keep to it (the API routes on it).</summary>
    public static bool Valid(string? id) => id is { Length: >= 4 and <= 24 } && id.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9');

    public static string New()
    {
        Span<byte> b = stackalloc byte[2];
        System.Security.Cryptography.RandomNumberGenerator.Fill(b);
        return Js.Base36((ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) + Convert.ToHexString(b).ToLowerInvariant();
    }

    /// <summary>'YYYY-MM-DD HH:MM' in local time, as the Node store writes it.</summary>
    public static string Stamp(DateTime? at = null) => (at ?? DateTime.Now).ToString("yyyy-MM-dd HH:mm", System.Globalization.CultureInfo.InvariantCulture);

    internal static bool ValidAssetName(string name) =>
        System.Text.RegularExpressions.Regex.IsMatch(name, @"^[a-z0-9]+\.(png|svg)\z");

    /// <summary>The note built from a create request (id, at, markdown-owned fields), before assets are stored.</summary>
    public static Note FromRequest(NewNoteRequest req)
    {
        var data = (System.Text.Json.Nodes.JsonObject)req.Note.DeepClone();
        var requested = data["id"] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        var body = data["body"] is System.Text.Json.Nodes.JsonValue b && b.TryGetValue<string>(out var bs) ? bs : "";
        data.Remove("body"); data.Remove("reply"); data.Remove("done");
        var note = new Note(data, body);
        note.Id = Valid(requested) ? requested : New();
        note.At = Stamp();
        return note;
    }

    /// <summary>The PNG bytes of a data URL, or null.</summary>
    public static byte[]? Png(string? dataUrl)
    {
        const string prefix = "data:image/png;base64,";
        if (dataUrl is null || !dataUrl.StartsWith(prefix, StringComparison.Ordinal)) return null;
        try { return Convert.FromBase64String(dataUrl.Substring(prefix.Length)); } catch (FormatException) { return null; }
    }

    public static bool IsSvg(string? svg) => svg is not null && Js.TrimStart(svg).StartsWith("<svg", StringComparison.Ordinal);
}
