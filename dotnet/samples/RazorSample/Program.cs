using UmageAI.Redline;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorPages();
builder.Services.AddControllersWithViews();
// Redline: dev only by default; Alt+Shift+R in the browser. DirectEdit lets text mode write static
// .cshtml text straight into the file.
builder.Services.AddRedline(o => o.DirectEdit = true);

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    app.UseHsts();
}

app.UseRouting();
app.UseAuthorization();

app.MapStaticAssets();
app.MapRazorPages().WithStaticAssets();
app.MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}");

app.Run();
