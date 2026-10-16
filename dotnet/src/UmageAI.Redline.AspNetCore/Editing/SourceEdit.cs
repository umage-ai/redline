// Text edits written straight into markup source (D20), a port of src/server/edit.ts plus a
// Razor dialect. Pure string functions: an edit only lands when the element's content in source
// is static (text, plus inline markup with static attributes) and its text equals what the
// reviewer saw. In Razor (.cshtml/.razor) anything with `@` (expressions, code, directive
// attributes), tag helpers (asp-*) and components is refused; `@@` is literal text.

using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using UmageAI.Redline.Notes;

namespace UmageAI.Redline.Editing;

/// <summary>How the file's markup marks expressions.</summary>
public enum MarkupSyntax
{
    /// <summary>Plain HTML: no expressions.</summary>
    Html,
    /// <summary>`{…}` starts an expression (JSX, Svelte, Astro, Vue).</summary>
    Braces,
    /// <summary>`@` starts Razor code (.cshtml, .razor); `@@` is a literal @.</summary>
    Razor,
}

/// <summary>Which of several same-tag, same-text elements was edited: its position among them on the page (0-based) and how many the page has (D25).</summary>
public sealed record Nth(int Index, int Count);

public sealed record TextRange(int Start, int InnerStart, int InnerEnd);

/// <summary>Source content split into text and tags (kept byte for byte in <see cref="Raw"/>).</summary>
public sealed class Token
{
    public required string K { get; init; }      // text | open | close | void
    public required string Raw { get; init; }
    public string? Text { get; init; }
    public string? Tag { get; init; }
    public int Close { get; set; } = -1;
}

public abstract record Outcome(bool Ok, string? Reason);
public sealed record Tokens(bool Ok, List<Token>? List, string? Reason) : Outcome(Ok, Reason);
public sealed record Analysis(bool Ok, List<Token>? Tokens, bool Rich, string? Reason) : Outcome(Ok, Reason);
public sealed record Located(bool Ok, TextRange? Range, Analysis? Analysis, int Line, string? Reason) : Outcome(Ok, Reason);
public sealed record Planned(bool Ok, string? Content, int Line, string? Reason) : Outcome(Ok, Reason);

public static class SourceEdit
{
    static readonly Regex Ws = new($"{Js.WhitespaceClass}+", RegexOptions.CultureInvariant);

    public static readonly HashSet<string> Inline = new(("a abbr b bdi bdo br cite code data del dfn em i ins kbd mark q s samp small span strong " +
        "sub sup time u var wbr").Split(' '));
    static readonly HashSet<string> Void = new() { "br", "wbr" };
    // Vue / Angular attributes that decide whether an inline element shows, or what it holds.
    static readonly Regex Directive = new(@"\s(v-(if|else|else-if|show|for|html|text)|\*[a-zA-Z]+|\[(innerHTML|innerText|textContent|hidden)\]|\[style\.display\])(?=[\s=/>])", RegexOptions.CultureInvariant);
    static readonly Regex Addable = new(@"^<\/?(b|i|u|s|em|strong)>$|^<br\s*\/?>$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    // A tag with static attributes only: an attribute value can't hold `{`, so expressions are refused.
    static readonly Regex TagRe = new(@"\G<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s<>""'{}=/]+(?:\s*=\s*(?:""[^""{}]*""|'[^'{}]*'|[^\s<>""'{}=`]+))?)*)\s*(\/?)>", RegexOptions.CultureInvariant);

    /* ---------- character references (D24) ---------- */

    static Dictionary<string, string>? _named;
    static string[] _legacy = Array.Empty<string>();

    /// <summary>The full HTML named-reference table (<see cref="Entities"/>), unpacked on first use. Names are case-sensitive.</summary>
    static Dictionary<string, string> NamedRefs()
    {
        if (_named is { } n) return n;
        var table = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var e in Entities.Packed.Split(';'))
        {
            var comma = e.IndexOf(',');
            var sb = new StringBuilder();
            foreach (var h in e.Substring(comma + 1).Split('.')) sb.Append(char.ConvertFromUtf32(int.Parse(h, NumberStyles.HexNumber, CultureInfo.InvariantCulture)));
            table[e.Substring(0, comma)] = sb.ToString();
        }
        _legacy = Entities.Legacy.Split(' ').OrderByDescending(x => x.Length).ToArray();   // longest prefix first
        return _named = table;
    }

