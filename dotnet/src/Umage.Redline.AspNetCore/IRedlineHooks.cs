using Microsoft.AspNetCore.Http;
using Umage.Redline.Editing;
using Umage.Redline.Notes;

namespace Umage.Redline;

/// <summary>
/// Hooks (D19), registered in DI: <c>services.AddSingleton&lt;IRedlineHooks, MyHooks&gt;()</c>; all
/// registered hooks run. Errors are logged, never shown to the reviewer — except in
/// <see cref="OnCreatingAsync"/>, which runs before the note is stored and may change it
/// (.NET only: how the Optimizely integration adds CMS content to a note).
/// </summary>
public interface IRedlineHooks
{
    Task OnCreatingAsync(Note note, HttpContext http) => Task.CompletedTask;
    Task OnCreateAsync(Note note) => Task.CompletedTask;
    Task OnUpdateAsync(Note note, NotePatch patch) => Task.CompletedTask;
    Task OnRemoveAsync(string id) => Task.CompletedTask;
    Task OnSourceWriteAsync(EditRequest edit, EditResult result) => Task.CompletedTask;
}
