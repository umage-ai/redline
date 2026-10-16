using Microsoft.AspNetCore.Mvc.RazorPages;

namespace RazorSample.Pages;

public class IndexModel : PageModel
{
    public string Name { get; private set; } = "reviewer";

    public void OnGet() { }
}
