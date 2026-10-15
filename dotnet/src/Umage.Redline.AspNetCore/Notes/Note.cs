using System.Text.Json.Nodes;

namespace Umage.Redline.Notes;

/// <summary>
/// One note. Mirrors <c>Note</c> in src/shared/types.ts: everything except body, reply and done is
/// kept as an ordered JSON object (<see cref="Data"/>), exactly as written in the markdown anchor
/// comment, so unknown fields survive and the bytes match the Node implementation.
/// </summary>
public sealed class Note
{
    static readonly HashSet<string> MarkdownOwned = new() { "body", "reply", "done" };

    public Note(JsonObject? data = null, string body = "", string reply = "", bool done = false)
    {
        Data = data ?? new JsonObject();
        Body = body;
        Reply = reply;
        Done = done;
    }

    /// <summary>The anchor fields (id, type, page, app, url, target, …), in order.</summary>
    public JsonObject Data { get; }
    public string Body { get; set; }
    public string Reply { get; set; }
    public bool Done { get; set; }
    /// <summary>Where the store keeps it (".redline/pages/x.md"); shown to the reviewer, never serialized into the markdown.</summary>
    public string? File { get; set; }

    public string? Id { get => Get("id"); set => Set("id", value); }
    public string? Type { get => Get("type"); set => Set("type", value); }
    public string? Page { get => Get("page"); set => Set("page", value); }
    public string? App { get => Get("app"); set => Set("app", value); }
    public string? Url { get => Get("url"); set => Set("url", value); }
    public string? At { get => Get("at"); set => Set("at", value); }
    public string? From { get => Get("from"); set => Set("from", value); }
    public string? To { get => Get("to"); set => Set("to", value); }
    public string? Screenshot { get => Get("screenshot"); set => Set("screenshot", value); }
    public string? Sketch { get => Get("sketch"); set => Set("sketch", value); }
    public string? Author { get => Get("author"); set => Set("author", value); }
    public JsonObject? Target => Data["target"] as JsonObject;

    public string? Get(string key) => Data[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>Set a field in place (keeps its position), or remove it when null.</summary>
    public void Set(string key, string? value)
    {
        if (value is null) Data.Remove(key);
        else Data[key] = value;
    }

    /// <summary>Add fields from an anchor comment the way Object.assign does (later values win, positions kept).</summary>
    public void Merge(JsonObject anchor)
    {
        foreach (var kv in anchor.ToList())
        {
            if (MarkdownOwned.Contains(kv.Key)) continue;
            anchor.Remove(kv.Key);
            Data[kv.Key] = kv.Value;
        }
    }

    /// <summary>The note as the HTTP API returns it (and as the overlay reads it).</summary>
    public JsonObject ToJson()
    {
        var o = new JsonObject();
        foreach (var kv in Data) o[kv.Key] = kv.Value?.DeepClone();
        o["body"] = Body;
        o["reply"] = Reply;
        o["done"] = Done;
        if (File is not null) o["file"] = File;
        return o;
    }

    /// <summary>Read the API shape back (body/reply/done, the rest as data; "file" dropped).</summary>
    public static Note FromJson(JsonObject o)
    {
        var n = new Note();
        foreach (var kv in o)
        {
            switch (kv.Key)
            {
                case "body": n.Body = kv.Value is JsonValue b && b.TryGetValue<string>(out var bs) ? bs : ""; break;
                case "reply": n.Reply = kv.Value is JsonValue r && r.TryGetValue<string>(out var rs) ? rs : ""; break;
                case "done": n.Done = kv.Value is JsonValue d && d.TryGetValue<bool>(out var db) && db; break;
                case "file": break;
                default: n.Data[kv.Key] = kv.Value?.DeepClone(); break;
            }
        }
        return n;
    }

    public Note Clone() => new((JsonObject)Data.DeepClone(), Body, Reply, Done) { File = File };
}

/// <summary>What PATCH /notes/:id may change.</summary>
public sealed class NotePatch
{
    public string? Body { get; set; }
    public string? Reply { get; set; }
    public bool? Done { get; set; }
    public string? To { get; set; }

    public static NotePatch FromJson(JsonObject? o)
    {
        static string? S(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        return new NotePatch
        {
            Body = S(o?["body"]),
            Reply = S(o?["reply"]),
            Done = o?["done"] is JsonValue d && d.TryGetValue<bool>(out var b) ? b : null,
            To = S(o?["to"]),
        };
    }

    public bool IsEmpty => Body is null && Reply is null && Done is null && To is null;

    public JsonObject ToJson()
    {
        var o = new JsonObject();
        if (Body is not null) o["body"] = Body;
        if (Reply is not null) o["reply"] = Reply;
        if (Done is not null) o["done"] = Done;
        if (To is not null) o["to"] = To;
        return o;
    }

    /// <summary>Apply to a note the way the markdown store does (to only on text notes).</summary>
    public void ApplyTo(Note n)
    {
        if (Body is not null) n.Body = Body;
        if (Reply is not null) n.Reply = Reply;
        if (To is not null && n.Type == "text") n.To = To;
        if (Done is not null) n.Done = Done.Value;
    }
}

/// <summary>POST /notes: the note as the overlay captured it, plus a PNG data URL and SVG.</summary>
public sealed class NewNoteRequest
{
    public NewNoteRequest(JsonObject note, string? screenshot = null, string? sketch = null)
    {
        Note = note;
        Screenshot = screenshot;
        Sketch = sketch;
    }

    public JsonObject Note { get; }
    /// <summary>data:image/png;base64,…</summary>
    public string? Screenshot { get; }
    /// <summary>Raw SVG.</summary>
    public string? Sketch { get; }
}
