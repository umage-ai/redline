using System.ComponentModel.DataAnnotations;
using EPiServer.Core;
using EPiServer.DataAnnotations;
using EPiServer.Web.Mvc;
using Microsoft.AspNetCore.Mvc;

namespace OptimizelySample;

[ContentType(DisplayName = "Start page", GUID = "6d1b3b5e-0a4e-4c8e-9a7a-1f5b2c3d4e01")]
public class StartPage : PageData
{
    [Display(Name = "Heading", Order = 10)]
    public virtual string? Heading { get; set; }

    [Display(Name = "Teaser", Order = 20)]
    public virtual string? Teaser { get; set; }

    [Display(Name = "Main body", Order = 30)]
    public virtual XhtmlString? MainBody { get; set; }

    [Display(Name = "Main content area", Order = 40)]
    public virtual ContentArea? MainContentArea { get; set; }
}

[ContentType(DisplayName = "Teaser block", GUID = "6d1b3b5e-0a4e-4c8e-9a7a-1f5b2c3d4e02")]
public class TeaserBlock : BlockData
{
    [Display(Name = "Heading", Order = 10)]
    public virtual string? Heading { get; set; }
}

public class StartPageController : PageController<StartPage>
{
    public IActionResult Index(StartPage currentPage) => View(currentPage);
}

public class TeaserBlockViewComponent : BlockComponent<TeaserBlock>
{
    protected override IViewComponentResult InvokeComponent(TeaserBlock currentContent) => View(currentContent);
}
