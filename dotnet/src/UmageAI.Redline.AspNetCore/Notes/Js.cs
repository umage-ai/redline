// JavaScript semantics the markdown format depends on, so the .NET port writes the same bytes
// as src/server/format.ts: JSON.stringify (escaping, number formatting, key order),
// String.prototype.trim and the JS `\s` class. Guarded by the shared golden fixtures (test/golden).

using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.Json;

namespace UmageAI.Redline.Notes;

public static class Js
{
    /// <summary>The characters JavaScript's <c>\s</c> and <c>trim()</c> treat as whitespace.</summary>
    public const string WhitespaceClass = @"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]";

    public static bool IsWhitespace(char c) => c switch
    {
        '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00a0' or '\u1680' or '\u2028' or '\u2029' or '\u202f' or '\u205f' or '\u3000' or '\ufeff' => true,
        >= '\u2000' and <= '\u200a' => true,
        _ => false,
    };

    public static string Trim(string s)
    {
        int a = 0, b = s.Length;
        while (a < b && IsWhitespace(s[a])) a++;
        while (b > a && IsWhitespace(s[b - 1])) b--;
        return s.Substring(a, b - a);
    }

    public static string TrimEnd(string s)
    {
        int b = s.Length;
        while (b > 0 && IsWhitespace(s[b - 1])) b--;
        return s.Substring(0, b);
    }

    public static string TrimStart(string s)
    {
        int a = 0;
        while (a < s.Length && IsWhitespace(s[a])) a++;
        return s.Substring(a);
    }

    /// <summary>JSON.stringify(value) with no indentation.</summary>
    public static string Stringify(JsonNode? node)
    {
        var sb = new StringBuilder();
        Write(sb, node);
        return sb.ToString();
    }

    static void Write(StringBuilder sb, JsonNode? node)
    {
        switch (node)
        {
            case null: sb.Append("null"); return;
            case JsonObject o:
                sb.Append('{');
                var first = true;
                foreach (var kv in o)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Quote(sb, kv.Key);
                    sb.Append(':');
                    Write(sb, kv.Value);
                }
                sb.Append('}');
                return;
            case JsonArray a:
                sb.Append('[');
                for (var i = 0; i < a.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    Write(sb, a[i]);
                }
                sb.Append(']');
                return;
            case JsonValue v:
                switch (v.GetValueKind())
                {
                    case JsonValueKind.String: Quote(sb, v.GetValue<string>()); return;
                    case JsonValueKind.True: sb.Append("true"); return;
                    case JsonValueKind.False: sb.Append("false"); return;
                    case JsonValueKind.Number: sb.Append(Number(ToDouble(v))); return;
                    default: sb.Append("null"); return;
                }
        }
    }

    public static double ToDouble(JsonValue v) =>
        v.TryGetValue<double>(out var d) ? d : double.Parse(v.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture);

    /// <summary>QuoteJSONString from ECMA-262: only quotes, backslashes, control characters and lone surrogates are escaped.</summary>
    public static void Quote(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); continue;
                case '\\': sb.Append("\\\\"); continue;
                case '\b': sb.Append("\\b"); continue;
                case '\f': sb.Append("\\f"); continue;
                case '\n': sb.Append("\\n"); continue;
                case '\r': sb.Append("\\r"); continue;
                case '\t': sb.Append("\\t"); continue;
            }
            if (c < 0x20) { sb.Append("\\u").Append(((int)c).ToString("x4")); continue; }
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { sb.Append(c).Append(s[i + 1]); i++; continue; }
                sb.Append("\\u").Append(((int)c).ToString("x4")); continue;
            }
            if (char.IsLowSurrogate(c)) { sb.Append("\\u").Append(((int)c).ToString("x4")); continue; }
            sb.Append(c);
        }
        sb.Append('"');
    }

    /// <summary>Number::toString from ECMA-262 (what JSON.stringify and template literals print).</summary>
    public static string Number(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
        if (d == 0) return "0";
        if (d < 0) return "-" + Number(-d);
        // The fewest digits that round-trip; among those, the closest to the value. A correctly
        // rounded "E" format at increasing precision gives exactly that ("R" may pick another
        // equally short string, e.g. 12345678901234567890 → ...568E+19 where JS prints ...567000).
        string mantissa = "";
        int e = 0;
        for (var p = 1; p <= 17; p++)
        {
            var s = d.ToString("E" + (p - 1), CultureInfo.InvariantCulture);
            if (p < 17 && double.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture) != d) continue;
            var ei = s.IndexOf('E');
            mantissa = s.Substring(0, ei).Replace(".", "");
            e = int.Parse(s.Substring(ei + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            break;
        }
        var digits = mantissa.TrimEnd('0');
        // n: where the decimal point goes (value = 0.digits × 10^n)
        var n = e + 1;
        var k = digits.Length;
        if (k <= n && n <= 21) return digits + new string('0', n - k);
        if (0 < n && n <= 21) return digits.Substring(0, n) + "." + digits.Substring(n);
        if (-6 < n && n <= 0) return "0." + new string('0', -n) + digits;
        var exp = n - 1;
        var sign = exp < 0 ? "-" : "+";
        var mant = k == 1 ? digits : digits.Substring(0, 1) + "." + digits.Substring(1);
        return mant + "e" + sign + Math.Abs(exp).ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>JavaScript truthiness of a JSON value (undefined/null/false/0/"" are falsy).</summary>
    public static bool Truthy(JsonNode? node) => node switch
    {
        null => false,
        JsonValue v => v.GetValueKind() switch
        {
            JsonValueKind.String => v.GetValue<string>().Length > 0,
            JsonValueKind.True => true,
            JsonValueKind.Number => ToDouble(v) is var d && d != 0 && !double.IsNaN(d),
            _ => false,
        },
        _ => true,
    };

    /// <summary>A value as a template literal would print it.</summary>
    public static string Str(JsonNode? node) => node switch
    {
        null => "null",
        JsonValue v => v.GetValueKind() switch
        {
            JsonValueKind.String => v.GetValue<string>(),
            JsonValueKind.Number => Number(ToDouble(v)),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "null",
        },
        JsonArray a => string.Join(",", a.Select(x => x is null ? "" : Str(x))),
        _ => "[object Object]",
    };

    /// <summary>Number.prototype.toString(36) for an unsigned value.</summary>
    public static string Base36(ulong v)
    {
        const string alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
        if (v == 0) return "0";
        var sb = new StringBuilder();
        while (v > 0) { sb.Insert(0, alphabet[(int)(v % 36)]); v /= 36; }
        return sb.ToString();
    }
}
