using System.Data.Common;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Umage.Redline.Notes;

namespace Umage.Redline.Tests;

public class StoreTests
{
    const string Png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    static NewNoteRequest Req(string body, string page = "/") => new(
        (JsonObject)JsonNode.Parse($$$"""{"type":"comment","page":"{{{page}}}","url":"http://x{{{page}}}","body":"{{{body}}}","target":{"tag":"p","text":"T","fx":0.25}}""")!, Png, "<svg/>");

    static async Task RoundTrip(INoteStore store)
    {
        var v0 = await store.VersionAsync();
        var a = await store.CreateAsync(Req("One"));
        var b = await store.CreateAsync(Req("Two", "/about"));
        Assert.NotEqual(v0, await store.VersionAsync());
        Assert.True(NoteIds.Valid(a.Id));
        var all = await store.ListAsync();
        Assert.Equal(new[] { "One", "Two" }, all.OrderBy(n => n.Body).Select(n => n.Body));
        var stored = all.Single(n => n.Id == a.Id);
        Assert.Equal(0.25, stored.Target!["fx"]!.GetValue<double>());
        Assert.Equal($"../assets/{a.Id}.png", stored.Screenshot);
        Assert.Equal("image/png", (await store.AssetAsync($"{a.Id}.png"))!.ContentType);
        Assert.Equal("image/svg+xml", (await store.AssetAsync($"{a.Id}.svg"))!.ContentType);
        Assert.Null(await store.AssetAsync("../secret.png"));

        var v1 = await store.VersionAsync();
        var u = await store.UpdateAsync(a.Id!, new NotePatch { Done = true, Reply = "Fixed", To = "ignored on comments" });
        Assert.True(u!.Done);
        Assert.Null(u.To);
        Assert.NotEqual(v1, await store.VersionAsync());
        Assert.Equal("Fixed", (await store.ListAsync()).Single(n => n.Id == a.Id).Reply);
        Assert.Null(await store.UpdateAsync("nope0", new NotePatch { Done = true }));

        Assert.True(await store.RemoveAsync(a.Id!));
        Assert.False(await store.RemoveAsync(a.Id!));
        Assert.Null(await store.AssetAsync($"{a.Id}.png"));
        Assert.Single(await store.ListAsync());
        Assert.Equal(b.Id, (await store.ListAsync())[0].Id);
    }

    [Fact]
    public async Task Markdown_store_round_trip()
    {
        var root = Path.Combine(Path.GetTempPath(), "redline-md-" + Guid.NewGuid().ToString("n"));
        try { await RoundTrip(new MarkdownNoteStore(root)); }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task Sqlite_store_round_trip()
    {
        var db = Path.Combine(Path.GetTempPath(), $"redline-{Guid.NewGuid():n}.db");
        await RoundTrip(new SqlNoteStore(() => new SqliteConnection($"Data Source={db};Pooling=False"), SqlDialect.Sqlite));
    }

    /// <summary>Runs against SQL Server when REDLINE_TEST_SQLSERVER holds a connection string (e.g. LocalDB).</summary>
    [Fact]
    public async Task SqlServer_store_round_trip()
    {
        var cs = Environment.GetEnvironmentVariable("REDLINE_TEST_SQLSERVER");
        if (string.IsNullOrEmpty(cs)) return;
        var prefix = "RlTest" + Guid.NewGuid().ToString("n").Substring(0, 8);
        Func<DbConnection> connect = () => new Microsoft.Data.SqlClient.SqlConnection(cs);
        try { await RoundTrip(new SqlNoteStore(connect, SqlDialect.SqlServer, prefix)); }
        finally
        {
            await using var c = connect();
            await c.OpenAsync();
            foreach (var t in new[] { "Notes", "Assets", "Tokens", "State" })
            {
                await using var cmd = c.CreateCommand();
                cmd.CommandText = $"DROP TABLE IF EXISTS {prefix}{t}";
                await cmd.ExecuteNonQueryAsync();
            }
        }
    }
}
