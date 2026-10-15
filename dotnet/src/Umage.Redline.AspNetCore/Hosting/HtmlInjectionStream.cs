// Adds the overlay's <script> to text/html responses as they stream (D31). Unlike the Node
// injector (which buffers the whole page and inserts before </body>), this inserts before the
// first </head> and passes everything else through, so Blazor's streaming rendering and
// enhanced navigation keep flushing as they write. Only a possible partial "</head" at the end
// of a write is held back until the next write.

using System.Text;
using Microsoft.AspNetCore.Http;

namespace Umage.Redline.Hosting;

internal sealed class HtmlInjectionStream : Stream
{
    static readonly byte[] Needle = Encoding.ASCII.GetBytes("</head>");
    static readonly byte[] BodyNeedle = Encoding.ASCII.GetBytes("</body>");
    static readonly byte[] Mark = Encoding.ASCII.GetBytes(RedlineMiddleware.Mark);

    readonly Stream _inner;
    readonly HttpResponse _response;
    readonly byte[] _tag;
    bool? _html;
    bool _done;
    byte[] _held = Array.Empty<byte>();

    public HtmlInjectionStream(Stream inner, HttpResponse response, string tag)
    {
        _inner = inner;
        _response = response;
        _tag = Encoding.UTF8.GetBytes(tag);
    }

    /// <summary>True once the tag is in the response (or the response isn't HTML).</summary>
    public bool Finished => _done || _html == false;

    /// <summary>Will this response get the tag? (Headers are fixed up in the middleware's OnStarting.)</summary>
    public static bool Injects(HttpResponse r) =>
        (r.ContentType ?? "").Contains("text/html", StringComparison.OrdinalIgnoreCase)
        // Blazor's streaming rendering sends "Content-Encoding: identity" (to keep compression off): still plain text (L31).
        && (r.Headers.ContentEncoding.Count == 0 || r.Headers.ContentEncoding.All(e => string.Equals(e, "identity", StringComparison.OrdinalIgnoreCase)));

    bool IsHtml() => _html ??= Injects(_response);

    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        if (_done || !IsHtml()) { await _inner.WriteAsync(buffer, ct); return; }
        var data = _held.Length == 0 ? buffer : Concat(_held, buffer.Span);
        _held = Array.Empty<byte>();
        var span = data.Span;
        var at = IndexOf(span, Needle);
        if (at < 0 && IndexOf(span, BodyNeedle) is var b && b >= 0) at = b;   // no <head> written
        if (at >= 0)
        {
            _done = true;
            if (IndexOf(span.Slice(0, at), Mark) >= 0) { await _inner.WriteAsync(data, ct); return; }
            await _inner.WriteAsync(data.Slice(0, at), ct);
            await _inner.WriteAsync(_tag, ct);
            await _inner.WriteAsync(data.Slice(at), ct);
            return;
        }
        var keep = PartialSuffix(span);
        await _inner.WriteAsync(data.Slice(0, data.Length - keep), ct);
        _held = data.Slice(data.Length - keep).ToArray();
    }

    /// <summary>The response ended without &lt;/head&gt; or &lt;/body&gt;: put the tag at the end (as the Node injector does).</summary>
    public async Task CompleteAsync(CancellationToken ct = default)
    {
        if (_held.Length > 0) { await _inner.WriteAsync(_held, ct); _held = Array.Empty<byte>(); }
        if (!_done && _html == true) { _done = true; await _inner.WriteAsync(_tag, ct); }
    }

    static ReadOnlyMemory<byte> Concat(byte[] a, ReadOnlySpan<byte> b)
    {
        var r = new byte[a.Length + b.Length];
        a.CopyTo(r, 0);
        b.CopyTo(r.AsSpan(a.Length));
        return r;
    }

    static int IndexOf(ReadOnlySpan<byte> hay, byte[] needle)
    {
        for (var i = 0; i <= hay.Length - needle.Length; i++)
        {
            var ok = true;
            for (var j = 0; j < needle.Length && ok; j++) ok = Lower(hay[i + j]) == needle[j];
            if (ok) return i;
        }
        return -1;
    }

    static byte Lower(byte b) => b is >= (byte)'A' and <= (byte)'Z' ? (byte)(b + 32) : b;

    /// <summary>How many trailing bytes could start "&lt;/head&gt;" or "&lt;/body&gt;".</summary>
    static int PartialSuffix(ReadOnlySpan<byte> s)
    {
        for (var n = Math.Min(Needle.Length - 1, s.Length); n > 0; n--)
        {
            var tail = s.Slice(s.Length - n);
            if (StartsWith(Needle, tail) || StartsWith(BodyNeedle, tail)) return n;
        }
        return 0;
    }

    static bool StartsWith(byte[] needle, ReadOnlySpan<byte> tail)
    {
        for (var i = 0; i < tail.Length; i++) if (Lower(tail[i]) != needle[i]) return false;
        return true;
    }

    public override void Write(byte[] buffer, int offset, int count) => WriteAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) => WriteAsync(buffer.AsMemory(offset, count), ct).AsTask();
    public override Task FlushAsync(CancellationToken ct) => _inner.FlushAsync(ct);
    public override void Flush() => _inner.Flush();
    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
}
