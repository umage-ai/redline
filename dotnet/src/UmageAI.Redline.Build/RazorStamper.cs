// Stamps data-redline-src="path:line:col" on the HTML elements of a .cshtml/.razor file, the
// Razor counterpart of src/server/jsx-source.ts. Razor keeps no source positions for markup at
// runtime, so a Debug build compiles stamped copies instead of the originals (D32).
//
// The scanner is deliberately conservative: it follows Razor's transitions (@{ }, @code { },
// @if (…) { }, @( ), implicit expressions, directives, comments, C# strings) only far enough to
// know which `<tag` is markup. Only lowercase tags from an HTML allowlist get the attribute,
// and it is inserted on the same line, so line numbers in errors and PDBs don't move. If the
// file looks unbalanced at the end, it is left unstamped.

using System;
using System.Collections.Generic;
using System.Text;

namespace UmageAI.Redline.Build
{
    public static class RazorStamper
    {
        public const string Attr = "data-redline-src";

        // Same allowlist as the JSX stamp: lowercase tags that are HTML elements. Not head-only
        // elements (title, meta, link, script, style) and not Razor's <text>, tag helpers or components.
        static readonly HashSet<string> HtmlTags = new HashSet<string>((
            "a abbr address article aside b bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del " +
            "details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i iframe img input ins " +
            "kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q s samp section select small " +
            "span strong sub summary sup svg table tbody td textarea tfoot th thead time tr u ul var").Split(' '), StringComparer.Ordinal);

        static readonly HashSet<string> VoidTags = new HashSet<string>(
            "area base br col embed hr img input link meta source track wbr".Split(' '), StringComparer.OrdinalIgnoreCase);

        static readonly HashSet<string> BlockKeywords = new HashSet<string>(
            "if for foreach while switch lock using try do".Split(' '), StringComparer.Ordinal);

        static readonly HashSet<string> CodeDirectives = new HashSet<string>(new[] { "code", "functions" }, StringComparer.Ordinal);

        static readonly HashSet<string> LineDirectives = new HashSet<string>((
            "page model inject inherits implements layout namespace attribute rendermode preservewhitespace typeparam " +
            "addTagHelper removeTagHelper tagHelperPrefix using").Split(' '), StringComparer.Ordinal);

        /// <summary>The stamped source, or null when nothing was stamped or the file couldn't be followed.</summary>
        public static string? Stamp(string src, string path)
        {
            var s = new Scanner(src, path);
            try
            {
                s.Markup(0, false, out var end);
                if (end < src.Length) return null;
            }
            catch (StampException) { return null; }
            catch (IndexOutOfRangeException) { return null; }
            catch (ArgumentOutOfRangeException) { return null; }
            return s.Inserts.Count == 0 ? null : s.Apply();
        }

        sealed class StampException : Exception { public StampException(string m) : base(m) { } }

        sealed class Scanner
        {
            readonly string _s;
            readonly string _value;
            public readonly List<KeyValuePair<int, string>> Inserts = new List<KeyValuePair<int, string>>();
            readonly int[] _lineStarts;

            public Scanner(string src, string path)
            {
                _s = src;
                // An attribute value: HTML-escaped, and @ doubled so Razor reads it as text.
                _value = path.Replace("\\", "/").Replace("&", "&amp;").Replace("\"", "&quot;").Replace("@", "@@");
                var starts = new List<int> { 0 };
                for (var i = 0; i < src.Length; i++) if (src[i] == '\n') starts.Add(i + 1);
                _lineStarts = starts.ToArray();
            }

            public string Apply()
            {
                var sb = new StringBuilder(_s.Length + Inserts.Count * 40);
                var at = 0;
                foreach (var kv in Inserts)
                {
                    sb.Append(_s, at, kv.Key - at).Append(kv.Value);
                    at = kv.Key;
                }
                sb.Append(_s, at, _s.Length - at);
                return sb.ToString();
            }

            char C(int i) => i < _s.Length ? _s[i] : '\0';
            bool At(int i, string t) => string.CompareOrdinal(_s, i, t, 0, t.Length) == 0;
            static bool IdentStart(char c) => char.IsLetter(c) || c == '_';
            static bool IdentPart(char c) => char.IsLetterOrDigit(c) || c == '_';

            (int line, int col) Pos(int i)
            {
                var lo = Array.BinarySearch(_lineStarts, i);
                if (lo < 0) lo = ~lo - 1;
                return (lo + 1, i - _lineStarts[lo] + 1);
            }

            int SkipWs(int i) { while (i < _s.Length && char.IsWhiteSpace(_s[i])) i++; return i; }

