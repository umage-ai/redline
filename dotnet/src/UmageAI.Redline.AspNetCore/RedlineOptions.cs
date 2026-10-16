using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using UmageAI.Redline.Editing;
using UmageAI.Redline.Notes;

namespace UmageAI.Redline;

/// <summary>Options for <c>services.AddRedline(o => …)</c>. Mirrors RedlineOptions in src/server/handler.ts.</summary>
public sealed class RedlineOptions
{
    /// <summary>Project root for notes and repo-relative source paths. Default: nearest folder with .git, else the content root.</summary>
    public string? Root { get; set; }
    /// <summary>Notes folder relative to root. Default: .redline</summary>
    public string Dir { get; set; } = ".redline";
    /// <summary>Keyboard shortcut to toggle the overlay.</summary>
    public string Hotkey { get; set; } = "alt+shift+r";
    /// <summary>Show the small launcher button when the overlay is closed.</summary>
    public bool Launcher { get; set; } = true;
    /// <summary>
    /// What groups notes into one page (one notes file and one pin set), D26. <see cref="RedlinePageKey.Route"/>
    /// (default): the path plus a hash route (<c>#/settings</c>). <see cref="RedlinePageKey.Path"/>: the path only, so
    /// a page with hash-addressed views (a slide deck's <c>#/3</c>) keeps one notes file.
    /// </summary>
    public RedlinePageKey PageKey { get; set; } = RedlinePageKey.Route;
    /// <summary>Monorepos: the app's name in notes. Default: the content root relative to the repo root; "" at the root.</summary>
    public string? App { get; set; }

    /// <summary>
    /// When Redline runs. Default: in the Development environment only. Online mode
    /// (<see cref="Online"/>) runs in every environment, for authorized users only.
    /// </summary>
    public Func<IHostEnvironment, bool>? EnabledWhen { get; set; }

    /// <summary>Where notes go. Default: markdown in &lt;root&gt;/&lt;dir&gt; (dev); online mode needs a database store (<see cref="UseSqlStore"/>).</summary>
    public Func<IServiceProvider, RedlineContext, INoteStore>? Store { get; set; }

    /// <summary>
    /// Text mode can write the change straight into source when the text is static there (D20):
    /// .cshtml/.razor/.html. Default false: text edits are notes only. <see cref="Writers"/> run first.
    /// </summary>
    public bool DirectEdit { get; set; }
    /// <summary>Your own writers (tried before the built-in ones). Writers registered in DI as <see cref="ISourceWriter"/> are added too.</summary>
    public List<ISourceWriter> Writers { get; } = new();

    /// <summary>Overlay extensions (D21) as files relative to the content root, served as-is (plain browser ES modules).</summary>
    public List<string> Extensions { get; } = new();
    /// <summary>Overlay extensions loaded from a URL (e.g. "/js/redline.ext.js" from wwwroot).</summary>
    public List<string> ExtensionUrls { get; } = new();

    /// <summary>Don't put the middleware first automatically; call <c>app.UseRedline()</c> where it should run.</summary>
    public bool ManualPlacement { get; set; }

    /// <summary>Requests that get no overlay (the API still answers). E.g. CMS edit-mode frames.</summary>
    public Func<HttpContext, bool>? Exclude { get; set; }

    /// <summary>
    /// Online mode (D34): run on a deployed site for signed-in reviewers. The overlay and the
    /// /__redline API are only served to users who pass <see cref="Policy"/> (or have one of
    /// <see cref="Roles"/>); everyone else gets no script and 404s. Notes need a database store;
    /// file writers are off.
    /// </summary>
    public bool Online { get; set; }
    /// <summary>Authorization policy a reviewer must pass (online mode).</summary>
    public string? Policy { get; set; }
    /// <summary>Roles that may review (online mode), used when no <see cref="Policy"/> is set.</summary>
    public List<string> Roles { get; } = new();
    /// <summary>Extra origins allowed to send mutations (online mode checks Origin against the request host).</summary>
    public List<string> AllowedOrigins { get; } = new();

    /// <summary>The remote MCP endpoint (POST /__redline/mcp) for agents (D35).</summary>
    public RedlineMcpOptions Mcp { get; } = new();

    /// <summary>Keep notes in a database table (any ADO.NET provider; SQL Server and SQLite dialects).</summary>
    public RedlineOptions UseSqlStore(Func<System.Data.Common.DbConnection> connect, SqlDialect dialect = SqlDialect.SqlServer, string prefix = "Redline")
    {
        Store = (_, _) => new SqlNoteStore(connect, dialect, prefix);
        return this;
    }
}

/// <summary>How the overlay groups notes into pages (the pageKey option).</summary>
public enum RedlinePageKey
{
    /// <summary>The decoded path, <c>/index.html</c> folded into <c>/</c>, plus the hash when it is a hash route (<c>#/…</c>).</summary>
    Route,
    /// <summary>The path only; every hash is ignored.</summary>
    Path,
}

public sealed class RedlineMcpOptions
{
    /// <summary>Serve MCP over HTTP at /__redline/mcp. Default true.</summary>
    public bool Enabled { get; set; } = true;
    /// <summary>SHA-256 hashes (hex) of accepted bearer tokens. Generate one with <c>RedlineTokens.Create()</c>.</summary>
    public List<string> TokenHashes { get; } = new();
    /// <summary>Let reviewers create personal tokens (stored hashed, acting as that user). Needs a store that supports it.</summary>
    public bool PersonalTokens { get; set; } = true;
    /// <summary>In development, accept MCP requests from loopback without a token when no token is configured.</summary>
    public bool AllowLocalWithoutToken { get; set; } = true;
}

/// <summary>What Redline resolved at startup.</summary>
public sealed class RedlineContext
{
    public required string Root { get; init; }
    public required string Dir { get; init; }
    public required string App { get; init; }
    public required string ServerRoot { get; init; }
    public string? WebRoot { get; init; }
    public bool Online { get; init; }
    public bool Development { get; init; }
}
