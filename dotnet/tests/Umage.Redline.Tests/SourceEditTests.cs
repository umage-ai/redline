using Umage.Redline.Editing;

namespace Umage.Redline.Tests;

public class SourceEditTests
{
    const string Razor = "@page\n<div>\n  <h1 class=\"title\">Welcome</h1>\n  <p>Hello @Model.Name</p>\n  <p>Contact: hi@@example.com</p>\n  <p>See <a asp-page=\"/Privacy\">privacy</a></p>\n  <p>Read <b>this</b> now</p>\n  <p>Use <Counter /></p>\n</div>\n";

    [Fact]
    public void Edits_static_razor_text_at_the_stamped_line()
    {
        var r = SourceEdit.EditAt(Razor, "h1", 3, 3, "Welcome", "Welcome back", null, MarkupSyntax.Razor);
        Assert.True(r.Ok, r.Reason);
        Assert.Contains("<h1 class=\"title\">Welcome back</h1>", r.Content);
        Assert.Equal(3, r.Line);
    }

    [Fact]
    public void Refuses_razor_expressions()
    {
        var r = SourceEdit.EditAt(Razor, "p", 4, 3, "Hello Ann", "Hi Ann", null, MarkupSyntax.Razor);
        Assert.False(r.Ok);
        Assert.Contains("Razor code", r.Reason);
    }

    [Fact]
    public void Escaped_at_is_text_and_new_at_is_escaped()
    {
        var r = SourceEdit.EditAt(Razor, "p", 5, 3, "Contact: hi@example.com", "Mail: team@example.com", null, MarkupSyntax.Razor);
        Assert.True(r.Ok, r.Reason);
        Assert.Contains("<p>Mail: team@@example.com</p>", r.Content);
    }

    [Fact]
    public void Refuses_tag_helpers_and_components()
    {
        var helper = SourceEdit.EditAt(Razor, "p", 6, 3, "See privacy", "See our privacy", null, MarkupSyntax.Razor);
        Assert.False(helper.Ok);
        Assert.Contains("tag helper", helper.Reason);
        var comp = SourceEdit.EditAt(Razor, "p", 8, 3, "Use", "Use it", null, MarkupSyntax.Razor);
        Assert.False(comp.Ok);
        Assert.Contains("component", comp.Reason);
    }

    [Fact]
    public void Rich_edit_keeps_inline_markup()
    {
        var plain = SourceEdit.EditAt(Razor, "p", 7, 3, "Read this now", "Read that now", null, MarkupSyntax.Razor);
        Assert.False(plain.Ok);
        var rich = SourceEdit.EditAt(Razor, "p", 7, 3, "Read this now", "Read that now", "Read <b>that</b> now", MarkupSyntax.Razor);
        Assert.True(rich.Ok, rich.Reason);
        Assert.Contains("<p>Read <b>that</b> now</p>", rich.Content);
    }

    [Fact]
    public void Text_that_differs_from_source_is_refused()
    {
        var r = SourceEdit.EditAt(Razor, "h1", 3, 3, "Velkommen", "Hej", null, MarkupSyntax.Razor);
        Assert.False(r.Ok);
        Assert.Contains("differs", r.Reason);
    }

    [Fact]
    public void Html_entities_and_unique_lookup()
    {
        var html = "<main><p>Fish &amp; chips</p><p>Other</p></main>";
        var r = SourceEdit.EditUnique(html, "p", "Fish & chips", "Fish < chips", null);
        Assert.True(r.Ok, r.Reason);
        Assert.Equal("<main><p>Fish &lt; chips</p><p>Other</p></main>", r.Content);
    }

    [Fact]
    public void Razor_edits_keep_entity_spelling_and_escape_at()
    {
        var src = "<p>Mail hi@@x.dk &mdash; caf&eacute;</p>";
        var r = SourceEdit.EditAt(src, "p", 1, null, "Mail hi@x.dk — café", "Mail team@x.dk — café ©", null, MarkupSyntax.Razor);
        Assert.True(r.Ok, r.Reason);
        Assert.Equal("<p>Mail team@@x.dk &mdash; caf&eacute; ©</p>", r.Content);
    }

    [Fact]
    public void Resolve_keeps_edits_inside_the_project()
    {
        var root = Path.GetTempPath();
        Assert.Null(SourceWriters.ResolveInside(root, ".redline", "../outside.cshtml"));
        Assert.Null(SourceWriters.ResolveInside(root, ".redline", "bin/Debug/x.cshtml"));
        Assert.Null(SourceWriters.ResolveInside(root, ".redline", ".redline/pages/x.md"));
        Assert.NotNull(SourceWriters.ResolveInside(root, ".redline", "Pages/Index.cshtml"));
    }
}