            int ReadIdent(int i) { while (i < _s.Length && IdentPart(_s[i])) i++; return i; }

            int IndexOrThrow(string t, int from)
            {
                var j = _s.IndexOf(t, from, StringComparison.Ordinal);
                if (j < 0) throw new StampException("unterminated " + t);
                return j;
            }

            /* ---------- markup ---------- */

            /// <summary>
            /// Markup from i. Returns when the input ends, or, with <paramref name="untilBrace"/>,
            /// at a `}` outside any element (the end of @section { } or a markup block in code).
            /// </summary>
            public void Markup(int i, bool untilBrace, out int end)
            {
                var open = new List<string>();
                while (i < _s.Length)
                {
                    var c = _s[i];
                    if (c == '@') { i = Transition(i, true); continue; }
                    if (c == '}' && untilBrace && open.Count == 0) { end = i; return; }
                    if (c == '<') { i = Tag(i, open); continue; }
                    i++;
                }
                end = i;
            }

            /// <summary>One markup element from `&lt;tag` (inside C#), through its end tag.</summary>
            int Element(int i)
            {
                var open = new List<string>();
                i = Tag(i, open);
                while (open.Count > 0)
                {
                    if (i >= _s.Length) throw new StampException("unclosed element in code");
                    var c = _s[i];
                    if (c == '@') { i = Transition(i, true); continue; }
                    if (c == '<') { i = Tag(i, open); continue; }
                    i++;
                }
                return i;
            }

            /// <summary>A tag at `&lt;`: comment, end tag, or start tag (stamped when allowed). Tracks open elements.</summary>
            int Tag(int i, List<string> open)
            {
                if (At(i, "<!--")) return IndexOrThrow("-->", i + 4) + 3;
                if (C(i + 1) == '/')
                {
                    var n0 = i + 2;
                    var n1 = TagNameEnd(n0);
                    var name = _s.Substring(n0, n1 - n0);
                    var close = _s.IndexOf('>', n1);
                    if (close < 0) throw new StampException("unterminated end tag");
                    var k = open.FindLastIndex(x => string.Equals(x, name, StringComparison.OrdinalIgnoreCase));
                    if (k >= 0) open.RemoveRange(k, open.Count - k);
                    return close + 1;
                }
                if (!IdentStart(C(i + 1))) return i + 1;   // "<" in text, "<!DOCTYPE", tag helper opt-out "<!p>"
                var start = i + 1;
                var nameEnd = TagNameEnd(start);
                var tag = _s.Substring(start, nameEnd - start);
                var j = nameEnd;
                var selfClose = false;
                // attributes, until the closing >
                while (true)
                {
                    if (j >= _s.Length) throw new StampException("unterminated start tag");
                    var c = _s[j];
                    if (c == '>') { selfClose = _s[j - 1] == '/'; j++; break; }
                    if (c == '"' || c == '\'') { j = AttrValue(j); continue; }
                    if (c == '@') { j = Transition(j, false); continue; }
                    j++;
                }
                var stampable = HtmlTags.Contains(tag) && (C(nameEnd) == '>' || C(nameEnd) == '/' || char.IsWhiteSpace(C(nameEnd)))
                    && _s.IndexOf(Attr, nameEnd, j - nameEnd, StringComparison.Ordinal) < 0;
                if (stampable)
                {
                    var (line, col) = Pos(i);
                    Inserts.Add(new KeyValuePair<int, string>(nameEnd, $" {Attr}=\"{_value}:{line}:{col}\""));
                }
                if (selfClose || VoidTags.Contains(tag)) return j;
                var lower = tag.ToLowerInvariant();
                if (lower == "script" || lower == "style")
                {
                    var endTag = _s.IndexOf("</" + lower, j, StringComparison.OrdinalIgnoreCase);
                    if (endTag < 0) throw new StampException("unterminated " + lower);
                    var close = _s.IndexOf('>', endTag);
                    if (close < 0) throw new StampException("unterminated " + lower);
                    return close + 1;
                }
                open.Add(tag);
                return j;
            }

            int TagNameEnd(int i)
            {
                while (i < _s.Length && (IdentPart(_s[i]) || _s[i] == '-' || _s[i] == ':' || _s[i] == '.')) i++;
                return i;
            }

            /// <summary>A quoted attribute value; Razor expressions inside may hold quotes of their own.</summary>
            int AttrValue(int i)
            {
                var q = _s[i++];
                while (true)
                {
                    if (i >= _s.Length) throw new StampException("unterminated attribute");
                    var c = _s[i];
                    if (c == q) return i + 1;
                    if (c == '@') { i = Transition(i, false); continue; }
                    i++;
                }
            }

            /* ---------- @ transitions ---------- */

