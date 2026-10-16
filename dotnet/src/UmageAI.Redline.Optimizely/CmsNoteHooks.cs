// Before a note is stored: name the CMS content behind it (D33). The overlay sends what the page
// stamped (data-redline-cms: content id and property); this adds the content's name, type,
// language and edit-UI link, and falls back to the routed page for elements without a stamp.

using System.Text.Json.Nodes;
using EPiServer;
using EPiServer.Core;
using EPiServer.DataAbstraction;
using EPiServer.Web;
using EPiServer.Web.Routing;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UmageAI.Redline.Notes;

namespace UmageAI.Redline.Optimizely;

public sealed class CmsNoteHooks : IRedlineHooks
{
    readonly IContentLoader _loader;
    readonly IUrlResolver _urls;
    readonly IContentTypeRepository _types;
    readonly RedlineOptimizelyOptions _options;
    readonly ILogger<CmsNoteHooks> _log;

    public CmsNoteHooks(IContentLoader loader, IUrlResolver urls, IContentTypeRepository types, IOptions<RedlineOptimizelyOptions> options, ILogger<CmsNoteHooks> log)
    {
        _loader = loader;
        _urls = urls;
        _types = types;
        _options = options.Value;
        _log = log;
    }

    public Task OnCreatingAsync(Note note, HttpContext http)
    {
        try { Enrich(note); }
        catch (Exception ex) { _log.LogWarning(ex, "[redline] could not resolve CMS content for a note"); }
        return Task.CompletedTask;
    }

    void Enrich(Note note)
    {
        var target = note.Target;
        var cms = target?["cms"] as JsonObject;
        IContent? content = null;
        if (cms?["content"] is JsonValue v && v.TryGetValue<string>(out var id) && ContentReference.TryParse(id, out var link))
            _loader.TryGet(link, out content);
        // No stamp with a content id: the page the note was made on.
        if (content is null && note.Url is { Length: > 0 } url && Uri.TryCreate(url, UriKind.Absolute, out _))
            content = _urls.Route(new EPiServer.UrlBuilder(url), ContextMode.Default);
        if (content is null) return;

        cms ??= new JsonObject();
        cms["content"] = content.ContentLink.ToReferenceWithoutVersion().ToString();
        cms["name"] = content.Name;
        if (_types.Load(content.ContentTypeID)?.Name is { } type) cms["type"] = type;
        if ((content as ILocale)?.Language?.Name is { Length: > 0 } lang) cms["lang"] = lang;
        cms["edit"] = string.Format(System.Globalization.CultureInfo.InvariantCulture, _options.EditUrlFormat, cms["content"]!.GetValue<string>());
        // Keep the order the overlay sent (content, property) and add the rest after.
        if (target is not null) { if (cms.Parent is null) target["cms"] = cms; }
        else if (cms.Parent is null) note.Data["cms"] = cms;   // whole-page note: the page it is about
    }
}