    static readonly Regex Ref = new("&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*)(;?))", RegexOptions.CultureInvariant);
    static readonly Regex RefWithSemi = new("&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);", RegexOptions.CultureInvariant);

    /// <summary>A numeric reference's character; 0, surrogates and out-of-range values become U+FFFD, as in a browser.</summary>
    static string CodePoint(string digits, int radix)
    {
        long cp = 0;
        foreach (var c in digits)
        {
            cp = cp * radix + (c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10);
            if (cp > 0x10FFFF) return "�";
        }
        return cp > 0 && (cp < 0xD800 || cp > 0xDFFF) ? char.ConvertFromUtf32((int)cp) : "�";
    }

    /// <summary>Decode character references the way a browser does in text content.</summary>
    public static string DecodeEntities(string s)
    {
        if (!s.Contains('&')) return s;
        var table = NamedRefs();
        return Ref.Replace(s, m =>
        {
            if (m.Groups[1].Success) return CodePoint(m.Groups[1].Value, 16);
            if (m.Groups[2].Success) return CodePoint(m.Groups[2].Value, 10);
            var name = m.Groups[3].Value;
            if (m.Groups[4].Length > 0 && table.TryGetValue(name, out var v)) return v;
            // Without `;` (or unknown with it), a legacy name at the start still decodes: "&copy2026".
            var l = _legacy.FirstOrDefault(x => name.StartsWith(x, StringComparison.Ordinal));
            return l is null ? m.Value : table[l] + m.Value.Substring(1 + l.Length);
        });
    }

