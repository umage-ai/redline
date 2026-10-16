// The direct-edit guards shared with Node (test/golden/edit/cases.json, also run by
// test/unit/edit.test.ts): same refusals, same output bytes, same entity table (D24, D25).

using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using UmageAI.Redline.Editing;

namespace UmageAI.Redline.Tests;

public class EditGoldenTests
{
    static readonly JsonObject Cases = (JsonObject)JsonNode.Parse(File.ReadAllText(Path.Combine(GoldenTests.Repo, "test", "golden", "edit", "cases.json")))!;

    public static IEnumerable<object[]> Edits => Cases["edits"]!.AsArray().Select(c => new object[] { c!["name"]!.GetValue<string>() });

    [Theory]
    [MemberData(nameof(Edits))]
    public void Edit_case(string name)
    {
        var c = Cases["edits"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == name)!;
        var syntax = c["syntax"]!.GetValue<string>() == "braces" ? MarkupSyntax.Braces : MarkupSyntax.Html;
        var e = c["edit"]!;
        string from = e["from"]!.GetValue<string>(), to = e["to"]!.GetValue<string>();
        var html = e["html"]?.GetValue<string>();
        Planned r;
        if (c["at"] is JsonObject at)
            r = SourceEdit.EditAt(c["src"]!.GetValue<string>(), at["tag"]!.GetValue<string>(), at["line"]!.GetValue<int>(), at["col"]?.GetValue<int>(), from, to, html, syntax);
        else
        {
            var nth = c["nth"] is JsonObject n ? new Nth(n["index"]!.GetValue<int>(), n["count"]!.GetValue<int>()) : null;
            r = SourceEdit.EditUnique(c["src"]!.GetValue<string>(), c["tag"]!.GetValue<string>(), from, to, html, syntax, nth);
        }
        if (c["refuse"] is { } refuse)
        {
            Assert.False(r.Ok, "expected a refusal");
            Assert.Matches(new Regex(refuse.GetValue<string>()), r.Reason!);
        }
        else
        {
            Assert.True(r.Ok, r.Reason);
            Assert.Equal(c["content"]!.GetValue<string>(), r.Content);
            Assert.Equal(c["line"]!.GetValue<int>(), r.Line);
        }
    }

    [Fact]
    public void Decodes_entities_like_the_browser()
    {
        foreach (var d in Cases["decode"]!.AsArray())
            Assert.Equal(d![1]!.GetValue<string>(), SourceEdit.DecodeEntities(d[0]!.GetValue<string>()));
    }

    [Fact]
    public void Spellings_match_node()
    {
        foreach (var s in Cases["spell"]!.AsArray())
        {
            var expected = s![1]!.AsObject().Select(kv => (kv.Key, kv.Value!.GetValue<string>())).ToList();
            var actual = SourceEdit.Spellings(s[0]!.GetValue<string>()).Select(kv => (kv.Key, kv.Value)).ToList();
            Assert.Equal(expected, actual);
        }
    }

    /// <summary>Entities.g.cs is generated from src/server/entities.ts (node scripts/entities-cs.mjs); fails while they differ.</summary>
    [Fact]
    public void Entity_table_matches_src_server_entities_ts()
    {
        var ts = File.ReadAllText(Path.Combine(GoldenTests.Repo, "src", "server", "entities.ts"));
        string Const(string name)
        {
            var body = Regex.Match(ts, $@"export const {name} =([\s\S]*?);\r?\n").Groups[1].Value;
            return string.Concat(Regex.Matches(body, "'([^']*)'").Select(m => m.Groups[1].Value));
        }
        Assert.Equal(Entities.Packed, Const("PACKED"));
        Assert.Equal(Entities.Legacy, Const("LEGACY"));
        Assert.Equal(2125, Entities.Packed.Split(';').Length);
    }
}
