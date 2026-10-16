// The default store, a port of src/server/store.ts: <root>/<dir>/pages/<slug>.md,
// <dir>/assets/<id>.{png,svg}, <dir>/INDEX.md. Every mutation re-reads the page file, applies
// the change and writes it back, so edits an agent made in between are kept. Mutations are
// serialised so two quick saves from the overlay can't interleave.

using System.Security.Cryptography;
using System.Text;

namespace UmageAI.Redline.Notes;

public sealed class MarkdownNoteStore : INoteStore
{
    static readonly UTF8Encoding Utf8 = new(false);
    readonly string _base, _pages, _assets;
    readonly SemaphoreSlim _lock = new(1, 1);

    public MarkdownNoteStore(string root, string dir = ".redline")
    {
        Dir = dir;
        _base = Path.GetFullPath(Path.Combine(root, dir));
        _pages = Path.Combine(_base, "pages");
        _assets = Path.Combine(_base, "assets");
    }

    public string Dir { get; }
    /// <summary>The absolute notes folder.</summary>
    public string BasePath => _base;

    async Task<T> Serial<T>(Func<Task<T>> fn, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try { return await fn(); }
        finally { _lock.Release(); }
    }

    List<string> PageFiles()
    {
        try { return Directory.EnumerateFiles(_pages, "*.md").Select(Path.GetFileName).OfType<string>().OrderBy(f => f, StringComparer.Ordinal).ToList(); }
        catch (IOException) { return new(); }
        catch (UnauthorizedAccessException) { return new(); }
    }

    async Task<List<Note>> ReadFile(string file, CancellationToken ct)
    {
        try { return NoteFormat.ParsePage(await File.ReadAllTextAsync(Path.Combine(_pages, file), Utf8, ct)); }
        catch (IOException) { return new(); }
    }

    async Task WriteFile(string file, List<Note> notes, CancellationToken ct)
    {
        var full = Path.Combine(_pages, file);
        if (notes.Count == 0) { File.Delete(full); return; }
        Directory.CreateDirectory(_pages);
        var first = notes[0];
        await File.WriteAllTextAsync(full, NoteFormat.SerializePage(first.Page ?? "/", first.Url, notes), Utf8, ct);
    }

    async Task WriteIndex(CancellationToken ct)
    {
        var rows = new List<NoteFormat.IndexRow>();
        foreach (var file in PageFiles())
        {
            var notes = await ReadFile(file, ct);
            if (notes.Count == 0) continue;
            rows.Add(new(notes[0].Page ?? "/", notes[0].App, $"pages/{file}", notes.Count(n => !n.Done), notes.Count(n => n.Done)));
        }
        Directory.CreateDirectory(_base);
        await File.WriteAllTextAsync(Path.Combine(_base, "INDEX.md"), NoteFormat.SerializeIndex(rows), Utf8, ct);
    }

    async Task<(string File, List<Note> Notes, int Index)?> Find(string id, CancellationToken ct)
    {
        foreach (var file in PageFiles())
        {
            var notes = await ReadFile(file, ct);
            var i = notes.FindIndex(n => n.Id == id);
            if (i >= 0) return (file, notes, i);
        }
        return null;
    }

    public Task<string> VersionAsync(CancellationToken ct = default)
    {
        using var sha = SHA1.Create();
        var sb = new StringBuilder();
        foreach (var f in PageFiles())
        {
            try { var fi = new FileInfo(Path.Combine(_pages, f)); sb.Append($"{f}:{fi.LastWriteTimeUtc.Ticks}:{fi.Length};"); }
            catch (IOException) { /* raced a delete */ }
        }
        var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()));
        return Task.FromResult(Convert.ToHexString(hash).ToLowerInvariant().Substring(0, 12));
    }

    public async Task<IReadOnlyList<Note>> ListAsync(CancellationToken ct = default)
    {
        var all = new List<Note>();
        foreach (var file in PageFiles())
            foreach (var n in await ReadFile(file, ct)) { n.File = $"{Dir}/pages/{file}"; all.Add(n); }
        return all;
    }

    public Task<Note> CreateAsync(NewNoteRequest req, CancellationToken ct = default) => Serial(async () =>
    {
        var note = NoteIds.FromRequest(req);
        var id = note.Id!;
        if (NoteIds.Png(req.Screenshot) is { } png)
        {
            Directory.CreateDirectory(_assets);
            await File.WriteAllBytesAsync(Path.Combine(_assets, $"{id}.png"), png, ct);
            note.Screenshot = $"../assets/{id}.png";
        }
        if (NoteIds.IsSvg(req.Sketch))
        {
            Directory.CreateDirectory(_assets);
            await File.WriteAllTextAsync(Path.Combine(_assets, $"{id}.svg"), req.Sketch!, Utf8, ct);
            note.Sketch = $"../assets/{id}.svg";
        }
        var file = NoteFormat.PageFile(note.Page ?? "/", note.App);
        var notes = await ReadFile(file, ct);
        notes.Add(note);
        await WriteFile(file, notes, ct);
        await WriteIndex(ct);
        note.File = $"{Dir}/pages/{file}";
        return note;
    }, ct);

    public Task<Note?> UpdateAsync(string id, NotePatch patch, CancellationToken ct = default) => Serial(async () =>
    {
        var hit = await Find(id, ct);
        if (hit is null) return null;
        var (file, notes, i) = hit.Value;
        patch.ApplyTo(notes[i]);
        await WriteFile(file, notes, ct);
        await WriteIndex(ct);
        return (Note?)notes[i];
    }, ct);

    public Task<bool> RemoveAsync(string id, CancellationToken ct = default) => Serial(async () =>
    {
        var hit = await Find(id, ct);
        if (hit is null) return false;
        var (file, notes, i) = hit.Value;
        var n = notes[i];
        notes.RemoveAt(i);
        foreach (var rel in new[] { n.Screenshot, n.Sketch })
        {
            if (string.IsNullOrEmpty(rel)) continue;
            var full = Path.GetFullPath(Path.Combine(_pages, rel));
            if (full.StartsWith(_assets + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) File.Delete(full);
        }
        await WriteFile(file, notes, ct);
        await WriteIndex(ct);
        return true;
    }, ct);

    public async Task<NoteAsset?> AssetAsync(string name, CancellationToken ct = default)
    {
        if (!NoteIds.ValidAssetName(name)) return null;
        try { return new NoteAsset(name.EndsWith(".svg", StringComparison.Ordinal) ? "image/svg+xml" : "image/png", await File.ReadAllBytesAsync(Path.Combine(_assets, name), ct)); }
        catch (IOException) { return null; }
    }
}
