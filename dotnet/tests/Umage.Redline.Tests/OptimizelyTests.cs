using EPiServer.Core;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Umage.Redline.Optimizely;

namespace Umage.Redline.Tests;

public class OptimizelyTests
{
    [Fact]
    public void Stamp_value_is_content_without_version_and_property()
    {
        Assert.Equal("5|Heading", CmsStamp.Value(new ContentReference(5, 12), "Heading"));
        Assert.Equal("5|", CmsStamp.Value(new ContentReference(5), null));
        Assert.Equal("|Heading", CmsStamp.Value(null, "Heading"));
    }

    [Theory]
    [InlineData("/EPiServer/CMS/", "", true)]
    [InlineData("/episerver/cms/Content/start", "", true)]
    [InlineData("/Util/Login", "", true)]
    [InlineData("/", "?epieditmode=true", true)]
    [InlineData("/", "", false)]
    [InlineData("/about-us/", "?q=1", false)]
    public void No_overlay_in_the_cms_ui_or_edit_mode(string path, string query, bool excluded)
    {
        var http = new DefaultHttpContext { RequestServices = new ServiceCollection().BuildServiceProvider() };
        http.Request.Path = path;
        http.Request.QueryString = new QueryString(query);
        Assert.Equal(excluded, RedlineOptimizelyExtensions.InCmsUi(http));
    }
}
