// Running dev servers, so `redline mcp` (the Node CLI) can reach this one (D22):
// <root>/<dir>/servers.json, the same file and shape src/server/registry.ts writes.
// Registered when the server starts listening and on the first /__redline request per host.
// Dead entries are pruned by pid; the MCP server still checks each URL before using it.

using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Umage.Redline.Hosting;

public static class ServerRegistry
{
    static readonly SemaphoreSlim Lock = new(1, 1);

    static string FileOf(string root, string dir) => Path.Combine(root, dir, "servers.json");

    static bool Alive(int pid)
    {
        try { using var p = Process.GetProcessById(pid); return !p.HasExited; }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return true; }   // exists, not ours to inspect
    }

    public static List<JsonObject> Read(string root, string dir = ".redline")
    {
        try
        {
            if (JsonNode.Parse(File.ReadAllText(FileOf(root, dir))) is not JsonArray list) return new();
            return list.OfType<JsonObject>()
                .Where(s => s["url"] is JsonValue u && u.TryGetValue<string>(out _) && s["pid"] is JsonValue p && p.TryGetValue<double>(out var pid) && Alive((int)pid))
                .Select(s => (JsonObject)s.DeepClone()).ToList();
        }
        catch (Exception) { return new(); }
    }

    /// <summary>Add or refresh this process's entry for <paramref name="url"/>. Never throws: discovery is best effort.</summary>
    public static async Task RegisterAsync(string root, string dir, string url, string app)
    {
        await Lock.WaitAsync();
        try
        {
            url = url.TrimEnd('/');
            var list = Read(root, dir).Where(s => (string?)s["url"] != url).ToList();
            list.Add(new JsonObject { ["url"] = url, ["app"] = app, ["pid"] = Environment.ProcessId, ["at"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") });
            Directory.CreateDirectory(Path.Combine(root, dir));
            var json = new JsonArray(list.Cast<JsonNode>().ToArray()).ToJsonString(new JsonSerializerOptions { WriteIndented = true });
            await File.WriteAllTextAsync(FileOf(root, dir), json.Replace("\r\n", "\n") + "\n");
        }
        catch (Exception) { /* read-only checkout etc. */ }
        finally { Lock.Release(); }
    }
}
