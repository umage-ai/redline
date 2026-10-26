using System.Net;
using System.Text.Json.Nodes;
using UmageAI.Redline.Notes;

namespace UmageAI.Redline.Tests;

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
    public async Task Streams_split_chunks_identity_encoding_and_pages_without_head()
    {
        await using var t = await TestApp.StartAsync();
        var html = await (await t.Client.SendAsync(t.Get("/stream"))).Content.ReadAsStringAsync();
        Assert.Equal("<html><head><title>S</title>" + Script + "</head><body><p>first</p><p>second</p></body></html>", html);
        var frag = await (await t.Client.SendAsync(t.Get("/fragment"))).Content.ReadAsStringAsync();
        Assert.Equal("<p>no head or body</p>" + Script, frag);
        var gz = await (await t.Client.SendAsync(t.Get("/gzip"))).Content.ReadAsByteArrayAsync();
        Assert.Equal(new byte[] { 31, 139, 8, 0 }, gz);   // compressed bodies pass through untouched
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
    public async Task Static_html_edit_picks_the_nth_same_text_element_and_keeps_entity_spelling()
    {
        await using var t = await TestApp.StartAsync(o => o.DirectEdit = true);
        var file = Path.Combine(t.Root, "wwwroot", "deck.html");
        await File.WriteAllTextAsync(file, "<ul>\n<li><span>Yes</span></li>\n<li><span>Yes</span></li>\n</ul>\n<p>Slides &mdash; part one</p>\n");
        const string Req = """{"from":"Yes","to":"No","tag":"span","url":"http://localhost/deck.html"%NTH%}""";
        var ambiguous = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/edit?dry=1", Req.Replace("%NTH%", ""))));
        Assert.False(ambiguous["ok"]!.GetValue<bool>());
        var wrongCount = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/edit?dry=1", Req.Replace("%NTH%", ""","nth":{"index":1,"count":3}"""))));
        Assert.Contains("the page shows 3", wrongCount["reason"]!.GetValue<string>());
        var done = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/edit", Req.Replace("%NTH%", ""","nth":{"index":1,"count":2}"""))));
        Assert.True(done["ok"]!.GetValue<bool>(), done.ToJsonString());
        Assert.Equal("wwwroot/deck.html", done["file"]!.GetValue<string>());
        Assert.Equal(3, done["line"]!.GetValue<int>());

        var inspect = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/edit?inspect=1", """{"from":"Slides — part one","tag":"p","url":"http://localhost/deck.html"}""")));
        Assert.Equal("&mdash;", inspect["inspect"]!["spell"]!["—"]!.GetValue<string>());
        var plain = await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/edit", """{"from":"Slides — part one","to":"Deck — part two","tag":"p","url":"http://localhost/deck.html"}""")));
        Assert.True(plain["ok"]!.GetValue<bool>(), plain.ToJsonString());
        Assert.Equal("<ul>\n<li><span>Yes</span></li>\n<li><span>No</span></li>\n</ul>\n<p>Deck &mdash; part two</p>\n", await File.ReadAllTextAsync(file));
    }

    [Fact]
    public async Task Labels_are_in_the_config_and_a_notes_label_is_cleaned_into_its_heading()
    {
        await using (var t = await TestApp.StartAsync())
        {
            var labels = (await JsonOf(await t.Client.GetAsync("/__redline/config")))["labels"]!.AsArray();
            Assert.Equal(new[] { "Bug", "UX", "Idea", "Copy" }, labels.Select(l => l!["name"]!.GetValue<string>()));
            Assert.Equal("#ff5c5c", labels[0]!["color"]!.GetValue<string>());

            async Task<JsonNode> Post(string label) => await JsonOf(await t.Client.SendAsync(TestApp.Json(HttpMethod.Post, "/__redline/notes",
                """{"note":{"type":"comment","page":"/","url":"http://localhost/","body":"Hi","label":""" + label + "}}")));
            Assert.Equal("Bug", (await Post("\"  Bug \\n\""))["label"]!.GetValue<string>());
            Assert.Null((await Post("42"))["label"]);
            Assert.Null((await Post("\"   \""))["label"]);
            var md = await File.ReadAllTextAsync(Path.Combine(t.Root, ".redline", "pages", "index.md"));
            Assert.Contains("### [ ] Bug · Comment · whole page\n", md);
        }
        await using (var t = await TestApp.StartAsync(o => { o.Labels.Clear(); }))
            Assert.Empty((await JsonOf(await t.Client.GetAsync("/__redline/config")))["labels"]!.AsArray());
        await using (var t = await TestApp.StartAsync(o => o.Labels = new() { new(" Bug "), new("Perf", "teal"), new("bug"), new("") }))
            Assert.Equal("""[{"name":"Bug"},{"name":"Perf","color":"teal"}]""", (await JsonOf(await t.Client.GetAsync("/__redline/config")))["labels"]!.ToJsonString());
    }

    [Fact]
    public async Task Labels_can_come_from_a_function_per_request_and_a_failure_shows_none()
    {
        await using (var t = await TestApp.StartAsync(o => o.LabelsFrom = async http =>
        {
            await Task.Yield();
            return http.Request.Headers["x-team"] == "cms" ? new[] { new RedlineLabel("Content"), new RedlineLabel("Layout", "#f80") } : new[] { new RedlineLabel("Bug") };
        }))
        {
            Assert.Equal("""[{"name":"Bug"}]""", (await JsonOf(await t.Client.GetAsync("/__redline/config")))["labels"]!.ToJsonString());
            var req = new HttpRequestMessage(HttpMethod.Get, "/__redline/config");
            req.Headers.Add("x-team", "cms");
            Assert.Equal("""[{"name":"Content"},{"name":"Layout","color":"#f80"}]""", (await JsonOf(await t.Client.SendAsync(req)))["labels"]!.ToJsonString());
        }
        await using (var t = await TestApp.StartAsync(o => o.LabelsFrom = _ => throw new InvalidOperationException("backend down")))
            Assert.Empty((await JsonOf(await t.Client.GetAsync("/__redline/config")))["labels"]!.AsArray());
    }

    [Fact]
    public async Task Copy_prompt_shows_for_the_markdown_store_and_is_hidden_or_replaced_otherwise()
    {
        async Task<JsonNode?> Prompt(Action<RedlineOptions> configure)
        {
            await using var t = await TestApp.StartAsync(configure);
            return (await JsonOf(await t.Client.GetAsync("/__redline/config")))["prompt"];
        }
        Assert.Null(await Prompt(_ => { }));
        Assert.Equal("Use the MCP tools ({open} open).", (await Prompt(o => o.Prompt = "Use the MCP tools ({open} open)."))!.GetValue<string>());
        Assert.False((await Prompt(o => o.Prompt = ""))!.GetValue<bool>());
        var remote = new RemoteNoteStore("https://notes.example/redline/", null, new HttpClient());
        Assert.False((await Prompt(o => o.Store = (_, _) => remote))!.GetValue<bool>());
        Assert.Equal("Ask the team.", (await Prompt(o => { o.Store = (_, _) => remote; o.Prompt = "Ask the team."; }))!.GetValue<string>());
    }

    [Fact]
    public async Task Config_carries_the_page_key_option()
    {
        await using (var t = await TestApp.StartAsync())
            Assert.Equal("route", (await JsonOf(await t.Client.GetAsync("/__redline/config")))["pageKey"]!.GetValue<string>());
        await using (var t = await TestApp.StartAsync(o => o.PageKey = RedlinePageKey.Path))
            Assert.Equal("path", (await JsonOf(await t.Client.GetAsync("/__redline/config")))["pageKey"]!.GetValue<string>());
    }

    [Fact]
    public async Task Head_answers_like_get_without_a_body()
    {
        await using var t = await TestApp.StartAsync();
        foreach (var path in new[] { "/__redline/config", "/__redline/client.js", "/__redline/notes" })
        {
            var get = await t.Client.GetAsync(path);
            var head = await t.Client.SendAsync(new HttpRequestMessage(HttpMethod.Head, path));
            Assert.Equal(HttpStatusCode.OK, head.StatusCode);
            Assert.Equal(get.Content.Headers.ContentType, head.Content.Headers.ContentType);
            Assert.Equal(get.Content.Headers.ContentLength, head.Content.Headers.ContentLength);
            Assert.Empty(await head.Content.ReadAsByteArrayAsync());
        }
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Client.SendAsync(new HttpRequestMessage(HttpMethod.Head, "/__redline/notes/abc"))).StatusCode);
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
        // ISO 8601 whatever the machine's culture (a Danish time separator once wrote "22.58.31").
        Assert.All(list, s => Assert.Matches(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", s!["at"]!.GetValue<string>()));
    }
}
