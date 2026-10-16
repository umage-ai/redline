using Microsoft.AspNetCore.Mvc;

namespace RazorSample.Controllers;

/// <summary>An MVC view next to the Razor Pages, to show both get source stamps.</summary>
public class HomeController : Controller
{
    [Route("/mvc")]
    public IActionResult Index() => View(new[] { "Pinned comments", "Text changes", "Sketches" });
}