    /// <summary>
    /// How the source spelled characters as references, e.g. "—" → "&amp;mdash;". A plain edit writes
    /// the same characters the same way, so a file full of <c>&amp;mdash;</c> stays that way.
    /// </summary>
    public static Dictionary<string, string> Spellings(string raw)
    {
        var o = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Match m in RefWithSemi.Matches(raw))
        {
            var ch = DecodeEntities(m.Value);
            // One code point, not ASCII whitespace: a stray `&#32;` must not turn every space into one.
            var single = ch.Length == 1 ? !char.IsSurrogate(ch[0]) : ch.Length == 2 && char.IsSurrogatePair(ch[0], ch[1]);
            if (ch != m.Value && single && ch is not ("\t" or "\n" or "\f" or "\r" or " ")) o.TryAdd(ch, m.Value);
        }
        return o;
    }

    /// <summary>Whitespace-insensitive form used to compare source text with rendered text.</summary>
    public static string Norm(string s) => Js.Trim(Ws.Replace(s, " "));

    static int LineStart(string src, int line)
    {
        var at = 0;
        for (var i = 1; i < line; i++)
        {
            var nl = src.IndexOf('\n', at);
            if (nl < 0) return -1;
            at = nl + 1;
        }
        return at;
    }

    static Regex StartTagRe(string tag) => new($"<{Regex.Escape(tag)}(?=[\\s/>])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>Start offset of the `&lt;tag` written on <paramref name="line"/> (1-based), nearest to <paramref name="col"/> (1-based).</summary>
    public static int FindStartTag(string src, string tag, int line, int? col)
    {
        var from = LineStart(src, line);
        if (from < 0) return -1;
        var end = src.IndexOf('\n', from);
        var text = end < 0 ? src.Substring(from) : src.Substring(from, end - from);
        int best = -1, dist = int.MaxValue;
        foreach (Match m in StartTagRe(tag).Matches(text))
        {
            var d = col is int c ? Math.Abs(m.Index + 1 - c) : m.Index;
            if (d < dist) { best = from + m.Index; dist = d; }
        }
        return best;
    }

    /// <summary>The element starting at <paramref name="start"/>: where its content begins and ends; null for void/self-closing or unclosed.</summary>
    public static TextRange? ElementAt(string src, int start, string tag)
    {
        int i = start + 1 + tag.Length, depth = 0;
        var quote = '\0';
        for (; i < src.Length; i++)
        {
            var c = src[i];
            if (quote != '\0') { if (c == quote) quote = '\0'; continue; }
            if (c == '"' || c == '\'' || (c == '`' && depth > 0)) quote = c;
            else if (c == '{') depth++;
            else if (c == '}') depth = Math.Max(0, depth - 1);
            else if (c == '>' && depth == 0) break;
        }
        if (i >= src.Length || src[i - 1] == '/') return null;
        var innerStart = i + 1;
        var re = new Regex($"<(/?){Regex.Escape(tag)}(?=[\\s/>])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var open = 1;
        for (var m = re.Match(src, innerStart); m.Success; m = m.NextMatch())
        {
            if (m.Groups[1].Length > 0) { if (--open == 0) return new TextRange(start, innerStart, m.Index); }
            else
            {
                var close = src.IndexOf('>', m.Index);
                if (close > 0 && src[close - 1] != '/') open++;
            }
        }
        return null;
    }

    static Tokens Fail(string reason) => new(false, null, reason);

    public static Tokens Tokenize(string inner, MarkupSyntax syntax)
    {
        var braces = syntax == MarkupSyntax.Braces;
        var razor = syntax == MarkupSyntax.Razor;
        var tokens = new List<Token>();
        var stack = new Stack<int>();
        var i = 0;
        while (i < inner.Length)
        {
            var lt = inner.IndexOf('<', i);
            var textEnd = lt < 0 ? inner.Length : lt;
            if (textEnd > i)
            {
                var raw = inner.Substring(i, textEnd - i);
                if (braces && (raw.Contains('{') || raw.Contains('}'))) return Fail("the text is rendered from an expression ({…}), not written in source");
                if (razor && raw.Replace("@@", "").Contains('@')) return Fail("the text is rendered from Razor code (@…), not written in source");
                tokens.Add(new Token { K = "text", Raw = raw, Text = DecodeEntities(razor ? raw.Replace("@@", "@") : raw) });
            }
            if (lt < 0) break;
            if (string.CompareOrdinal(inner, lt, "<!--", 0, 4) == 0) return Fail("the element holds a comment in source");
            var m = TagRe.Match(inner, lt);
            if (!m.Success)
            {
                var rest = inner.Substring(lt);
                if (braces && Regex.IsMatch(rest, @"^<[^>]*\{")) return Fail("an attribute inside is an expression ({…})");
                if (razor && Regex.IsMatch(rest, @"^<[^>]*@")) return Fail("an attribute inside is Razor code (@…)");
                return Fail("the element holds markup that can't be edited inline");
            }
            var tagRaw = m.Value;
            var slash = m.Groups[1].Value;
            var name = m.Groups[2].Value;
            var self = m.Groups[4].Value;
            if ((braces || razor) && char.IsUpper(name[0])) return Fail($"the element holds a component (<{name}>)");
            if (braces && Directive.IsMatch(tagRaw)) return Fail("inline markup is shown or filled by a directive (v-if, *ngIf, [innerHTML], …)");
            if (razor && tagRaw.Contains('@')) return Fail("an attribute inside is Razor code (@…)");
            if (razor && Regex.IsMatch(tagRaw, @"\sasp-", RegexOptions.IgnoreCase)) return Fail($"the element holds a tag helper (<{name} asp-…>)");
            var tag = name.ToLowerInvariant();
            if (!Inline.Contains(tag)) return Fail($"the element holds a <{tag}>; only inline markup can be edited in place");
            if (slash.Length > 0)
            {
                if (stack.Count == 0 || tokens[stack.Peek()].Tag != tag) return Fail($"unbalanced </{tag}> in source");
                tokens[stack.Pop()].Close = tokens.Count;
                tokens.Add(new Token { K = "close", Raw = tagRaw, Tag = tag });
            }
            else if (self.Length > 0 || Void.Contains(tag)) tokens.Add(new Token { K = "void", Raw = tagRaw, Tag = tag });
            else { stack.Push(tokens.Count); tokens.Add(new Token { K = "open", Raw = tagRaw, Tag = tag }); }
            i = lt + tagRaw.Length;
        }
        if (stack.Count > 0) return Fail($"unclosed <{tokens[stack.Last()].Tag}> in source");
        return new Tokens(true, tokens, null);
    }

    /// <summary>What the page shows for these tokens (innerText-like: tags dropped, &lt;br&gt; as a space).</summary>
    public static string TextOf(IEnumerable<Token> tokens) => string.Concat(tokens.Select(t => t.K == "text" ? t.Text : t.K == "void" && t.Tag == "br" ? " " : ""));

    public static Analysis Analyze(string inner, string from, MarkupSyntax syntax)
    {
        var t = Tokenize(inner, syntax);
        if (!t.Ok) return new Analysis(false, null, false, t.Reason);
        if (Norm(TextOf(t.List!)) != Norm(from)) return new Analysis(false, null, false, "the source text differs from the page (rendered, translated or changed since)");
        return new Analysis(true, t.List, t.List!.Any(x => x.K != "text"), null);
    }

    /// <summary>
    /// Text as source: <c>&amp; &lt; &gt;</c> escaped, plus <c>{ }</c> (braces) or <c>@</c> (Razor), and characters
    /// in <paramref name="spell"/> written the way the source already wrote them.
    /// </summary>
    public static string EncodeText(string s, MarkupSyntax syntax, IReadOnlyDictionary<string, string>? spell = null)
    {
        var sb = new StringBuilder(s.Length);
        for (var i = 0; i < s.Length; i++)
        {
            var ch = char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]) ? s.Substring(i++, 2) : s[i].ToString();
            if (spell is not null && spell.TryGetValue(ch, out var sp)) { sb.Append(sp); continue; }
            sb.Append(ch switch
            {
                "&" => "&amp;", "<" => "&lt;", ">" => "&gt;",
                "{" when syntax == MarkupSyntax.Braces => "&#123;",
                "}" when syntax == MarkupSyntax.Braces => "&#125;",
                "@" when syntax == MarkupSyntax.Razor => "@@",
                _ => ch,
            });
        }
        return sb.ToString();
    }

    /// <summary>
    /// `to` as source text: escaped, the original's surrounding whitespace kept, and characters the
    /// original wrote as references (<c>&amp;mdash;</c>, <c>&amp;#8594;</c>) written the same way again.
    /// </summary>
    public static string EncodeInner(string original, string to, MarkupSyntax syntax)
    {
        var lead = Regex.Match(original, $"^{Js.WhitespaceClass}*").Value;
        var trail = Regex.Match(original, $"{Js.WhitespaceClass}*\\z").Value;
        return lead + EncodeText(to, syntax, Spellings(original)) + (Js.Trim(original).Length > 0 ? trail : "");
    }

    public static Outcome ValidateHtml(string html, List<Token> original, string to, MarkupSyntax syntax)
    {
        var t = Tokenize(html, syntax);
        if (!t.Ok) return new Tokens(false, null, $"the edited markup is invalid: {t.Reason}");
        var known = new HashSet<string>(original.Where(x => x.K != "text").Select(x => x.Raw));
        var odd = t.List!.FirstOrDefault(x => x.K != "text" && !known.Contains(x.Raw) && !Addable.IsMatch(x.Raw));
        if (odd is not null) return new Tokens(false, null, $"the edit adds markup that wasn't there ({odd.Raw})");
        if (Norm(TextOf(t.List!)) != Norm(to)) return new Tokens(false, null, "the edited markup and text disagree");
        return new Tokens(true, null, null);
    }

    static int LineOf(string src, int at)
    {
        var n = 1;
        for (var i = 0; i < at; i++) if (src[i] == '\n') n++;
        return n;
    }

    /// <summary>The element written at line:col, if its content is static and matches <paramref name="from"/>.</summary>
    public static Located LocateAt(string src, string tag, int line, int? col, string from, MarkupSyntax syntax)
    {
        var start = FindStartTag(src, tag, line, col);
        if (start < 0) return new Located(false, null, null, 0, $"no <{tag}> on line {line} of the source file");
        var range = ElementAt(src, start, tag);
        if (range is null) return new Located(false, null, null, 0, $"couldn't find where <{tag}> ends in source");
        var analysis = Analyze(src.Substring(range.InnerStart, range.InnerEnd - range.InnerStart), from, syntax);
        return analysis.Ok ? new Located(true, range, analysis, LineOf(src, start), null) : new Located(false, null, null, 0, analysis.Reason);
    }

    /// <summary>
    /// The `&lt;tag&gt;` in the file whose content matches <paramref name="from"/> (static HTML, no source location).
    /// Several matches: <paramref name="nth"/> picks one, but only when the file has exactly as many as the page
    /// (otherwise one of them is rendered or hidden differently, and the index can't be trusted). D25.
    /// </summary>
    public static Located LocateUnique(string src, string tag, string from, MarkupSyntax syntax = MarkupSyntax.Html, Nth? nth = null)
    {
        var hits = new List<Located>();
        foreach (Match m in StartTagRe(tag).Matches(src))
        {
            var range = ElementAt(src, m.Index, tag);
            if (range is null) continue;
            var analysis = Analyze(src.Substring(range.InnerStart, range.InnerEnd - range.InnerStart), from, syntax);
            if (analysis.Ok) hits.Add(new Located(true, range, analysis, LineOf(src, m.Index), null));
        }
        if (hits.Count == 0) return new Located(false, null, null, 0, $"no <{tag}> with exactly this text in the file (rendered by script?)");
        if (hits.Count == 1) return hits[0];
        if (nth is not null && nth.Count == hits.Count && nth.Index >= 0 && nth.Index < hits.Count) return hits[nth.Index];
        var page = nth is null ? "" : $" (the page shows {nth.Count})";
        return new Located(false, null, null, 0, $"{hits.Count} <{tag}> elements have this text in the file{page}; can't tell which one");
    }

    /// <summary>Replace the located element's content: <paramref name="html"/> from the rich editor, else plain <paramref name="to"/>.</summary>
    public static Planned Apply(string src, Located loc, string to, string? html, MarkupSyntax syntax)
    {
        var range = loc.Range!;
        var inner = src.Substring(range.InnerStart, range.InnerEnd - range.InnerStart);
        string next;
        if (html is not null)
        {
            var v = ValidateHtml(html, loc.Analysis!.Tokens!, to, syntax);
            if (!v.Ok) return new Planned(false, null, 0, v.Reason);
            next = html;
        }
        else
        {
            if (loc.Analysis!.Rich) return new Planned(false, null, 0, "the element holds markup; edit it in place so the markup is kept");
            next = EncodeInner(inner, to, syntax);
        }
        return new Planned(true, src.Substring(0, range.InnerStart) + next + src.Substring(range.InnerEnd), loc.Line, null);
    }

    public static Planned EditAt(string src, string tag, int line, int? col, string from, string to, string? html, MarkupSyntax syntax)
    {
        var loc = LocateAt(src, tag, line, col, from, syntax);
        return loc.Ok ? Apply(src, loc, to, html, syntax) : new Planned(false, null, 0, loc.Reason);
    }

    public static Planned EditUnique(string src, string tag, string from, string to, string? html, MarkupSyntax syntax = MarkupSyntax.Html, Nth? nth = null)
    {
        var loc = LocateUnique(src, tag, from, syntax, nth);
        return loc.Ok ? Apply(src, loc, to, html, syntax) : new Planned(false, null, 0, loc.Reason);
    }
}
