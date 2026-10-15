using EPiServer.Web;
using EPiServer.Web.Mvc.Html;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Umage.Redline.Editing;
using Umage.Redline.Notes;

namespace Umage.Redline.Optimizely;

public sealed class RedlineOptimizelyOptions
{
    /// <summary>Save text-mode edits of plain CMS text as content drafts (never published). Default true.</summary>
    public bool ContentDrafts { get; set; } = true;
    /// <summary>Stamp data-redline-cms on PropertyFor output and content area items. Default true.</summary>
    public bool StampContent { get; set; } = true;
    /// <summary>Link to the content in the edit UI; {0} is the content id.</summary>
    public string EditUrlFormat { get; set; } = "/EPiServer/CMS/#context=epi.cms.contentdata:///{0}";
    /// <summary>Online mode's note tables live in this database (the CMS's own by default).</summary>
    public string ConnectionStringName { get; set; } = "EPiServerDB";
    /// <summary>Roles that may review online when RedlineOptions has no Policy or Roles.</summary>
    public List<string> DefaultRoles { get; } = new() { "WebEditors", "WebAdmins", "CmsEditors", "CmsAdmins", "Administrators" };
}

public static class RedlineOptimizelyExtensions
{
    /// <summary>
    /// Redline for an Optimizely CMS site. Call after <c>AddCms()</c>. Development: the overlay
    /// in view mode (not in edit-mode frames), notes as markdown. Online (<c>o.Online = true</c>):
    /// for signed-in editors only, notes in the CMS database. Either way notes name the CMS
    /// content and property behind the text, and text edits can become content drafts.
    /// </summary>
    public static IServiceCollection AddRedlineOptimizely(this IServiceCollection services, Action<RedlineOptions>? configure = null, Action<RedlineOptimizelyOptions>? optimizely = null)
    {
        services.AddRedline(configure);
        services.AddOptions<RedlineOptimizelyOptions>().BindConfiguration("Redline:Optimizely");
        if (optimizely is not null) services.Configure(optimizely);
        services.AddHttpContextAccessor();

        services.AddOptions<RedlineOptions>().PostConfigure<IServiceProvider>((o, sp) =>
        {
            var opti = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<RedlineOptimizelyOptions>>().Value;
            var exclude = o.Exclude;
            o.Exclude = http => exclude?.Invoke(http) == true || InCmsUi(http);
            if (o.Online && o.Policy is null && o.Roles.Count == 0) o.Roles.AddRange(opti.DefaultRoles);
            if (o.Online && o.Store is null)
            {
                var cs = sp.GetRequiredService<IConfiguration>().GetConnectionString(opti.ConnectionStringName)
                    ?? throw new InvalidOperationException($"Redline online mode: no connection string '{opti.ConnectionStringName}'.");
                o.Store = (_, _) => new SqlNoteStore(() => new SqlConnection(cs), SqlDialect.SqlServer);
            }
        });

        services.TryAddEnumerable(ServiceDescriptor.Singleton<IRedlineHooks, CmsNoteHooks>());
        services.AddSingleton<ISourceWriter>(sp => sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<RedlineOptimizelyOptions>>().Value.ContentDrafts
            ? ActivatorUtilities.CreateInstance<ContentDraftWriter>(sp)
            : new NoWriter());
        // Replace the CMS renderers (registered by AddCms) with the stamping ones.
        services.AddTransient<PropertyRenderer, RedlinePropertyRenderer>();
        services.AddTransient<ContentAreaRenderer, RedlineContentAreaRenderer>();
        return services;
    }

    /// <summary>The CMS UI, edit-mode and preview frames: Optimizely's own overlay owns the page there.</summary>
    public static bool InCmsUi(HttpContext http)
    {
        var path = http.Request.Path.Value ?? "";
        if (path.StartsWith("/episerver", StringComparison.OrdinalIgnoreCase) || path.StartsWith("/util", StringComparison.OrdinalIgnoreCase)) return true;
        if (http.Request.Query.ContainsKey("epieditmode")) return true;
        var mode = http.RequestServices.GetService<IContextModeResolver>()?.CurrentMode;
        return mode is ContextMode.Edit or ContextMode.Preview;
    }

    sealed class NoWriter : ISourceWriter
    {
        public string Name => "none";
        public bool WritesFiles => false;
        public Task<EditResult?> ApplyAsync(EditRequest req, WriterContext ctx, CancellationToken ct = default) => Task.FromResult<EditResult?>(null);
    }
}
