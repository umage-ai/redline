// data-redline-cms="<content id>|<property>": which CMS content and property rendered an
// element (D33). Stamped only on pages that get the overlay, never in edit mode.

using EPiServer.Core;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.ViewFeatures;
using UmageAI.Redline.Hosting;

namespace UmageAI.Redline.Optimizely;

public static class CmsStamp
{
    public const string Attr = "data-redline-cms";

    /// <summary>Stamp on this request? Only where the overlay is injected (not edit mode, not other visitors).</summary>
    public static bool Active(HttpContext? http) => RedlineMiddleware.IsOverlayRequest(http);

    /// <summary>"5|Heading" for a property of content 5; "|Heading" when the owner isn't content (a local block).</summary>
    public static string? For(ModelExplorer? explorer)
    {
        if (explorer is null) return null;
        var property = explorer.Metadata.PropertyName;
        var owner = explorer.Container?.Model as IContent;
        if (property is null && explorer.Model is IContent self) return Value(self.ContentLink, null);
        if (property is null) return null;
        return Value(owner?.ContentLink, property);
    }

    public static string Value(ContentReference? content, string? property) =>
        $"{(ContentReference.IsNullOrEmpty(content) ? "" : content!.ToReferenceWithoutVersion().ToString())}|{property}";
}
