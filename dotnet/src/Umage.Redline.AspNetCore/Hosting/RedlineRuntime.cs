// What the middleware needs, resolved once at startup: paths, the store, writers, hooks and the
// access check (dev: everyone on the dev server; online: authorized reviewers only, D34).

using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Umage.Redline.Editing;
using Umage.Redline.Notes;
using Umage.Redline.Security;

namespace Umage.Redline.Hosting;

public sealed class RedlineRuntime
{
    readonly IServiceProvider _services;
    readonly ILogger _log;
    byte[]? _client;

    public RedlineRuntime(IServiceProvider services, IOptions<RedlineOptions> options, IWebHostEnvironment env, ILogger<RedlineRuntime> log)
    {
        _services = services;
        _log = log;
        Options = options.Value;
        var serverRoot = env.ContentRootPath;
        var root = Options.Root is { Length: > 0 } r ? Path.GetFullPath(r) : RedlinePaths.FindRoot(serverRoot);
        Context = new RedlineContext
        {
            Root = root,
            Dir = Options.Dir,
            App = Options.App ?? RedlinePaths.AppOf(root, serverRoot),
            ServerRoot = serverRoot,
            WebRoot = env.WebRootPath,
            Online = Options.Online,
            Development = env.IsDevelopment(),
        };
        Enabled = Options.Online || (Options.EnabledWhen?.Invoke(env) ?? env.IsDevelopment());
        Store = Options.Store?.Invoke(services, Context)
            ?? (Options.Online ? throw new InvalidOperationException("Redline online mode needs a database store: o.UseSqlStore(...) (or the Optimizely integration's default).")
                               : new MarkdownNoteStore(root, Options.Dir));
        Tokens = Store as ITokenStore ?? services.GetService<ITokenStore>();
        var writers = new List<ISourceWriter>(Options.Writers);
        writers.AddRange(services.GetServices<ISourceWriter>());
        if (Options.DirectEdit) writers.AddRange(SourceWriters.Defaults());
        Writers = writers.Where(w => !Options.Online || !w.WritesFiles).ToList();
        if (Options.Online && Options.Policy is null && Options.Roles.Count == 0)
            _log.LogWarning("Redline online mode has no Policy or Roles: nobody can use the overlay.");
    }

    public RedlineOptions Options { get; }
    public RedlineContext Context { get; }
    public INoteStore Store { get; }
    public ITokenStore? Tokens { get; }
    public IReadOnlyList<ISourceWriter> Writers { get; }
    /// <summary>False outside Development unless online mode or <see cref="RedlineOptions.EnabledWhen"/> says otherwise.</summary>
    public bool Enabled { get; }

    public IEnumerable<IRedlineHooks> Hooks => _services.GetServices<IRedlineHooks>();

    public byte[] ClientJs => _client ??= ReadResource("Umage.Redline.client.js");

    internal static byte[] ReadResource(string name)
    {
        using var s = typeof(RedlineRuntime).Assembly.GetManifestResourceStream(name) ?? throw new InvalidOperationException($"missing resource {name}");
        using var m = new MemoryStream();
        s.CopyTo(m);
        return m.ToArray();
    }

    /// <summary>The reviewer for this request, or null when Redline isn't for them. Dev mode: an anonymous reviewer.</summary>
    public async Task<ClaimsPrincipal?> ReviewerAsync(HttpContext http)
    {
        if (!Options.Online) return http.User;
        var user = http.User;
        if (user.Identity?.IsAuthenticated != true)
        {
            // Redline may run before UseAuthentication: authenticate with the default scheme ourselves.
            try
            {
                var schemes = http.RequestServices.GetService<IAuthenticationSchemeProvider>();
                if (schemes is not null && await schemes.GetDefaultAuthenticateSchemeAsync() is not null)
                {
                    var result = await http.AuthenticateAsync();
                    if (result.Succeeded && result.Principal is not null) user = result.Principal;
                }
            }
            catch (InvalidOperationException) { /* no authentication configured */ }
        }
        if (user.Identity?.IsAuthenticated != true) return null;
        if (Options.Policy is { } policy)
        {
            var auth = http.RequestServices.GetRequiredService<IAuthorizationService>();
            return (await auth.AuthorizeAsync(user, policy)).Succeeded ? user : null;
        }
        return Options.Roles.Any(user.IsInRole) ? user : null;
    }

    public async Task Hook(Func<IRedlineHooks, Task> call, string name)
    {
        foreach (var h in Hooks)
        {
            try { await call(h); }
            catch (Exception ex) { _log.LogWarning(ex, "[redline] hooks.{Hook} failed", name); }
        }
    }

    readonly HashSet<string> _registered = new();

    /// <summary>Let `redline mcp` find this server (D22): registered once per URL it is reached on. Dev only.</summary>
    public void Register(string url)
    {
        if (Options.Online || !Enabled) return;
        lock (_registered) if (!_registered.Add(url)) return;
        _ = ServerRegistry.RegisterAsync(Context.Root, Context.Dir, url, Context.App);
    }
}
