// The shared golden fixtures (test/golden, also run by test/unit/golden.test.ts): the .NET
// format must produce the same bytes as src/server/format.ts.

using System.Text.Json.Nodes;
using Umage.Redline.Notes;

namespace Umage.Redline.Tests;

public class GoldenTests
{
    public static string Repo
    {
        get
        {
            var dir = AppContext.BaseDirectory;
            while (dir is not null && !Directory.Exists(Path.Combine(dir, "test", "golden"))) dir = Path.GetDirectoryName(dir);
            return dir ?? throw new DirectoryNotFoundException("test/golden not found above " + AppContext.BaseDirectory);
        }
    }

    static string Golden(string rel) => Path.Combine(Repo, "test", "golden", rel);
    static string Read(string rel) => File.ReadAllText(Golden(rel));

    public static IEnumerable<object[]> Files(string sub, string ext) =>
        Directory.GetFiles(Golden(sub), "*" + ext).Where(f => !f.EndsWith(".out.md")).OrderBy(f => f, StringComparer.Ordinal).Select(f => new object[] { Path.GetFileName(f) });

    public static IEnumerable<object[]> PageFixtures => Files("pages", ".json");
    public static IEnumerable<object[]> EditedFixtures => Files("edited", ".md");
    public static IEnumerable<object[]> IndexFixtures => Files("index", ".json");

    static Note FromFixture(JsonObject o) => Note.FromJson(o);

    /// <summary>Deep equality as node:assert's deepStrictEqual sees it (key order ignored, numbers by value).</summary>
    static void AssertSame(JsonNode? expected, JsonNode? actual, string path = "$")
    {
        switch (expected)
        {
            case null: Assert.True(actual is null, $"{path}: expected null, got {actual?.ToJsonString()}"); return;
            case JsonObject eo:
                var ao = Assert.IsType<JsonObject>(actual);
                Assert.Equal(eo.Select(k => k.Key).OrderBy(k => k, StringComparer.Ordinal), ao.Select(k => k.Key).OrderBy(k => k, StringComparer.Ordinal));
                foreach (var kv in eo) AssertSame(kv.Value, ao[kv.Key], $"{path}.{kv.Key}");
                return;
            case JsonArray ea:
                var aa = Assert.IsType<JsonArray>(actual);
                Assert.Equal(ea.Count, aa.Count);
                for (var i = 0; i < ea.Count; i++) AssertSame(ea[i], aa[i], $"{path}[{i}]");
                return;
            case JsonValue ev:
                var av = Assert.IsAssignableFrom<JsonValue>(actual);
                Assert.Equal(ev.GetValueKind(), av.GetValueKind());
                if (ev.GetValueKind() == System.Text.Json.JsonValueKind.Number) Assert.Equal(Js.ToDouble(ev), Js.ToDouble(av));
                else Assert.Equal(ev.ToJsonString(), av.ToJsonString());
                return;
        }
    }

    [Theory, MemberData(nameof(PageFixtures))]
    public void Page_serializes_byte_for_byte_and_round_trips(string file)
    {
        var fx = (JsonObject)NoteFormat.ParseJson(Read($"pages/{file}"))!;
        var notes = fx["notes"]!.AsArray().Select(n => FromFixture((JsonObject)n!)).ToList();
        var md = NoteFormat.SerializePage(fx["page"]!.GetValue<string>(), fx["url"]?.GetValue<string>(), notes);
        Assert.Equal(Read($"pages/{Path.ChangeExtension(file, ".md")}"), md);
        var back = NoteFormat.ParsePage(md);
        AssertSame(new JsonArray(notes.Select(n => (JsonNode)n.ToJson()).ToArray()), new JsonArray(back.Select(n => (JsonNode)n.ToJson()).ToArray()));
        Assert.Equal(md, NoteFormat.SerializePage(fx["page"]!.GetValue<string>(), fx["url"]?.GetValue<string>(), back));
    }

    [Theory, MemberData(nameof(EditedFixtures))]
    public void Hand_edited_page_parses_like_node(string file)
    {
        var md = Read($"edited/{file}");
        var notes = NoteFormat.ParsePage(md);
        var expected = NoteFormat.ParseJson(Read($"edited/{Path.ChangeExtension(file, ".json")}"));
        AssertSame(expected, new JsonArray(notes.Select(n => (JsonNode)n.ToJson()).ToArray()));
        AssertSame(expected, new JsonArray(NoteFormat.ParsePage(md.Replace("\n", "\r\n")).Select(n => (JsonNode)n.ToJson()).ToArray()));
        Assert.Equal(Read($"edited/{Path.GetFileNameWithoutExtension(file)}.out.md"), NoteFormat.SerializePage(notes[0].Page!, notes[0].Url, notes));
    }

    [Theory, MemberData(nameof(IndexFixtures))]
    public void Index_matches(string file)
    {
        var rows = NoteFormat.ParseJson(Read($"index/{file}"))!.AsArray().Select(r => new NoteFormat.IndexRow(
            r!["page"]!.GetValue<string>(), r["app"]?.GetValue<string>(), r["file"]!.GetValue<string>(), (int)r["open"]!.GetValue<double>(), (int)r["done"]!.GetValue<double>())).ToList();
        Assert.Equal(Read($"index/{Path.ChangeExtension(file, ".md")}"), NoteFormat.SerializeIndex(rows));
    }

    [Fact]
    public void Slugs_match()
    {
        foreach (var c in NoteFormat.ParseJson(Read("slugs.json"))!.AsArray())
        {
            var page = c![0]!.GetValue<string>();
            var app = c[1]?.GetValue<string>();
            Assert.Equal(c[2]!.GetValue<string>() + ".md", NoteFormat.PageFile(page, app));
        }
    }
}
