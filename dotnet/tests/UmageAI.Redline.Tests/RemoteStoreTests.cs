using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using UmageAI.Redline.Notes;

namespace UmageAI.Redline.Tests;

/// <summary>
/// RemoteNoteStore (D40) against a protocol server held in memory: the calls it makes, the bearer
/// header, what it reads back, and refusals in the store's own words. And the middleware's part:
/// a page can never set the fields only a store sets, and the build is recorded.
/// </summary>
public class RemoteStoreTests
{
    /// <summary>docs/PROTOCOL.md over a dictionary, answering as alice for her token.</summary>
    sealed class FakeProtocol : HttpMessageHandler
    {
        public readonly List<JsonObject> Notes = new();
        public readonly List<string> Calls = new();
        public string? Refuse;
        int _version;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            var path = req.RequestUri!.AbsolutePath;
            Calls.Add($"{req.Method} {path}");
            if (req.Headers.Authorization?.ToString() != "Bearer tok-alice") return Json(401, new JsonObject { ["error"] = "a valid bearer token is required" });
            if (!path.StartsWith("/redline/", StringComparison.Ordinal)) return Json(404, new JsonObject { ["error"] = "unknown endpoint" });
            var p = path["/redline".Length..];
            var body = req.Content is null ? null : JsonNode.Parse(await req.Content.ReadAsStringAsync(ct)) as JsonObject;

            if (req.Method == HttpMethod.Get && p == "/version") return Json(200, new JsonObject { ["version"] = _version.ToString() });
            if (req.Method == HttpMethod.Get && p == "/notes") return Json(200, new JsonObject { ["version"] = _version.ToString(), ["notes"] = new JsonArray(Notes.Select(n => (JsonNode)n.DeepClone()).ToArray()) });
            if (req.Method == HttpMethod.Post && p == "/notes")
            {
                if (Refuse is not null) return Json(403, new JsonObject { ["error"] = Refuse });
                var n = (JsonObject)body!["note"]!.DeepClone();
                n["id"] = "n" + (Notes.Count + 1).ToString("D4");
                n["author"] = "alice@example.com";
                n["mine"] = true;
                n["reply"] = ""; n["done"] = false;
                if (body["screenshot"] is not null) n["screenshot"] = $"{n["id"]}.png";
                Notes.Add(n); _version++;
                return Json(200, n);
            }
            var id = p.StartsWith("/notes/", StringComparison.Ordinal) ? p["/notes/".Length..] : null;
            var hit = Notes.FirstOrDefault(n => n["id"]!.GetValue<string>() == id);
            if (req.Method == HttpMethod.Patch && id is not null)
            {
                if (hit is null) return Json(404, new JsonObject { ["error"] = "not found" });
                foreach (var kv in body!) hit[kv.Key] = kv.Value?.DeepClone();
                _version++;
                return Json(200, hit);
            }
            if (req.Method == HttpMethod.Delete && id is not null)
            {
                if (hit is null) return Json(404, new JsonObject { ["error"] = "not found" });
                Notes.Remove(hit); _version++;
                return Json(200, new JsonObject { ["ok"] = true });
            }
            if (req.Method == HttpMethod.Get && p == "/assets/n0001.png")
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes("fake-png")) { Headers = { ContentType = new("image/png") } } };
            return Json(404, new JsonObject { ["error"] = "not found" });
        }

        static HttpResponseMessage Json(int status, JsonNode body) =>
            new((HttpStatusCode)status) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };
    }

    static NewNoteRequest Req(string body) =>
        new((JsonObject)JsonNode.Parse($$"""{"type":"comment","page":"/","url":"http://x/","body":"{{body}}"}""")!, "data:image/png;base64,AA==");

    [Fact]
    public async Task Round_trip_over_the_protocol_with_a_bearer_token()
    {
        var server = new FakeProtocol();
        var store = new RemoteNoteStore("https://notes.example/redline/", "tok-alice", new HttpClient(server));
        Assert.Equal("notes.example", store.Dir);

        var v0 = await store.VersionAsync();
        var n = await store.CreateAsync(Req("Too tight"));
        Assert.Equal("alice@example.com", n.Author);
        Assert.Equal("Too tight", n.Body);
        Assert.NotEqual(v0, await store.VersionAsync());

        var listed = Assert.Single(await store.ListAsync());
        Assert.True(listed.Data["mine"]!.GetValue<bool>());

        var done = await store.UpdateAsync(n.Id!, new NotePatch { Done = true, Seen = true });
        Assert.True(done!.Done);
        Assert.True(server.Notes[0]["seen"]!.GetValue<bool>());
        Assert.Null(await store.UpdateAsync("nosuch", new NotePatch { Done = true }));

        var shot = await store.AssetAsync("n0001.png");
        Assert.Equal("image/png", shot!.ContentType);
        Assert.Null(await store.AssetAsync("../secret.png"));

        Assert.True(await store.RemoveAsync(n.Id!));
        Assert.False(await store.RemoveAsync(n.Id!));
        Assert.Contains("PATCH /redline/notes/n0001", server.Calls);
    }

    [Fact]
    public async Task Refusals_come_back_in_the_stores_own_words()
    {
        var server = new FakeProtocol { Refuse = "Review notes are switched off for this project" };
        var wrong = new RemoteNoteStore("https://notes.example/redline", "nope", new HttpClient(server));
        Assert.Equal("a valid bearer token is required", (await Assert.ThrowsAsync<InvalidOperationException>(() => wrong.ListAsync())).Message);
        var alice = new RemoteNoteStore("https://notes.example/redline", "tok-alice", new HttpClient(server));
        Assert.Equal("Review notes are switched off for this project", (await Assert.ThrowsAsync<InvalidOperationException>(() => alice.CreateAsync(Req("x")))).Message);
        Assert.Throws<ArgumentException>(() => new RemoteNoteStore("file:///etc"));
    }

    [Fact]
    public async Task A_page_cannot_set_store_fields_and_the_build_is_recorded()
    {
        await using var t = await TestApp.StartAsync(o => o.Build = "abc1234");
        var created = (JsonObject)JsonNode.Parse(await (await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/notes",
            """{"note":{"type":"comment","page":"/","url":"http://localhost/","body":"Hi","author":"mallory","mine":true,"seen":true,"resolvedAt":"x","href":"https://evil.example/","build":"forged"}}"""))).Content.ReadAsStringAsync())!;
        Assert.Equal("abc1234", created["build"]!.GetValue<string>());
        foreach (var k in new[] { "author", "mine", "seen", "resolvedAt", "href" }) Assert.Null(created[k]);
    }

    [Fact]
    public void Markdown_never_holds_what_a_remote_store_reports()
    {
        var note = Note.FromJson((JsonObject)JsonNode.Parse("""{"id":"abcd1234","type":"comment","page":"/","url":"http://x/","at":"2026-10-16 10:00","body":"x","reply":"","done":true,"author":"alice@example.com","build":"abc1234","resolvedAt":"2026-10-16T10:00:00Z","mine":true,"seen":true,"href":"https://store/n/1"}""")!);
        var md = NoteFormat.SerializePage("/", "http://x/", new[] { note });
        foreach (var k in new[] { "resolvedAt", "mine", "seen", "href" }) Assert.DoesNotContain($"\"{k}\"", md);
        Assert.Contains("\"author\":\"alice@example.com\"", md);
        Assert.Contains("\"build\":\"abc1234\"", md);
    }
}
