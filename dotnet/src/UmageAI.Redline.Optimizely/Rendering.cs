// Where CMS content is rendered in view mode, add data-redline-cms so a note names the content
// and property rather than the template line (D33). Edit mode has its own data-epi-* markup and
// gets no overlay, so nothing is added there.

using System.Linq.Expressions;
using EPiServer.Core;
using EPiServer.Web.Mvc.Html;
using Microsoft.AspNetCore.Html;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Rendering;
using Microsoft.AspNetCore.Mvc.ViewFeatures;
using Microsoft.AspNetCore.Razor.TagHelpers;
using Microsoft.Extensions.DependencyInjection;

namespace UmageAI.Redline.Optimizely;

/// <summary>
/// <c>@Html.PropertyFor(x => x.Heading)</c>: in view mode the value is wrapped in
/// <c>&lt;redline-cms data-redline-cms="5|Heading" style="display:contents"&gt;</c> (layout unchanged).
/// </summary>
public class RedlinePropertyRenderer : PropertyRenderer
{
    public override IHtmlContent PropertyFor<TModel, TValue>(IHtmlHelper<TModel> html, string viewModelPropertyName, object additionalViewData, object editorSettings, Expression<Func<TModel, TValue>> expression, Func<string, IHtmlContent> displayForAction)
    {
        var inner = base.PropertyFor(html, viewModelPropertyName, additionalViewData, editorSettings, expression, displayForAction);
        var http = html.ViewContext.HttpContext;
        if (!CmsStamp.Active(http)) return inner;
        string? stamp;
        try
        {
            var provider = http.RequestServices.GetRequiredService<ModelExpressionProvider>();
            stamp = CmsStamp.For(provider.CreateModelExpression(html.ViewData, expression).ModelExplorer);
        }
        catch (Exception) { stamp = null; }
        if (stamp is null) return inner;
        var wrap = new TagBuilder("redline-cms");
        wrap.Attributes[CmsStamp.Attr] = stamp;
        wrap.Attributes["style"] = "display:contents";
        wrap.InnerHtml.AppendHtml(inner);
        return wrap;
    }
}

/// <summary>Content area items: the block's wrapper element names the block (content only, no property).</summary>
public class RedlineContentAreaRenderer : ContentAreaRenderer
{
    protected override void BeforeRenderContentAreaItemStartTag(TagBuilder tagBuilder, ContentAreaItem contentAreaItem)
    {
        base.BeforeRenderContentAreaItemStartTag(tagBuilder, contentAreaItem);
        var http = (EPiServer.ServiceLocation.ServiceLocator.Current.GetService(typeof(IHttpContextAccessor)) as IHttpContextAccessor)?.HttpContext;
        if (CmsStamp.Active(http)) tagBuilder.Attributes[CmsStamp.Attr] = CmsStamp.Value(contentAreaItem.ContentLink, null);
    }
}

/// <summary>
/// <c>&lt;h1 epi-property="@Model.Heading" /&gt;</c>: the element itself gets data-redline-cms.
/// Register with <c>@addTagHelper *, UmageAI.Redline.Optimizely</c> in _ViewImports.cshtml.
/// </summary>
[HtmlTargetElement(Attributes = "epi-property")]
public class RedlineCmsTagHelper : TagHelper
{
    [HtmlAttributeName("epi-property")]
    public ModelExpression? For { get; set; }

    [ViewContext, HtmlAttributeNotBound]
    public ViewContext? ViewContext { get; set; }

    public override int Order => 1000;

    public override void Process(TagHelperContext context, TagHelperOutput output)
    {
        if (!CmsStamp.Active(ViewContext?.HttpContext)) return;
        if (CmsStamp.For(For?.ModelExplorer) is { } stamp) output.Attributes.SetAttribute(CmsStamp.Attr, stamp);
    }
}
