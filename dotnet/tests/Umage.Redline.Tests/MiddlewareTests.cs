using System.Net;
using System.Text.Json.Nodes;

namespace Umage.Redline.Tests;

public class MiddlewareTests
{
    const string Script = "<script type=\"module\" src=\"/__redline/client.js\" data-redline-client></script>";

    static async Task<JsonObject> JsonOf(HttpResponseMessage r) => (JsonObject)JsonNode.Parse(await r.Content.ReadAsStringAsync())!;

    [Fact]
    public async Task Injects_the_client_before_head_end_in_development()
    {
        await using var t = await TestApp.StartAsync();
        var html = await (await t.Client.SendAsync(t.Get("/"))).Content.ReadAsStringAsync();
        Assert.Equal(TestApp.Page.Replace("</head>", Script + "</head>"), html);
        var js = await t.Client.GetAsync("/__redline/client.js");
        Assert.Equal("text/javascript; charset=utf-8", js.Content.Headers.ContentType!.ToString());
        Assert.True((await js.Content.ReadAsByteArrayAsync()).Length > 1000);
    }

    [Fact]
    public async Task Streams_split_chunks_and_pages_without_head()
    {
        await using var t = await TestApp.StartAsync();
        var html = await (await t.Client.SendAsync(t.Get("/stream"))).Content.ReadAsStringAsync();
        Assert.Equal("<html><head><title>S</title>" + Script + "</head><body><p>first</p><p>second</p></body></html>", html);
        var frag = await (await t.Client.SendAsync(t.Get("/fragment"))).Content.ReadAsStringAsync();
        Assert.Equal("<p>no head or body</p>" + Script, frag);
        var json = await t.Client.GetStringAsync("/json");
        Assert.DoesNotContain("script", json);
    }

    [Fact]
    public async Task Off_outside_development()
    {
        await using var t = await TestApp.StartAsync(environment: "Production");
        var html = await (await t.Client.SendAsync(t.Get("/"))).Content.ReadAsStringAsync();
        Assert.Equal(TestApp.Page, html);
        Assert.Equal(HttpStatusCode.NotFound, (await t.Client.GetAsync("/__redline/config")).StatusCode);
    }

    [Fact]
    public async Task Notes_api_round_trip_through_markdown()
    {
        await using var t = await TestApp.StartAsync();
        var config = await JsonOf(await t.Client.GetAsync("/__redline/config"));
        Assert.Equal(".redline", config["dir"]!.GetValue<string>());
        Assert.False(config["directEdit"]!.GetValue<bool>());

        var forbidden = await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/notes", "{}", header: false));
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);

        const string png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
        var created = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/notes",
            $$$$"""{"note":{"type":"comment","page":"/","url":"http://localhost/","body":"Make it blue","author":"spoofed","target":{"tag":"h1","text":"Hello","source":{"file":"Pages/Index.cshtml","line":3,"col":1}}},"screenshot":"{{{{png}}}}"}""")));
        var id = created["id"]!.GetValue<string>();
        Assert.Null(created["author"]);
        Assert.Equal(".redline/pages/index.md", created["file"]!.GetValue<string>());
        var md = await File.ReadAllTextAsync(Path.Combine(t.Root, ".redline", "pages", "index.md"));
        Assert.Contains("### [ ] Comment · `h1` “Hello” · Pages/Index.cshtml:3", md);
        Assert.Contains($"![screenshot](../assets/{id}.png)", md);
        Assert.True(File.Exists(Path.Combine(t.Root, ".redline", "INDEX.md")));

        var list = await t.Client.GetAsync("/__redline/notes");
        var etag = list.Headers.ETag!.Tag;
        var again = new HttpRequestMessage(HttpMethod.Get, "/__redline/notes");
        again.Headers.TryAddWithoutValidation("If-None-Match", etag);
        Assert.Equal(HttpStatusCode.NotModified, (await t.Client.SendAsync(again)).StatusCode);

        // an agent ticks the note by hand; the overlay's next write keeps it
        await File.WriteAllTextAsync(Path.Combine(t.Root, ".redline", "pages", "index.md"), md.Replace("### [ ]", "### [x]").Replace("Make it blue\n", "Make it blue\n\n> Done.\n"));
        var patched = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Patch, $"/__redline/notes/{id}", """{"body":"Make it dark blue"}""")));
        Assert.True(patched["done"]!.GetValue<bool>());
        Assert.Equal("Done.", patched["reply"]!.GetValue<string>());
        Assert.Equal("image/png", (await t.Client.GetAsync($"/__redline/assets/{id}.png")).Content.Headers.ContentType!.MediaType);

        Assert.Equal(HttpStatusCode.OK, (await t.Client.SendAsync(TestApp.Json(HttpMethod.Delete, $"/__redline/notes/{id}", ""))).StatusCode);
        Assert.False(File.Exists(Path.Combine(t.Root, ".redline", "pages", "index.md")));
        Assert.False(File.Exists(Path.Combine(t.Root, ".redline", "assets", $"{id}.png")));
    }

    [Fact]
    public async Task Direct_edit_writes_static_razor_text()
    {
        await using var t = await TestApp.StartAsync(o => o.DirectEdit = true);
        Directory.CreateDirectory(Path.Combine(t.Root, "Pages"));
        var file = Path.Combine(t.Root, "Pages", "Index.cshtml");
        await File.WriteAllTextAsync(file, "@page\n<h1>Hello</h1>\n<p>Hi @Model.Name</p>\n");
        var dry = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/edit?dry=1", """{"from":"Hello","to":"Hello there","tag":"h1","url":"http://localhost/","source":{"file":"Pages/Index.cshtml","line":2,"col":1}}""")));
        Assert.True(dry["ok"]!.GetValue<bool>(), dry.ToJsonString());
        var refused = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/edit", """{"from":"Hi Ann","to":"Hello Ann","tag":"p","url":"http://localhost/","source":{"file":"Pages/Index.cshtml","line":3,"col":1}}""")));
        Assert.False(refused["ok"]!.GetValue<bool>());
        var done = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/edit", """{"from":"Hello","to":"Hello there","tag":"h1","url":"http://localhost/","source":{"file":"Pages/Index.cshtml","line":2,"col":1}}""")));
        Assert.True(done["ok"]!.GetValue<bool>());
        Assert.Equal("Pages/Index.cshtml", done["file"]!.GetValue<string>());
        Assert.Equal("@page\n<h1>Hello there</h1>\n<p>Hi @Model.Name</p>\n", await File.ReadAllTextAsync(file));
    }

    [Fact]
    public async Task Registers_in_servers_json_for_redline_mcp()
    {
        await using var t = await TestApp.StartAsync();
        await t.Client.GetAsync("/__redline/config");
        var path = Path.Combine(t.Root, ".redline", "servers.json");
        for (var i = 0; i < 50 && !File.Exists(path); i++) await Task.Delay(20);
        var list = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsArray();
        Assert.Contains(list, s => s!["url"]!.GetValue<string>() == "http://localhost" && s["pid"]!.GetValue<int>() == Environment.ProcessId);
    }
}
