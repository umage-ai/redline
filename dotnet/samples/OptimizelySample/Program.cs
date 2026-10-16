using System.Security.Claims;
using EPiServer;
using EPiServer.Core;
using EPiServer.Scheduler;
using EPiServer.Web.Routing;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Data.SqlClient;
using UmageAI.Redline.Optimizely;

// A minimal Optimizely CMS 12 site with Redline. The database (LocalDB) and the sample content
// are created on first start; /dev/login signs you in as an editor (Development only).
// The Startup pattern (not minimal hosting) lets the CMS initialize its database before
// MapContent wires up the edit UI.

Host.CreateDefaultBuilder(args)
    .ConfigureCmsDefaults()
    .ConfigureWebHostDefaults(web => web.UseStartup<Startup>())
    .Build()
    .Run();

public class Startup
{
    readonly IConfiguration _config;
    readonly IWebHostEnvironment _env;

    public Startup(IConfiguration config, IWebHostEnvironment env)
    {
        _config = config;
        _env = env;
    }

    public void ConfigureServices(IServiceCollection services)
    {
        EnsureDatabase(_config.GetConnectionString("EPiServerDB")!);
        services.Configure<SchedulerOptions>(o => o.Enabled = false);
        services.Configure<EPiServer.Data.DataAccessOptions>(o => { o.CreateDatabaseSchema = true; o.UpdateDatabaseSchema = true; });
        services
            .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
            .AddCookie(o => o.LoginPath = "/dev/login");
        services.AddCms();
        // After AddCms: Redline in view mode, notes naming the CMS content, text edits as drafts.
        services.AddRedlineOptimizely(o => o.DirectEdit = true);
    }

    public void Configure(IApplicationBuilder app)
    {
        app.UseStaticFiles();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseEndpoints(endpoints =>
        {
            if (_env.IsDevelopment())
            {
                endpoints.MapGet("/dev/login", async (HttpContext http, string? returnUrl) =>
                {
                    var id = new ClaimsIdentity(new[] { new Claim(ClaimTypes.Name, "editor"), new Claim(ClaimTypes.Role, "WebEditors"), new Claim(ClaimTypes.Role, "WebAdmins") }, CookieAuthenticationDefaults.AuthenticationScheme);
                    await http.SignInAsync(new ClaimsPrincipal(id));
                    return Results.Redirect(returnUrl ?? "/");
                });
                // The property value of the content's shared draft (what Redline's draft writer saved).
                endpoints.MapGet("/dev/draft/{id}/{property}", (string id, string property, IContentRepository repo, IContentVersionRepository versions) =>
                {
                    var link = ContentReference.Parse(id);
                    var draft = versions.LoadCommonDraft(link, "en");
                    var content = repo.Get<IContentData>(draft?.ContentLink ?? link);
                    return Results.Json(new { work = draft?.ContentLink.WorkID, status = draft?.Status.ToString(), value = content.Property[property]?.Value?.ToString() });
                });
                // Drop the shared draft again (the browser smoke test starts from the published text).
                endpoints.MapPost("/dev/draft/{id}/reset", (HttpContext http, string id, IContentVersionRepository versions) =>
                {
                    // As an admin: the CMS checks Delete access against the request's user.
                    http.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.Name, "reset"), new Claim(ClaimTypes.Role, "WebAdmins") }, "dev"));
                    var draft = versions.LoadCommonDraft(ContentReference.Parse(id), "en");
                    if (draft is not null && draft.Status != EPiServer.Core.VersionStatus.Published) versions.Delete(draft.ContentLink);
                    return Results.Ok();
                });
            }
            endpoints.MapContent();
        });
    }

    static void EnsureDatabase(string connectionString)
    {
        var b = new SqlConnectionStringBuilder(connectionString);
        var name = b.InitialCatalog;
        b.InitialCatalog = "master";
        using var c = new SqlConnection(b.ConnectionString);
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"IF DB_ID(N'{name.Replace("'", "''")}') IS NULL CREATE DATABASE [{name.Replace("]", "]]")}]";
        cmd.ExecuteNonQuery();
    }
}
