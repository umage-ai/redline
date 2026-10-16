using BlazorSample.Components;
using UmageAI.Redline;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();
// Redline: dev only by default; Alt+Shift+R in the browser. Its middleware goes first in the
// pipeline and injects the overlay into every HTML response, including streamed and
// enhanced-navigation responses.
builder.Services.AddRedline(o => o.DirectEdit = true);

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseWebAssemblyDebugging();
}
else
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    app.UseHsts();
}
app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);

app.UseAntiforgery();

app.MapStaticAssets();
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode()
    .AddAdditionalAssemblies(typeof(BlazorSample.Client._Imports).Assembly);

app.Run();
