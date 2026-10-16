// Online mode (D34) and the remote MCP endpoint (D35): only authorized reviewers see the
// overlay and the API; agents need a bearer token.

using System.Net;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Umage.Redline.Notes;
using Umage.Redline.Security;

namespace Umage.Redline.Tests;

public class OnlineTests
{
    const string Script = "data-redline-client";

    static (string Token, string Hash) SiteToken = RedlineTokens.Create();

    static Task<TestApp> Online(Action<RedlineOptions>? more = null)
    {
        var db = Path.Combine(Path.GetTempPath(), $"redline-{Guid.NewGuid():n}.db");
        return TestApp.StartAsync(o =>
        {
            o.Online = true;
            o.Policy = "Reviewers";
            o.UseSqlStore(() => new SqliteConnection($"Data Source={db};Pooling=False"), SqlDialect.Sqlite);
            o.Mcp.TokenHashes.Add(SiteToken.Hash);
            more?.Invoke(o);
        }, environment: "Production");
    }

    static async Task<JsonObject> JsonOf(HttpResponseMessage r) => (JsonObject)JsonNode.Parse(await r.Content.ReadAsStringAsync())!;

    [Fact]
    public async Task Anonymous_visitors_get_no_overlay_and_no_api()
    {
        await using var t = await Online();
        var page = await t.Client.SendAsync(t.Get("/"));
        Assert.DoesNotContain(Script, await page.Content.ReadAsStringAsync());
        foreach (var url in new[] { "/__redline/client.js", "/__redline/config", "/__redline/notes", "/__redline/assets/abcd.png" })
            Assert.Equal(HttpStatusCode.NotFound, (await t.Client.GetAsync(url)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/notes", """{"note":{"type":"comment","page":"/"}}"""))).StatusCode);
    }

    [Fact]
    public async Task Signed_in_users_without_the_role_get_nothing()
    {
        await using var t = await Online();
        var page = await t.Client.SendAsync(t.Get("/", "eve", "Editors"));
        Assert.DoesNotContain(Script, await page.Content.ReadAsStringAsync());
        var cfg = new HttpRequestMessage(HttpMethod.Get, "/__redline/config");
        cfg.Headers.Add("X-Test-User", "eve");
        Assert.Equal(HttpStatusCode.NotFound, (await t.Client.SendAsync(cfg)).StatusCode);
    }

    [Fact]
    public async Task Reviewers_get_the_overlay_and_notes_record_the_author()
    {
        await using var t = await Online(o => o.DirectEdit = true);
        var page = await t.Client.SendAsync(t.Get("/", "anna", "Reviewers"));
        Assert.Contains(Script, await page.Content.ReadAsStringAsync());
        Assert.Contains("no-store", page.Headers.CacheControl!.ToString());

        var cfgReq = new HttpRequestMessage(HttpMethod.Get, "/__redline/config");
        cfgReq.Headers.Add("X-Test-User", "anna"); cfgReq.Headers.Add("X-Test-Roles", "Reviewers");
        var cfg = await JsonOf(await t.Client.SendAsync(cfgReq));
        Assert.Equal("database", cfg["dir"]!.GetValue<string>());
        Assert.False(cfg["directEdit"]!.GetValue<bool>());   // file writers are off online
        Assert.Contains(cfg["extensions"]!.AsArray(), e => e!.GetValue<string>() == "/__redline/ext/tokens.js");

        var note = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/notes",
            """{"note":{"type":"comment","page":"/","url":"http://localhost/","body":"Typo","author":"mallory"}}""", "anna", "Reviewers")));
        Assert.Equal("anna", note["author"]!.GetValue<string>());

        var cross = TestApp.Json(HttpMethod.Post, "/__redline/notes", """{"note":{"type":"comment","page":"/"}}""", "anna", "Reviewers");
        cross.Headers.Add("Origin", "https://evil.example");
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Client.SendAsync(cross)).StatusCode);
    }

    static HttpRequestMessage Rpc(string method, object? @params = null, string? token = null, int id = 1)
    {
        var body = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method };
        if (@params is not null) body["params"] = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(@params));
        var req = new HttpRequestMessage(HttpMethod.Post, "/__redline/mcp") { Content = new StringContent(body.ToJsonString(), System.Text.Encoding.UTF8, "application/json") };
        req.Headers.Accept.ParseAdd("application/json");
        req.Headers.Accept.ParseAdd("text/event-stream");
        if (token is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return req;
    }

    [Fact]
    public async Task Mcp_needs_a_token()
    {
        await using var t = await Online();
        var none = await t.Client.SendAsync(Rpc("tools/list"));
        Assert.Equal(HttpStatusCode.Unauthorized, none.StatusCode);
        Assert.Equal("Bearer", none.Headers.WwwAuthenticate.First().Scheme);
        Assert.Equal(HttpStatusCode.Unauthorized, (await t.Client.SendAsync(Rpc("tools/list", token: "rl_wrong"))).StatusCode);
        // a reviewer's cookie is not enough for MCP
        var cookie = Rpc("tools/list");
        cookie.Headers.Add("X-Test-User", "anna"); cookie.Headers.Add("X-Test-Roles", "Reviewers");
        Assert.Equal(HttpStatusCode.Unauthorized, (await t.Client.SendAsync(cookie)).StatusCode);
    }

    [Fact]
    public async Task Mcp_tools_over_http_with_site_and_personal_tokens()
    {
        await using var t = await Online();
        await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/notes",
            """{"note":{"type":"text","page":"/about","url":"http://localhost/about","from":"Teh","to":"The","target":{"tag":"h1","text":"Teh"}}}""", "anna", "Reviewers"));

        var init = await JsonOf(await t.Client.SendAsync(Rpc("initialize", new { protocolVersion = "2025-06-18", capabilities = new { }, clientInfo = new { name = "test", version = "1" } }, SiteToken.Token)));
        Assert.Equal("2025-06-18", init["result"]!["protocolVersion"]!.GetValue<string>());
        var notified = await t.Client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/__redline/mcp")
        {
            Content = new StringContent("""{"jsonrpc":"2.0","method":"notifications/initialized"}""", System.Text.Encoding.UTF8, "application/json"),
            Headers = { Authorization = new AuthenticationHeaderValue("Bearer", SiteToken.Token) },
        });
        Assert.Equal(HttpStatusCode.Accepted, notified.StatusCode);

        var tools = await JsonOf(await t.Client.SendAsync(Rpc("tools/list", token: SiteToken.Token)));
        Assert.Equal(new[] { "list_notes", "get_note", "update_note" }, tools["result"]!["tools"]!.AsArray().Select(x => x!["name"]!.GetValue<string>()));

        var list = await JsonOf(await t.Client.SendAsync(Rpc("tools/call", new { name = "list_notes", arguments = new { } }, SiteToken.Token)));
        var text = list["result"]!["content"]![0]!["text"]!.GetValue<string>();
        Assert.Contains("1 open note", text);
        Assert.Contains("by anna", text);
        var id = System.Text.RegularExpressions.Regex.Match(text, @"- (\w+) \[open\]").Groups[1].Value;

        // a reviewer makes a personal token in the overlay, an agent uses it
        var mk = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/tokens", """{"name":"laptop"}""", "anna", "Reviewers")));
        var personal = mk["token"]!.GetValue<string>();
        Assert.StartsWith("rl_", personal);
        Assert.Equal("http://localhost/__redline/mcp", mk["url"]!.GetValue<string>());
        var upd = await JsonOf(await t.Client.SendAsync(Rpc("tools/call", new { name = "update_note", arguments = new { id, done = true, reply = "Fixed the typo." } }, personal)));
        Assert.Null(upd["result"]!["isError"]);
        var get = await JsonOf(await t.Client.SendAsync(Rpc("tools/call", new { name = "get_note", arguments = new { id } }, personal)));
        Assert.Contains("### [x] Text change", get["result"]!["content"]![0]!["text"]!.GetValue<string>());

        // revoked tokens stop working
        var tokReq = new HttpRequestMessage(HttpMethod.Get, "/__redline/tokens");
        tokReq.Headers.Add("X-Test-User", "anna"); tokReq.Headers.Add("X-Test-Roles", "Reviewers");
        var mine = await JsonOf(await t.Client.SendAsync(tokReq));
        var tokenId = mine["tokens"]![0]!["id"]!.GetValue<string>();
        Assert.Equal(HttpStatusCode.OK, (await t.Client.SendAsync(TestApp.Json(HttpMethod.Delete, $"/__redline/tokens/{tokenId}", "", "anna", "Reviewers"))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await t.Client.SendAsync(Rpc("tools/list", token: personal))).StatusCode);
    }
}
