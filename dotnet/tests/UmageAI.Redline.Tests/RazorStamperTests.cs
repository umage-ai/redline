using UmageAI.Redline.Build;

namespace UmageAI.Redline.Tests;

public class RazorStamperTests
{
    static string Stamp(string src, string path = "Pages/Index.cshtml") => RazorStamper.Stamp(src, path) ?? src;
    static string S(string path, int line, int col) => $" data-redline-src=\"{path}:{line}:{col}\"";

    [Fact]
    public void Stamps_html_elements_with_line_and_column()
    {
        var src = "@page\n@model IndexModel\n<div class=\"x\">\n  <h1>Hello</h1>\n  <p>Text <b>bold</b></p>\n</div>\n";
        var expected = $"@page\n@model IndexModel\n<div{S("Pages/Index.cshtml", 3, 1)} class=\"x\">\n  <h1{S("Pages/Index.cshtml", 4, 3)}>Hello</h1>\n  <p{S("Pages/Index.cshtml", 5, 3)}>Text <b{S("Pages/Index.cshtml", 5, 11)}>bold</b></p>\n</div>\n";
        Assert.Equal(expected, Stamp(src));
    }

    [Fact]
    public void Keeps_line_count()
    {
        var src = "<ul>\n@foreach (var x in Model.Items)\n{\n    <li>@x</li>\n}\n</ul>\n";
        var stamped = Stamp(src);
        Assert.Equal(src.Split('\n').Length, stamped.Split('\n').Length);
        Assert.Contains($"<li{S("Pages/Index.cshtml", 4, 5)}>@x</li>", stamped);
    }

    [Fact]
    public void Skips_components_tag_helpers_head_elements_and_text()
    {
        var src = "<head><title>T</title><meta charset=\"utf-8\" /><link rel=\"x\" href=\"y\" /></head>\n<partial name=\"_X\" />\n<environment include=\"Development\"><p>dev</p></environment>\n<NavLink href=\"/\">Home</NavLink>\n<Counter IncrementAmount=\"2\" />\n@{ <text>plain</text> }\n<!-- <div>commented</div> -->\n<DIV>upper</DIV>\n";
        var stamped = Stamp(src);
        Assert.DoesNotContain("<title data", stamped);
        Assert.DoesNotContain("<meta data", stamped);
        Assert.DoesNotContain("<partial data", stamped);
        Assert.DoesNotContain("<environment data", stamped);
        Assert.DoesNotContain("<NavLink data", stamped);
        Assert.DoesNotContain("<Counter data", stamped);
        Assert.DoesNotContain("<text data", stamped);
        Assert.DoesNotContain("<div data-redline-src=\"Pages/Index.cshtml:7", stamped);
        Assert.DoesNotContain("<DIV data", stamped);
        Assert.Contains("<p data-redline-src=\"Pages/Index.cshtml:3:", stamped);
    }

    [Fact]
    public void Leaves_csharp_strings_and_comparisons_alone()
    {
        var src = "@{\n    var html = \"<div>not markup</div>\";\n    var v = @\"<span>\"\"x\"\"</span>\";\n    var i = $\"<b>{(1 < 2 ? \"<i>\" : \"\")}</b>\";\n    var ok = a < b && c > d;\n    var list = new List<int>();\n    // <p>in a comment</p>\n    /* <p>block comment</p> */\n    char c = '<';\n}\n<p>@Html.Raw(\"<em>raw</em>\")</p>\n@await Component.InvokeAsync(\"Menu\", new { tag = \"<nav>\" })\n<a href=\"@Url.Page(\"/Index\", new { q = \"<b>\" })\">Home</a>\n";
        var stamped = Stamp(src);
        Assert.Contains("\"<div>not markup</div>\"", stamped);
        Assert.Contains("@\"<span>\"\"x\"\"</span>\"", stamped);
        Assert.Contains("$\"<b>{(1 < 2 ? \"<i>\" : \"\")}</b>\"", stamped);
        Assert.Contains("// <p>in a comment</p>", stamped);
        Assert.Contains("@Html.Raw(\"<em>raw</em>\")", stamped);
        Assert.Contains("new { tag = \"<nav>\" }", stamped);
        Assert.Contains("new { q = \"<b>\" }", stamped);
        Assert.Contains("<p data-redline-src=\"Pages/Index.cshtml:11:1\">", stamped);
        Assert.Contains("<a data-redline-src=\"Pages/Index.cshtml:13:1\" href=", stamped);
    }

