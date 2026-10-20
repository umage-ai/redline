using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace UmageAI.Redline.Notes;

/// <summary>
/// Notes on another server, over the remote store protocol (docs/PROTOCOL.md, D40); the C# twin of
/// <c>remoteStore</c> in src/server/remote.ts. This server holds the token and makes the calls; the
/// browser keeps talking to /__redline on its own origin. The store's refusals ("switched off for
/// this project") come back as <see cref="InvalidOperationException"/> with the store's own words.
/// The change feed (GET /events) is not used here yet: the overlay polls.
/// </summary>
public sealed class RemoteNoteStore : INoteStore
{
    static readonly HttpClient Shared = new() { Timeout = TimeSpan.FromSeconds(10) };
    readonly HttpClient _http;
    readonly string _base;
    readonly string? _token;

    public RemoteNoteStore(string url, string? token = null, HttpClient? http = null)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps))
            throw new ArgumentException($"Redline remote store: url must be http(s), got \"{url}\"", nameof(url));
        _base = url.TrimEnd('/');
        _token = string.IsNullOrEmpty(token) ? null : token;
        _http = http ?? Shared;
        Dir = u.Authority;
    }

    public string Dir { get; }

    HttpRequestMessage Request(HttpMethod method, string path, JsonNode? body = null)
    {
        var req = new HttpRequestMessage(method, _base + path);
        if (_token is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (body is not null) req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        return req;
    }

    static async Task<Exception> Fail(HttpResponseMessage r, CancellationToken ct)
    {
        string? msg = null;
        try { msg = (JsonNode.Parse(await r.Content.ReadAsStringAsync(ct)) as JsonObject)?["error"]?.GetValue<string>(); } catch { /* not JSON */ }
        return new InvalidOperationException(string.IsNullOrEmpty(msg) ? $"note store answered {(int)r.StatusCode} {r.ReasonPhrase}".Trim() : msg);
    }

    async Task<JsonNode?> Send(HttpMethod method, string path, JsonNode? body, CancellationToken ct, bool notFoundIsNull = false)
    {
        using var r = await _http.SendAsync(Request(method, path, body), ct);
        if (notFoundIsNull && r.StatusCode == HttpStatusCode.NotFound) return null;
        if (!r.IsSuccessStatusCode) throw await Fail(r, ct);
        return JsonNode.Parse(await r.Content.ReadAsStringAsync(ct));
    }

    public async Task<string> VersionAsync(CancellationToken ct = default) =>
        (await Send(HttpMethod.Get, "/version", null, ct))?["version"]?.GetValue<string>() ?? "";

    public async Task<IReadOnlyList<Note>> ListAsync(CancellationToken ct = default)
    {
        var notes = (await Send(HttpMethod.Get, "/notes", null, ct))?["notes"] as JsonArray;
        return notes?.OfType<JsonObject>().Select(Note.FromJson).ToList() ?? new List<Note>();
    }

    public async Task<Note> CreateAsync(NewNoteRequest req, CancellationToken ct = default)
    {
        var body = new JsonObject { ["note"] = req.Note.DeepClone() };
        if (req.Screenshot is not null) body["screenshot"] = req.Screenshot;
        if (req.Sketch is not null) body["sketch"] = req.Sketch;
        return Note.FromJson((JsonObject)(await Send(HttpMethod.Post, "/notes", body, ct))!);
    }

    public async Task<Note?> UpdateAsync(string id, NotePatch patch, CancellationToken ct = default) =>
        await Send(HttpMethod.Patch, $"/notes/{Uri.EscapeDataString(id)}", patch.ToJson(), ct, notFoundIsNull: true) is JsonObject o ? Note.FromJson(o) : null;

    public async Task<bool> RemoveAsync(string id, CancellationToken ct = default) =>
        await Send(HttpMethod.Delete, $"/notes/{Uri.EscapeDataString(id)}", null, ct, notFoundIsNull: true) is not null;

    public async Task<NoteAsset?> AssetAsync(string name, CancellationToken ct = default)
    {
        if (!NoteIds.ValidAssetName(name)) return null;
        using var r = await _http.SendAsync(Request(HttpMethod.Get, $"/assets/{name}"), ct);
        if (r.StatusCode == HttpStatusCode.NotFound) return null;
        if (!r.IsSuccessStatusCode) throw await Fail(r, ct);
        var type = r.Content.Headers.ContentType?.ToString() ?? (name.EndsWith(".svg", StringComparison.Ordinal) ? "image/svg+xml" : "image/png");
        return new NoteAsset(type, await r.Content.ReadAsByteArrayAsync(ct));
    }
}
