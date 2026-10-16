// Where notes live and which app wrote them (port of src/server/root.ts and normaliseSource).
// In a monorepo the notes stay in one .redline/ at the repo root and each app tags its notes
// with its folder (D17).

namespace Umage.Redline.Hosting;

public static class RedlinePaths
{
    /// <summary>Nearest folder with .git (a folder, or a file for worktrees/submodules); else <paramref name="start"/>.</summary>
    public static string FindRoot(string start)
    {
        var dir = Path.GetFullPath(start);
        while (true)
        {
            if (Directory.Exists(Path.Combine(dir, ".git")) || File.Exists(Path.Combine(dir, ".git"))) return dir;
            var up = Path.GetDirectoryName(dir);
            if (string.IsNullOrEmpty(up) || up == dir) return Path.GetFullPath(start);
            dir = up;
        }
    }

    /// <summary>Canonical path: resolves symlinks/junctions where possible.</summary>
    public static string Real(string p)
    {
        try
        {
            var full = Path.GetFullPath(p);
            var info = new DirectoryInfo(full);
            if (info.Exists && info.LinkTarget is not null) return info.ResolveLinkTarget(true)?.FullName ?? full;
            return full;
        }
        catch (Exception) { return p; }
    }

    /// <summary>The app's folder relative to the notes root ("apps/web"), or "" when it is the root or outside it.</summary>
    public static string AppOf(string root, string serverRoot)
    {
        var rel = Path.GetRelativePath(Real(root), Real(serverRoot)).Replace('\\', '/');
        return rel == "." || rel.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(rel) ? "" : rel;
    }

    /// <summary>Turn whatever path the page reported into a repo-relative, forward-slash path.</summary>
    public static string NormaliseSource(string file, string root, string serverRoot)
    {
        var f = System.Text.RegularExpressions.Regex.Replace(file, "^file://", "");
        f = System.Text.RegularExpressions.Regex.Replace(f, "[?#].*$", "");
        if (System.Text.RegularExpressions.Regex.IsMatch(f, "^/[A-Za-z]:/")) f = f.Substring(1);
        string abs;
        try
        {
            if (Path.IsPathRooted(f) && File.Exists(f)) abs = f;
            else if (File.Exists(Path.Combine(serverRoot, f))) abs = Path.Combine(serverRoot, f);
            else if (File.Exists(Path.Combine(root, f))) abs = Path.Combine(root, f);
            else return f.Replace('\\', '/');
        }
        catch (ArgumentException) { return f.Replace('\\', '/'); }
        return Path.GetRelativePath(Real(root), Path.GetFullPath(abs)).Replace('\\', '/');
    }
}
