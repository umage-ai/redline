// A database store for online mode (D34): notes, their screenshots/sketches and personal MCP
// tokens in four tables, over plain ADO.NET so it works with whatever provider the site has
// (Microsoft.Data.SqlClient for SQL Server, Microsoft.Data.Sqlite). Tables are created on first
// use. A note row keeps the same JSON the markdown anchor holds, so nothing is lost moving notes
// between stores; a version counter bumped by every write is the overlay's ETag.

using System.Data;
using System.Data.Common;
using System.Text.Json.Nodes;
using Umage.Redline.Security;

namespace Umage.Redline.Notes;

public enum SqlDialect { SqlServer, Sqlite }

public sealed class SqlNoteStore : INoteStore, ITokenStore
{
    readonly Func<DbConnection> _connect;
    readonly SqlDialect _dialect;
    readonly string _notes, _assets, _tokens, _state;
    readonly SemaphoreSlim _schemaLock = new(1, 1);
    volatile bool _ready;

    /// <param name="connect">Opens a new connection (pooled by the provider).</param>
    /// <param name="dialect">SQL Server or SQLite DDL.</param>
    /// <param name="prefix">Table name prefix: &lt;prefix&gt;Notes, Assets, Tokens, State. Letters, digits and _ only.</param>
    public SqlNoteStore(Func<DbConnection> connect, SqlDialect dialect = SqlDialect.SqlServer, string prefix = "Redline")
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(prefix, "^[A-Za-z_][A-Za-z0-9_]{0,40}$")) throw new ArgumentException("invalid table prefix", nameof(prefix));
        _connect = connect;
        _dialect = dialect;
        _notes = prefix + "Notes"; _assets = prefix + "Assets"; _tokens = prefix + "Tokens"; _state = prefix + "State";
    }

    public string Dir => "database";

    string[] Schema() => _dialect == SqlDialect.SqlServer
        ? new[]
        {
            $"IF OBJECT_ID(N'{_notes}', N'U') IS NULL CREATE TABLE {_notes} (Seq bigint IDENTITY(1,1) NOT NULL, Id varchar(24) NOT NULL PRIMARY KEY, Page nvarchar(450) NOT NULL, App nvarchar(200) NULL, Done bit NOT NULL, Data nvarchar(max) NOT NULL, Body nvarchar(max) NOT NULL, Reply nvarchar(max) NOT NULL, Author nvarchar(256) NULL, CreatedUtc datetime2 NOT NULL, UpdatedUtc datetime2 NOT NULL)",
            $"IF OBJECT_ID(N'{_assets}', N'U') IS NULL CREATE TABLE {_assets} (Name varchar(40) NOT NULL PRIMARY KEY, NoteId varchar(24) NOT NULL, ContentType varchar(40) NOT NULL, Data varbinary(max) NOT NULL)",
            $"IF OBJECT_ID(N'{_tokens}', N'U') IS NULL CREATE TABLE {_tokens} (Id varchar(24) NOT NULL PRIMARY KEY, UserName nvarchar(256) NOT NULL, Name nvarchar(200) NULL, Hash char(64) NOT NULL UNIQUE, CreatedUtc datetime2 NOT NULL, LastUsedUtc datetime2 NULL)",
            $"IF OBJECT_ID(N'{_state}', N'U') IS NULL CREATE TABLE {_state} (Name varchar(40) NOT NULL PRIMARY KEY, Value bigint NOT NULL)",
            $"IF NOT EXISTS (SELECT 1 FROM {_state} WHERE Name = 'version') INSERT INTO {_state} (Name, Value) VALUES ('version', 0)",
        }
        : new[]
        {
            $"CREATE TABLE IF NOT EXISTS {_notes} (Seq INTEGER PRIMARY KEY AUTOINCREMENT, Id TEXT NOT NULL UNIQUE, Page TEXT NOT NULL, App TEXT NULL, Done INTEGER NOT NULL, Data TEXT NOT NULL, Body TEXT NOT NULL, Reply TEXT NOT NULL, Author TEXT NULL, CreatedUtc TEXT NOT NULL, UpdatedUtc TEXT NOT NULL)",
            $"CREATE TABLE IF NOT EXISTS {_assets} (Name TEXT NOT NULL PRIMARY KEY, NoteId TEXT NOT NULL, ContentType TEXT NOT NULL, Data BLOB NOT NULL)",
            $"CREATE TABLE IF NOT EXISTS {_tokens} (Id TEXT NOT NULL PRIMARY KEY, UserName TEXT NOT NULL, Name TEXT NULL, Hash TEXT NOT NULL UNIQUE, CreatedUtc TEXT NOT NULL, LastUsedUtc TEXT NULL)",
            $"CREATE TABLE IF NOT EXISTS {_state} (Name TEXT NOT NULL PRIMARY KEY, Value INTEGER NOT NULL)",
            $"INSERT OR IGNORE INTO {_state} (Name, Value) VALUES ('version', 0)",
        };

    async Task<DbConnection> Open(CancellationToken ct)
    {
        var c = _connect();
        await c.OpenAsync(ct);
        if (_ready) return c;
        await _schemaLock.WaitAsync(ct);
        try
        {
            if (!_ready)
            {
                foreach (var sql in Schema()) await Exec(c, null, sql, ct);
                _ready = true;
            }
        }
        finally { _schemaLock.Release(); }
        return c;
    }

    static DbCommand Cmd(DbConnection c, DbTransaction? tx, string sql, params (string Name, object? Value)[] ps)
    {
        var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.Transaction = tx;
        foreach (var (name, value) in ps)
        {
            var p = cmd.CreateParameter();
            p.ParameterName = name;
            p.Value = value ?? DBNull.Value;
            if (value is byte[]) p.DbType = DbType.Binary;
            cmd.Parameters.Add(p);
        }
        return cmd;
    }

    static async Task<int> Exec(DbConnection c, DbTransaction? tx, string sql, CancellationToken ct, params (string, object?)[] ps)
    {
        await using var cmd = Cmd(c, tx, sql, ps);
        return await cmd.ExecuteNonQueryAsync(ct);
    }

    Task Bump(DbConnection c, DbTransaction tx, CancellationToken ct) => Exec(c, tx, $"UPDATE {_state} SET Value = Value + 1 WHERE Name = 'version'", ct);

    public async Task<string> VersionAsync(CancellationToken ct = default)
    {
        await using var c = await Open(ct);
        await using var cmd = Cmd(c, null, $"SELECT Value FROM {_state} WHERE Name = 'version'");
        return "v" + Convert.ToInt64(await cmd.ExecuteScalarAsync(ct) ?? 0L);
    }

    static Note Read(DbDataReader r)
    {
        var data = NoteFormat.ParseJson(r.GetString(1)) as JsonObject ?? new JsonObject();
        return new Note(data, r.GetString(2), r.GetString(3), Convert.ToBoolean(r.GetValue(4)));
    }

    const string Columns = "Id, Data, Body, Reply, Done";

    public async Task<IReadOnlyList<Note>> ListAsync(CancellationToken ct = default)
    {
        await using var c = await Open(ct);
        await using var cmd = Cmd(c, null, $"SELECT {Columns} FROM {_notes} ORDER BY Seq");
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<Note>();
        while (await r.ReadAsync(ct)) list.Add(Read(r));
        return list;
    }

    async Task<Note?> Get(DbConnection c, DbTransaction? tx, string id, CancellationToken ct)
    {
        await using var cmd = Cmd(c, tx, $"SELECT {Columns} FROM {_notes} WHERE Id = @id", ("@id", id));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? Read(r) : null;
    }

    public async Task<Note> CreateAsync(NewNoteRequest req, CancellationToken ct = default)
    {
        var note = NoteIds.FromRequest(req);
        var id = note.Id!;
        var png = NoteIds.Png(req.Screenshot);
        var svg = NoteIds.IsSvg(req.Sketch) ? System.Text.Encoding.UTF8.GetBytes(req.Sketch!) : null;
        // Same relative paths as the markdown store, so a note reads the same everywhere; the API serves them by name.
        if (png is not null) note.Screenshot = $"../assets/{id}.png";
        if (svg is not null) note.Sketch = $"../assets/{id}.svg";
        await using var c = await Open(ct);
        await using var tx = await c.BeginTransactionAsync(ct);
        if (await Get(c, tx, id, ct) is not null) { note.Id = id = NoteIds.New(); if (png is not null) note.Screenshot = $"../assets/{id}.png"; if (svg is not null) note.Sketch = $"../assets/{id}.svg"; }
        var now = DateTime.UtcNow;
        await Exec(c, tx, $"INSERT INTO {_notes} (Id, Page, App, Done, Data, Body, Reply, Author, CreatedUtc, UpdatedUtc) VALUES (@id, @page, @app, @done, @data, @body, @reply, @author, @now, @now)", ct,
            ("@id", id), ("@page", note.Page ?? "/"), ("@app", note.App), ("@done", false), ("@data", Js.Stringify(note.Data)), ("@body", note.Body), ("@reply", ""), ("@author", note.Author), ("@now", now));
        if (png is not null) await Exec(c, tx, $"INSERT INTO {_assets} (Name, NoteId, ContentType, Data) VALUES (@n, @id, 'image/png', @d)", ct, ("@n", $"{id}.png"), ("@id", id), ("@d", png));
        if (svg is not null) await Exec(c, tx, $"INSERT INTO {_assets} (Name, NoteId, ContentType, Data) VALUES (@n, @id, 'image/svg+xml', @d)", ct, ("@n", $"{id}.svg"), ("@id", id), ("@d", svg));
        await Bump(c, tx, ct);
        await tx.CommitAsync(ct);
        return note;
    }

    public async Task<Note?> UpdateAsync(string id, NotePatch patch, CancellationToken ct = default)
    {
        await using var c = await Open(ct);
        await using var tx = await c.BeginTransactionAsync(ct);
        var n = await Get(c, tx, id, ct);
        if (n is null) return null;
        patch.ApplyTo(n);
        await Exec(c, tx, $"UPDATE {_notes} SET Done = @done, Data = @data, Body = @body, Reply = @reply, UpdatedUtc = @now WHERE Id = @id", ct,
            ("@done", n.Done), ("@data", Js.Stringify(n.Data)), ("@body", n.Body), ("@reply", n.Reply), ("@now", DateTime.UtcNow), ("@id", id));
        await Bump(c, tx, ct);
        await tx.CommitAsync(ct);
        return n;
    }

    public async Task<bool> RemoveAsync(string id, CancellationToken ct = default)
    {
        await using var c = await Open(ct);
        await using var tx = await c.BeginTransactionAsync(ct);
        var gone = await Exec(c, tx, $"DELETE FROM {_notes} WHERE Id = @id", ct, ("@id", id)) > 0;
        if (gone)
        {
            await Exec(c, tx, $"DELETE FROM {_assets} WHERE NoteId = @id", ct, ("@id", id));
            await Bump(c, tx, ct);
        }
        await tx.CommitAsync(ct);
        return gone;
    }

    public async Task<NoteAsset?> AssetAsync(string name, CancellationToken ct = default)
    {
        if (!NoteIds.ValidAssetName(name)) return null;
        await using var c = await Open(ct);
        await using var cmd = Cmd(c, null, $"SELECT ContentType, Data FROM {_assets} WHERE Name = @n", ("@n", name));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? new NoteAsset(r.GetString(0), (byte[])r.GetValue(1)) : null;
    }

    /* ---------- personal MCP tokens ---------- */

    public async Task<string> AddTokenAsync(string user, string? name, string hash, CancellationToken ct = default)
    {
        var id = NoteIds.New();
        await using var c = await Open(ct);
        await Exec(c, null, $"INSERT INTO {_tokens} (Id, UserName, Name, Hash, CreatedUtc) VALUES (@id, @u, @name, @h, @now)", ct,
            ("@id", id), ("@u", user), ("@name", name), ("@h", hash), ("@now", DateTime.UtcNow));
        return id;
    }

    public async Task<string?> UserForTokenAsync(string hash, CancellationToken ct = default)
    {
        await using var c = await Open(ct);
        string? user;
        await using (var cmd = Cmd(c, null, $"SELECT UserName FROM {_tokens} WHERE Hash = @h", ("@h", hash)))
            user = await cmd.ExecuteScalarAsync(ct) as string;
        if (user is not null) await Exec(c, null, $"UPDATE {_tokens} SET LastUsedUtc = @now WHERE Hash = @h", ct, ("@now", DateTime.UtcNow), ("@h", hash));
        return user;
    }

    public async Task<IReadOnlyList<TokenInfo>> TokensAsync(string user, CancellationToken ct = default)
    {
        await using var c = await Open(ct);
        await using var cmd = Cmd(c, null, $"SELECT Id, UserName, Name, CreatedUtc, LastUsedUtc FROM {_tokens} WHERE UserName = @u ORDER BY CreatedUtc", ("@u", user));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<TokenInfo>();
        while (await r.ReadAsync(ct))
            list.Add(new TokenInfo(r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), Convert.ToDateTime(r.GetValue(3)), r.IsDBNull(4) ? null : Convert.ToDateTime(r.GetValue(4))));
        return list;
    }

    public async Task<bool> RevokeTokenAsync(string user, string id, CancellationToken ct = default)
    {
        await using var c = await Open(ct);
        return await Exec(c, null, $"DELETE FROM {_tokens} WHERE Id = @id AND UserName = @u", ct, ("@id", id), ("@u", user)) > 0;
    }
}