            /// <summary>At '@': skip the Razor construct (statement blocks only where <paramref name="statements"/>).</summary>
            int Transition(int i, bool statements)
            {
                var n = C(i + 1);
                if (n == '@') return i + 2;                                   // @@ escape
                if (n == '*') return IndexOrThrow("*@", i + 2) + 2;           // @* comment *@
                if (n == '(') return Balanced(i + 1, '(', ')');
                if (n == '{') return CodeBlock(i + 2);
                if (n == ':' && !statements) return i + 1;
                if (i > 0 && IdentPart(_s[i - 1])) return i + 1;              // e-mail address
                if (!IdentStart(n)) return i + 1;
                var wEnd = ReadIdent(i + 1);
                var word = _s.Substring(i + 1, wEnd - i - 1);
                if (statements)
                {
                    if (CodeDirectives.Contains(word))
                    {
                        var b = SkipWs(wEnd);
                        if (C(b) == '{') return CodeBlock(b + 1);
                    }
                    if (word == "section")
                    {
                        var b = SkipWs(wEnd);
                        b = ReadIdent(b);
                        b = SkipWs(b);
                        if (C(b) != '{') throw new StampException("section without block");
                        Markup(b + 1, true, out var close);
                        if (C(close) != '}') throw new StampException("unterminated section");
                        return close + 1;
                    }
                    if (BlockKeywords.Contains(word) && !(word == "using" && C(SkipWs(wEnd)) != '('))
                        return Statement(word, wEnd);
                    if (LineDirectives.Contains(word))
                    {
                        var eol = _s.IndexOf('\n', wEnd);
                        return eol < 0 ? _s.Length : eol + 1;
                    }
                }
                if (word == "await")
                {
                    var a = SkipWs(wEnd);
                    if (IdentStart(C(a))) return Implicit(ReadIdent(a));
                }
                return Implicit(wEnd);
            }

            /// <summary>An implicit expression after its first identifier: .member, (args), [index], ?. chains.</summary>
            int Implicit(int i)
            {
                while (i < _s.Length)
                {
                    var c = _s[i];
                    if (c == '(') { i = Balanced(i, '(', ')'); continue; }
                    if (c == '[') { i = Balanced(i, '[', ']'); continue; }
                    if ((c == '.' || c == '!' && C(i + 1) == '.') && IdentStart(C(c == '.' ? i + 1 : i + 2))) { i = ReadIdent(c == '.' ? i + 1 : i + 2); continue; }
                    if (c == '?' && (C(i + 1) == '.' && IdentStart(C(i + 2)) || C(i + 1) == '[')) { i += 1; continue; }
                    if (c == '<' && Generic(i, out var g)) { i = g; continue; }
                    break;
                }
                return i;
            }

            /// <summary>`Method&lt;T&gt;(` in an implicit expression.</summary>
            bool Generic(int i, out int end)
            {
                end = i;
                var j = i + 1;
                var depth = 1;
                while (j < _s.Length && depth > 0)
                {
                    var c = _s[j];
                    if (c == '<') depth++;
                    else if (c == '>') depth--;
                    else if (!(IdentPart(c) || c == '.' || c == ',' || c == ' ' || c == '?' || c == '[' || c == ']')) return false;
                    j++;
                }
                if (depth != 0 || C(j) != '(') return false;
                end = j;
                return true;
            }

            /// <summary>@if/@for/@foreach/@while/@switch/@lock/@using/@try/@do with their blocks and else/catch/finally/while tails.</summary>
            int Statement(string word, int i)
            {
                while (true)
                {
                    i = SkipWs(i);
                    if (C(i) == '(') { i = Balanced(i, '(', ')'); i = SkipWs(i); }
                    if (C(i) != '{') throw new StampException("@" + word + " without a block");
                    i = CodeBlock(i + 1);
                    var k = SkipWs(i);
                    var next = ReadIdent(k);
                    var tail = _s.Substring(k, next - k);
                    if (tail == "else" || tail == "catch" || tail == "finally") { i = next; if (tail == "else") { var k2 = SkipWs(i); var n2 = ReadIdent(k2); if (_s.Substring(k2, n2 - k2) == "if") i = n2; } continue; }
                    if (word == "do" && tail == "while") { i = Balanced(SkipWs(next), '(', ')'); var semi = SkipWs(i); return C(semi) == ';' ? semi + 1 : i; }
                    return i;
                }
            }

            /* ---------- C# ---------- */