    [Fact]
    public void Follows_markup_inside_code_blocks_and_statements()
    {
        var src = "@if (Model.Show)\n{\n    <p>shown</p>\n}\nelse if (x)\n{\n    <span>other</span>\n}\nelse\n{\n    <em>none</em>\n}\n@switch (x)\n{\n    case 1:\n        <b>one</b>\n        break;\n}\n@{ var t = 1; <i>in block</i> }\n@try { <u>try</u> } catch (Exception) { <s>caught</s> }\n";
        var stamped = Stamp(src);
        foreach (var tag in new[] { "p", "span", "em", "b", "i", "u", "s" }) Assert.Contains($"<{tag} data-redline-src", stamped);
    }

    [Fact]
    public void Razor_components_code_block_and_directive_attributes()
    {
        var src = "@page \"/counter\"\n@rendermode InteractiveServer\n<h1>Counter</h1>\n<p role=\"status\">Current count: @currentCount</p>\n<button class=\"btn\" @onclick=\"IncrementCount\">Click me</button>\n<input @bind=\"name\" @bind:event=\"oninput\" />\n<button @onclick=\"() => Add(1 > 0)\">Add</button>\n@code {\n    private int currentCount = 0;\n    private void IncrementCount() { if (currentCount < 10) currentCount++; }\n    RenderFragment frag = @<div>template</div>;\n}\n";
        var stamped = Stamp(src, "Components/Pages/Counter.razor");
        Assert.Contains("<h1 data-redline-src=\"Components/Pages/Counter.razor:3:1\">", stamped);
        Assert.Contains("<button data-redline-src=\"Components/Pages/Counter.razor:5:1\" class=\"btn\" @onclick=", stamped);
        Assert.Contains("<input data-redline-src=\"Components/Pages/Counter.razor:6:1\" @bind=", stamped);
        Assert.Contains("<button data-redline-src=\"Components/Pages/Counter.razor:7:1\" @onclick=\"() => Add(1 > 0)\">", stamped);
        Assert.Contains("<div data-redline-src=\"Components/Pages/Counter.razor:11:", stamped);
        Assert.Contains("if (currentCount < 10)", stamped);
    }

    [Fact]
    public void Sections_scripts_and_styles()
    {
        var src = "<style>p > b { color: red }</style>\n@section Scripts {\n    <script>if (a < b) { document.write('<p>'); }</script>\n    <div>in section</div>\n}\n<footer>end</footer>\n";
        var stamped = Stamp(src);
        Assert.Contains("document.write('<p>')", stamped);
        Assert.Contains("<div data-redline-src=\"Pages/Index.cshtml:4:5\">", stamped);
        Assert.Contains("<footer data-redline-src=\"Pages/Index.cshtml:6:1\">", stamped);
    }

    [Fact]
    public void Path_is_escaped_for_razor_and_html()
    {
        var stamped = Stamp("<p>x</p>", "Pages/@me & \"you\".cshtml");
        Assert.Equal("<p data-redline-src=\"Pages/@@me &amp; &quot;you&quot;.cshtml:1:1\">x</p>", stamped);
    }

    [Fact]
    public void Gives_up_on_unbalanced_files()
    {
        Assert.Null(RazorStamper.Stamp("@{ <p>never closed\n", "x.cshtml"));
        Assert.Null(RazorStamper.Stamp("<p>@(\"unclosed</p>", "x.cshtml"));
    }

    [Fact]
    public void Already_stamped_elements_are_left()
    {
        Assert.Null(RazorStamper.Stamp("<p data-redline-src=\"a:1:1\">x</p>", "x.cshtml"));
    }

    [Fact]
    public void Email_addresses_and_escaped_at()
    {
        var stamped = Stamp("<p>mail me@example.com or @@handle</p>\n<span>after</span>");
        Assert.Contains("<span data-redline-src", stamped);
    }
}
