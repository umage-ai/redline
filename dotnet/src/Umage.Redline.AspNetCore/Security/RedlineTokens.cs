// Bearer tokens for the remote MCP endpoint (D35). Tokens are random, shown once, and only
// their SHA-256 is kept: in configuration (site tokens) or in the store (personal tokens,
// created by a signed-in reviewer and acting as that user).

using System.Security.Cryptography;
using System.Text;

namespace Umage.Redline.Security;

public sealed record TokenInfo(string Id, string User, string? Name, DateTime Created, DateTime? LastUsed);

/// <summary>Personal tokens. The SQL store implements it.</summary>
public interface ITokenStore
{
    /// <summary>Store a new token's hash for <paramref name="user"/>; returns its id.</summary>
    Task<string> AddTokenAsync(string user, string? name, string hash, CancellationToken ct = default);
    /// <summary>The token's owner when the hash is known (and records the use), else null.</summary>
    Task<string?> UserForTokenAsync(string hash, CancellationToken ct = default);
    Task<IReadOnlyList<TokenInfo>> TokensAsync(string user, CancellationToken ct = default);
    Task<bool> RevokeTokenAsync(string user, string id, CancellationToken ct = default);
}

public static class RedlineTokens
{
    /// <summary>A new token ("rl_…", 256 random bits) and the hash to configure or store.</summary>
    public static (string Token, string Hash) Create()
    {
        var token = "rl_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return (token, Hash(token));
    }

    /// <summary>Lowercase hex SHA-256 of the token.</summary>
    public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    /// <summary>Constant-time check against configured hashes.</summary>
    public static bool Matches(string token, IEnumerable<string> hashes)
    {
        var h = Encoding.ASCII.GetBytes(Hash(token));
        var ok = false;
        foreach (var x in hashes)
            ok |= CryptographicOperations.FixedTimeEquals(h, Encoding.ASCII.GetBytes(x.Trim().ToLowerInvariant()));
        return ok;
    }
}
