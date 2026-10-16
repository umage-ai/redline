using System.Text;
using System.Text.Json.Nodes;
using UmageAI.Redline.Notes;

namespace UmageAI.Redline.Tests;

public class JsTests
{
    // Expected values are what Node prints for String(x) / JSON.stringify(x).
    [Theory]
    [InlineData(0.0, "0")]
    [InlineData(-0.0, "0")]
    [InlineData(1.0, "1")]
    [InlineData(-1.5, "-1.5")]
    [InlineData(0.1, "0.1")]
    [InlineData(0.123, "0.123")]
    [InlineData(1e-7, "1e-7")]
    [InlineData(0.000001, "0.000001")]
    [InlineData(1e21, "1e+21")]
    [InlineData(1e20, "100000000000000000000")]
    [InlineData(123456789012345680000.0, "123456789012345680000")]
    [InlineData(12345678901234567890.0, "12345678901234567000")]
    [InlineData(1.7976931348623157e308, "1.7976931348623157e+308")]
    [InlineData(5e-324, "5e-324")]
    [InlineData(0.30000000000000004, "0.30000000000000004")]
    [InlineData(1.5, "1.5")]
    [InlineData(2.675, "2.675")]
    public void Number_prints_like_javascript(double d, string expected) => Assert.Equal(expected, Js.Number(d));

    [Fact]
    public void Strings_escape_like_JSON_stringify()
    {
        var s = "q\" b\\ \b\f\n\r\t \u0001 \u001f \u007f \u2028 æ 😀 " + "\ud800" + " </script>";
        Assert.Equal("\"q\\\" b\\\\ \\b\\f\\n\\r\\t \\u0001 \\u001f \u007f \u2028 æ 😀 \\ud800 </script>\"", Js.Stringify(JsonValue.Create(s)));
    }

    [Fact]
    public void Objects_keep_key_order()
    {
        var o = (JsonObject)NoteFormat.ParseJson("{\"b\":1,\"a\":[true,null,\"x\"],\"c\":{\"z\":1.50,\"y\":1E2}}")!;
        Assert.Equal("{\"b\":1,\"a\":[true,null,\"x\"],\"c\":{\"z\":1.5,\"y\":100}}", Js.Stringify(o));
    }

    [Fact]
    public void Duplicate_keys_keep_the_last_value_at_the_first_position()
    {
        var o = (JsonObject)NoteFormat.ParseJson("{\"a\":1,\"b\":2,\"a\":3}")!;
        Assert.Equal("{\"a\":3,\"b\":2}", Js.Stringify(o));
    }

    [Fact]
    public void Trim_uses_javascript_whitespace()
    {
        Assert.Equal("x", Js.Trim("\ufeff\u00a0 x\u2028\t"));
        Assert.Equal("\u0085x", Js.Trim("\u0085x"));   // NEL is not JS whitespace
    }
}
