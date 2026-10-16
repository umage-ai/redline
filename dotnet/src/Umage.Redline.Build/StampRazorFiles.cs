// MSBuild task: writes stamped copies of .cshtml/.razor files (RazorStamper) to an obj folder
// and returns them as items carrying the originals' metadata (TargetPath, CssScope, …), so the
// Razor source generator compiles the copies under the same names (D32).

using System;
using System.IO;
using System.Text;
using Microsoft.Build.Framework;
using Microsoft.Build.Utilities;

namespace Umage.Redline.Build
{
    public sealed class StampRazorFiles : Task
    {
        [Required] public ITaskItem[] Files { get; set; } = Array.Empty<ITaskItem>();
        [Required] public string OutputDirectory { get; set; } = "";
        [Required] public string ProjectDirectory { get; set; } = "";

        [Output] public ITaskItem[] Stamped { get; set; } = Array.Empty<ITaskItem>();

        public override bool Execute()
        {
            var root = RepoRoot(ProjectDirectory);
            var outDir = Path.GetFullPath(OutputDirectory);
            var projectDir = Path.GetFullPath(ProjectDirectory);
            var result = new ITaskItem[Files.Length];
            var count = 0;
            for (var i = 0; i < Files.Length; i++)
            {
                var item = Files[i];
                var full = item.GetMetadata("FullPath");
                result[i] = item;
                try
                {
                    var src = File.ReadAllText(full);
                    // The stamp holds the repo-relative path (as notes do), so files from other projects
                    // (a Blazor .Client project) resolve too.
                    var stamped = RazorStamper.Stamp(src, Relative(root, full));
                    if (stamped == null) continue;
                    var rel = Relative(projectDir, full);
                    if (rel.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(rel))
                        rel = Path.Combine("_linked", Hash(full), Path.GetFileName(full));
                    var target = Path.Combine(outDir, rel);
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    // Rewrite only on change, so an unchanged file doesn't look newer to incremental builds.
                    if (!File.Exists(target) || File.ReadAllText(target) != stamped)
                        File.WriteAllText(target, stamped, new UTF8Encoding(src.Length > 0 && src[0] == '\ufeff'));
                    var copy = new TaskItem(target);
                    item.CopyMetadataTo(copy);
                    copy.SetMetadata("RedlineOriginal", full);
                    result[i] = copy;
                    count++;
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                    Log.LogMessage(MessageImportance.Low, $"Redline: left {full} unstamped: {ex.Message}");
                }
            }
            Stamped = result;
            Log.LogMessage(MessageImportance.Low, $"Redline: stamped {count} of {Files.Length} Razor files into {outDir}");
            return true;
        }

        static string RepoRoot(string start)
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

        static string Relative(string from, string to)
        {
            var a = new Uri(AppendSlash(Path.GetFullPath(from)));
            var b = new Uri(Path.GetFullPath(to));
            return Uri.UnescapeDataString(a.MakeRelativeUri(b).ToString()).Replace('\\', '/');
        }

        static string AppendSlash(string p) => p.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal) ? p : p + Path.DirectorySeparatorChar;

        static string Hash(string s)
        {
            unchecked
            {
                var h = 17;
                foreach (var c in s) h = h * 31 + c;
                return ((uint)h).ToString("x8");
            }
        }
    }
}
