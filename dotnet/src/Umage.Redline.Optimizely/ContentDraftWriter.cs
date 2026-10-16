// Text mode on CMS text (D33): save the new text as a draft of the content property, never
// publish. Runs under the reviewer's own CMS permissions (AccessLevel.Edit on the content), in
// dev and online. Plain string properties only; rich text (XhtmlString), content areas and
// other types are refused, and the overlay saves a text note instead.

using EPiServer;
using EPiServer.Core;
using EPiServer.DataAccess;
using EPiServer.Data.Entity;
using EPiServer.Security;
using EPiServer.SpecializedProperties;
using Umage.Redline.Editing;

namespace Umage.Redline.Optimizely;

public sealed class ContentDraftWriter : ISourceWriter
{
    readonly IContentRepository _repo;
    readonly IContentVersionRepository _versions;

    public ContentDraftWriter(IContentRepository repo, IContentVersionRepository versions)
    {
        _repo = repo;
        _versions = versions;
    }

    public string Name => "optimizely";
    public bool WritesFiles => false;

    public Task<EditResult?> ApplyAsync(EditRequest req, WriterContext ctx, CancellationToken ct = default)
    {
        var id = req.Cms?["content"]?.GetValue<string>();
        var property = req.Cms?["property"]?.GetValue<string>();
        if (string.IsNullOrEmpty(property) || string.IsNullOrEmpty(id) || !ContentReference.TryParse(id, out var link)) return Task.FromResult<EditResult?>(null);
        return Task.FromResult<EditResult?>(Apply(req, ctx, link.ToReferenceWithoutVersion(), property));
    }

    EditResult Apply(EditRequest req, WriterContext ctx, ContentReference link, string property)
    {
        if (!_repo.TryGet<IContent>(link, out var published)) return EditResult.Fail($"CMS content {link} not found", Name);
        var lang = (published as ILocale)?.Language?.Name;
        // Edit the shared draft when there is one, so earlier unpublished edits are kept.
        var draft = _versions.LoadCommonDraft(link, lang);
        var current = draft is not null && _repo.TryGet<IContent>(draft.ContentLink, out var d) ? d : published;
        var label = $"CMS “{current.Name}” › {property}";

        var prop = (current as IContentData)?.Property[property];
        if (prop is null) return EditResult.Fail($"{label}: no such property", Name);
        if (prop is PropertyXhtmlString || prop.PropertyValueType != typeof(string))
            return EditResult.Fail($"{label} is {prop.GetType().Name}; only plain text properties can be edited in place", Name);
        if (req.Html is not null) return EditResult.Fail($"{label} is plain text; markup can't be added", Name);
        if (SourceEdit.Norm(prop.Value as string ?? "") != SourceEdit.Norm(req.From))
            return EditResult.Fail($"{label} differs from the page (changed since, or a draft is pending)", Name);

        var user = ctx.HttpContext?.User;
        if (user?.Identity?.IsAuthenticated != true) return EditResult.Fail("sign in to Optimizely to save CMS drafts", Name);
        if (current is ISecurable securable && !securable.GetSecurityDescriptor().HasAccess(user, AccessLevel.Edit))
            return EditResult.Fail($"you can't edit {label}", Name);
        if (ctx.Inspect || ctx.DryRun) return new EditResult { Ok = true, File = label + " (draft)", Writer = Name };

        var clone = (IContent)((IReadOnly)current).CreateWritableClone();
        ((IContentData)clone).Property[property].Value = req.To;
        // A draft only: never published from here. AccessLevel.Edit makes the CMS check the reviewer too.
        var saved = _repo.Save(clone, SaveAction.Default, AccessLevel.Edit);
        return new EditResult { Ok = true, File = $"{label} (draft {saved.WorkID})", Writer = Name };
    }
}
