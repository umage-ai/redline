using EPiServer;
using EPiServer.Core;
using EPiServer.DataAbstraction;
using EPiServer.DataAccess;
using EPiServer.Framework;
using EPiServer.Framework.Initialization;
using EPiServer.Security;
using EPiServer.ServiceLocation;
using EPiServer.Web;

namespace OptimizelySample;

/// <summary>Creates the start page, a teaser block and the site definition on an empty database.</summary>
[InitializableModule]
[ModuleDependency(typeof(EPiServer.Web.InitializationModule))]
public class SampleContent : IInitializableModule
{
    public void Initialize(InitializationEngine context)
    {
        var sites = context.Locate.Advanced.GetInstance<ISiteDefinitionRepository>();
        var repo = context.Locate.Advanced.GetInstance<IContentRepository>();
        if (!sites.List().Any()) CreateSite(sites, repo);

        // Editors may edit everything (the sample's /dev/login user has these roles).
        var security = context.Locate.Advanced.GetInstance<IContentSecurityRepository>();
        var acl = (IContentSecurityDescriptor)security.Get(ContentReference.RootPage).CreateWritableClone();
        if (!acl.Entries.Any(e => e.Name == "WebEditors"))
        {
            acl.AddEntry(new AccessControlEntry("WebEditors", AccessLevel.Read | AccessLevel.Create | AccessLevel.Edit | AccessLevel.Delete | AccessLevel.Publish, SecurityEntityType.Role));
            acl.AddEntry(new AccessControlEntry("WebAdmins", AccessLevel.FullAccess, SecurityEntityType.Role));
            security.Save(ContentReference.RootPage, acl, SecuritySaveType.Replace);
        }
    }

    static void CreateSite(ISiteDefinitionRepository sites, IContentRepository repo)
    {

        var block = repo.GetDefault<TeaserBlock>(ContentReference.GlobalBlockFolder);
        block.Heading = "A teaser from a shared block";
        var blockContent = (IContent)block;
        blockContent.Name = "Teaser";
        var blockLink = repo.Save(blockContent, SaveAction.Publish, AccessLevel.NoAccess);

        var start = repo.GetDefault<StartPage>(ContentReference.RootPage);
        start.Name = "Start";
        start.Heading = "Welcome to the Redline sample";
        start.Teaser = "Pin a note on any text here.";
        start.MainBody = new XhtmlString("<p>Rich text from the CMS.</p>");
        start.MainContentArea = new ContentArea();
        start.MainContentArea.Items.Add(new ContentAreaItem { ContentLink = blockLink });
        var startLink = repo.Save(start, SaveAction.Publish, AccessLevel.NoAccess);

        sites.Save(new SiteDefinition
        {
            Name = "Redline sample",
            StartPage = startLink.ToReferenceWithoutVersion(),
            SiteUrl = new Uri("http://localhost:5212/"),
            Hosts = new List<HostDefinition> { new() { Name = HostDefinition.WildcardHostName } },
        });
    }

    public void Uninitialize(InitializationEngine context) { }
}