            /// <summary>C# from just after `{` to just after its matching `}`; markup statements inside are followed.</summary>
            int CodeBlock(int i)
            {
                var depth = 1;
                var parens = 0;
                var statementStart = true;
                while (true)
                {
                    if (i >= _s.Length) throw new StampException("unterminated code block");
                    var c = _s[i];
                    if (char.IsWhiteSpace(c)) { i++; continue; }
                    if (c == '/' && C(i + 1) == '/') { var eol = _s.IndexOf('\n', i); i = eol < 0 ? _s.Length : eol + 1; continue; }
                    if (c == '/' && C(i + 1) == '*') { i = IndexOrThrow("*/", i + 2) + 2; continue; }
                    if (c == '@' && C(i + 1) == '*') { i = IndexOrThrow("*@", i + 2) + 2; continue; }
                    if (c == '@' && C(i + 1) == ':') { var eol = _s.IndexOf('\n', i); i = eol < 0 ? _s.Length : eol + 1; statementStart = true; continue; }
                    if (c == '@' && C(i + 1) == '<') { i = Element(i + 1); statementStart = false; continue; }   // Razor template @<p>…</p>
                    if (c == '"' || (c == '@' || c == '$') && (C(i + 1) == '"' || (C(i + 1) == '$' || C(i + 1) == '@') && C(i + 2) == '"'))
                    { i = CString(i); statementStart = false; continue; }
                    if (c == '\'') { i = CChar(i); statementStart = false; continue; }
                    if (c == '<' && statementStart && parens == 0 && (IdentStart(C(i + 1)) || C(i + 1) == '!'))
                    {
                        if (C(i + 1) == '!') { i = Tag(i, new List<string>()); continue; }
                        i = Element(i);
                        statementStart = true;   // markup is a statement of its own
                        continue;
                    }
                    if (c == '{') { depth++; statementStart = true; i++; continue; }
                    if (c == '}') { if (--depth == 0) return i + 1; statementStart = true; i++; continue; }
                    if (c == '(') parens++;
                    else if (c == ')') parens = Math.Max(0, parens - 1);
                    statementStart = c == ';' || (c == ':' && LastWordIsLabel(i));
                    i++;
                }
            }

            /// <summary>`case x:` / `default:` before markup in a switch.</summary>
            bool LastWordIsLabel(int colon)
            {
                var lineStart = _s.LastIndexOf('\n', colon) + 1;
                var line = _s.Substring(lineStart, colon - lineStart).TrimStart();
                return line.StartsWith("case ", StringComparison.Ordinal) || line == "default";
            }

            /// <summary>Balanced (…) or […] with C# strings and chars inside; returns after the closer.</summary>
            int Balanced(int i, char open, char close)
            {
                var depth = 0;
                while (true)
                {
                    if (i >= _s.Length) throw new StampException("unbalanced " + open);
                    var c = _s[i];
                    if (c == '"' || (c == '@' || c == '$') && (C(i + 1) == '"' || (C(i + 1) == '$' || C(i + 1) == '@') && C(i + 2) == '"'))
                    { i = CString(i); continue; }
                    if (c == '\'') { i = CChar(i); continue; }
                    if (c == open) depth++;
                    else if (c == close && --depth == 0) return i + 1;
                    i++;
                }
            }

            /// <summary>A C# string: "…", @"…", $"…{…}…", $@"…", raw """…""".</summary>
            int CString(int i)
            {
                var verbatim = false; var interp = false;
                while (_s[i] == '@' || _s[i] == '$') { if (_s[i] == '@') verbatim = true; else interp = true; i++; }
                if (At(i, "\"\"\""))
                {
                    var n = 0; while (C(i + n) == '"') n++;
                    var closer = new string('"', n);
                    return IndexOrThrow(closer, i + n) + n;
                }
                i++; // opening quote
                while (true)
                {
                    if (i >= _s.Length) throw new StampException("unterminated string");
                    var c = _s[i];
                    if (!verbatim && c == '\\') { i += 2; continue; }
                    if (!verbatim && c == '\n') throw new StampException("newline in string");
                    if (c == '"')
                    {
                        if (verbatim && C(i + 1) == '"') { i += 2; continue; }
                        return i + 1;
                    }
                    if (interp && c == '{')
                    {
                        if (C(i + 1) == '{') { i += 2; continue; }
                        i = Balanced(i, '{', '}');
                        continue;
                    }
                    i++;
                }
            }

            /// <summary>A char literal ('x', '\n', 'A'); an apostrophe that isn't one is skipped.</summary>
            int CChar(int i)
            {
                for (var j = i + 1; j < Math.Min(_s.Length, i + 10); j++)
                {
                    if (_s[j] == '\\') { j++; continue; }
                    if (_s[j] == '\'') return j + 1;
                    if (_s[j] == '\n') break;
                }
                return i + 1;
            }
        }
    }
}
