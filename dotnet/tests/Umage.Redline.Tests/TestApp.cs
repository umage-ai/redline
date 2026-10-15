using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Umage.Redline.Tests;

/// <summary>A minimal app on TestServer with Redline, in a temp "repo" (a folder with .git).</summary>
public sealed class TestApp : IAsyncDisposable
{
    public const string Page = "<!doctype html><html><head><title>T</title></head><body><h1>Hello</h1></body></html>";

    public WebApplication App { get; }
    public HttpClient Client { get; }
    public string Root { get; }

    TestApp(WebApplication app, string root)
    {
        App = app;
        Root = root;
        Client = app.GetTestClient();
    }

    public static async Task<TestApp> StartAsync(Action<RedlineOptions>? configure = null, string environment = "Development", Action<IServiceCollection>? services = null)
    {
        var root = Path.Combine(Path.GetTempPath(), "redline-test-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(Path.Combine(root, ".git"));
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment, ContentRootPath = root });
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddAuthentication(TestAuth.Scheme).AddScheme<AuthenticationSchemeOptions, TestAuth>(TestAuth.Scheme, _ => { });
        builder.Services.AddAuthorization(o => o.AddPolicy("Reviewers", p => p.RequireRole("Reviewers")));
        builder.Services.AddRedline(configure);
        services?.Invoke(builder.Services);
        var app = builder.Build();
        app.MapGet("/", () => Results.Content(Page, "text/html; charset=utf-8"));
        app.MapGet("/fragment", () => Results.Content("<p>no head or body</p>", "text/html"));
        app.MapGet("/json", () => Results.Json(new { a = 1 }));
        app.MapGet("/stream", async (HttpContext http) =>
        {
            // Writes split mid-tag and flushes between, like streaming rendering.
            http.Response.ContentType = "text/html";
            foreach (var part in new[] { "<html><head><title>S</title></he", "ad><body><p>first</p>", "<p>second</p></body></html>" })
            {
                await http.Response.WriteAsync(part);
                await http.Response.Body.FlushAsync();
            }
        });
        await app.StartAsync();
        return new TestApp(app, root);
    }

    public HttpRequestMessage Get(string url, string? user = null, string? roles = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Accept.ParseAdd("text/html");
        User(req, user, roles);
        return req;
    }

    public static HttpRequestMessage Json(HttpMethod method, string url, string json, string? user = null, string? roles = null, bool header = true)
    {
        var req = new HttpRequestMessage(method, url) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
        if (header) req.Headers.Add("x-redline", "1");
        User(req, user, roles);
        return req;
    }

    static void User(HttpRequestMessage req, string? user, string? roles)
    {
        if (user is not null) req.Headers.Add("X-Test-User", user);
        if (roles is not null) req.Headers.Add("X-Test-Roles", roles);
    }

    public async ValueTask DisposeAsync()
    {
        await App.DisposeAsync();
        try { Directory.Delete(Root, true); } catch (IOException) { }
    }
}

/// <summary>Signs in whoever X-Test-User names, with X-Test-Roles (comma separated).</summary>
public sealed class TestAuth : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public const string Scheme = "Test";

#if NET8_0
    public TestAuth(IOptionsMonitor<AuthenticationSchemeOptions> o, ILoggerFactory l, UrlEncoder e, ISystemClock c) : base(o, l, e, c) { }
#else
    public TestAuth(IOptionsMonitor<AuthenticationSchemeOptions> o, ILoggerFactory l, UrlEncoder e) : base(o, l, e) { }
#endif

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var user = Request.Headers["X-Test-User"].ToString();
        if (user.Length == 0) return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(ClaimTypes.Name, user) };
        claims.AddRange(Request.Headers["X-Test-Roles"].ToString().Split(',', StringSplitOptions.RemoveEmptyEntries).Select(r => new Claim(ClaimTypes.Role, r.Trim())));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme)), Scheme)));
    }
}
