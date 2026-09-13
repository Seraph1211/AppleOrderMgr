using Microsoft.Data.Sqlite;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AosCollector.Core;

public sealed class QueueStore : IDisposable
{
  private readonly SqliteConnection connection;
  private readonly IProtector protector;
  private readonly object sync = new();
  private readonly byte[] fingerprintKey;
  public QueueStore(string path, IProtector protector)
  {
    this.protector = protector;
    connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path }.ToString()); connection.Open();
    Execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, payload BLOB NOT NULL, business_date TEXT, state TEXT NOT NULL, receipt BLOB, attempts INTEGER NOT NULL DEFAULT 0, next_attempt TEXT, error_code TEXT); CREATE TABLE IF NOT EXISTS state (name TEXT PRIMARY KEY, payload BLOB NOT NULL); CREATE TABLE IF NOT EXISTS scan_events (scan_id TEXT, event_id TEXT, PRIMARY KEY(scan_id,event_id));");
    Execute("CREATE TABLE IF NOT EXISTS payment_events (event_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, payload BLOB NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error_code TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt TEXT);");
    // 明确的兼容性队列迁移：旧采集器不读取本表，既有事件载荷保持不变。
    var paymentColumns = new HashSet<string>();
    using (var info = Command("PRAGMA table_info(payment_events)")) { using var rows = info.ExecuteReader(); while (rows.Read()) paymentColumns.Add(rows.GetString(1)); }
    if (!paymentColumns.Contains("attempts")) Execute("ALTER TABLE payment_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    if (!paymentColumns.Contains("next_attempt")) Execute("ALTER TABLE payment_events ADD COLUMN next_attempt TEXT");
    fingerprintKey = GetState<byte[]>("fingerprintKey") ?? RandomNumberGenerator.GetBytes(32);
    SetState("fingerprintKey", fingerprintKey);
  }
  private SqliteCommand Command(string sql, params (string Name, object? Value)[] args)
  {
    var cmd = connection.CreateCommand(); cmd.CommandText = sql;
    foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
    return cmd;
  }
  private void Execute(string sql, params (string, object?)[] args) { using var cmd = Command(sql, args); cmd.ExecuteNonQuery(); }
  private byte[] Encode<T>(T value) => protector.Protect(JsonSerializer.SerializeToUtf8Bytes(value, Protocol.Json));
  private T Decode<T>(byte[] value) => JsonSerializer.Deserialize<T>(protector.Unprotect(value), Protocol.Json)!;
  public T? GetState<T>(string name) { lock (sync) { using var cmd = Command("SELECT payload FROM state WHERE name=$name", ("$name", name)); return cmd.ExecuteScalar() is byte[] bytes ? Decode<T>(bytes) : default; } }
  public void SetState<T>(string name, T value) { lock (sync) Execute("INSERT INTO state(name,payload) VALUES($name,$payload) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload", ("$name", name), ("$payload", Encode(value))); }
  public bool Enqueue(UploadEvent item, string? businessDate)
  {
    lock (sync) {
      var hash = Convert.ToHexString(HMACSHA256.HashData(fingerprintKey, Encoding.UTF8.GetBytes(item.RawLine)));
      using var transaction = connection.BeginTransaction();
      using var insert = Command("INSERT OR IGNORE INTO events(event_id,fingerprint,payload,business_date,state) VALUES($id,$hash,$payload,$date,'pending')", ("$id", item.EventId), ("$hash", hash), ("$payload", Encode(item)), ("$date", businessDate)); insert.Transaction = transaction;
      var added = insert.ExecuteNonQuery() == 1;
      if (item.ScanRequestId != null) {
        using var associate = Command("INSERT OR IGNORE INTO scan_events(scan_id,event_id) SELECT $scan,event_id FROM events WHERE fingerprint=$hash", ("$scan", item.ScanRequestId), ("$hash", hash)); associate.Transaction = transaction; associate.ExecuteNonQuery();
      }
      transaction.Commit(); return added;
    }
  }
  public List<UploadEvent> Pending(int limit = 100)
  {
    lock (sync) {
      using var cmd = Command("SELECT payload FROM events WHERE state='pending' AND (next_attempt IS NULL OR next_attempt <= $now) ORDER BY rowid LIMIT $limit", ("$now", Protocol.Now()), ("$limit", limit));
      using var reader = cmd.ExecuteReader(); var result = new List<UploadEvent>();
      while (reader.Read()) result.Add(Decode<UploadEvent>((byte[])reader[0])); return result;
    }
  }
  public void Apply(Receipt receipt)
  {
    lock (sync) {
      if (receipt.ReceiptStatus is "accepted" or "already_received") Execute("UPDATE events SET state='receipted',receipt=$receipt,error_code=NULL WHERE event_id=$id", ("$receipt", Encode(receipt)), ("$id", receipt.EventId));
      else if (receipt.ReceiptStatus == "rejected") {
        if (receipt.Retryable) Retry(receipt.EventId, receipt.ErrorCode ?? "TEMPORARILY_UNAVAILABLE");
        else Execute("UPDATE events SET state='error',error_code=$code WHERE event_id=$id", ("$code", receipt.ErrorCode ?? "VALIDATION_ERROR"), ("$id", receipt.EventId));
      }
    }
  }
  public void Retry(string eventId, string code, int? afterSeconds = null)
  {
    lock (sync) {
      using var cmd = Command("SELECT attempts FROM events WHERE event_id=$id", ("$id", eventId)); var attempts = Convert.ToInt32(cmd.ExecuteScalar() ?? 0);
      var delay = afterSeconds ?? Math.Min(60, 1 << Math.Min(attempts, 6));
      Execute("UPDATE events SET attempts=attempts+1,next_attempt=$next,error_code=$code WHERE event_id=$id AND state='pending'", ("$next", DateTimeOffset.UtcNow.AddSeconds(delay + Random.Shared.NextDouble()).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")), ("$code", code), ("$id", eventId));
    }
  }
  public LocalCounts Counts()
  {
    lock (sync) {
      using var cmd = Command("SELECT COALESCE(SUM(state='pending'),0),COALESCE(SUM(state='error'),0),COALESCE(SUM(business_date=$date),0) FROM events", ("$date", Protocol.BusinessDate())); using var r = cmd.ExecuteReader(); r.Read(); return new(r.GetInt32(0), r.GetInt32(1), r.GetInt32(2));
    }
  }
  public List<string> ScanReceipts(string scanId)
  {
    lock (sync) {
      using var cmd = Command("SELECT e.event_id FROM scan_events s JOIN events e ON e.event_id=s.event_id WHERE s.scan_id=$scan AND e.state='receipted'", ("$scan", scanId));
      using var r = cmd.ExecuteReader(); var result = new List<string>(); while (r.Read()) result.Add(r.GetString(0)); return result;
    }
  }
  public ScanResult ScanCounts(string scanId, bool scanned, string? error = null)
  {
    lock (sync) {
      using var cmd = Command("SELECT COUNT(*), COALESCE(SUM(e.state='receipted'),0) FROM scan_events s JOIN events e ON e.event_id=s.event_id WHERE s.scan_id=$scan", ("$scan", scanId)); using var r = cmd.ExecuteReader(); r.Read();
      var total = r.GetInt32(0); var received = r.GetInt32(1);
      return new(scanId, error != null ? "failed" : scanned && total == received ? "completed" : "running", total, received, total - received, error);
    }
  }
  public bool HasEvents() { lock (sync) { using var cmd = Command("SELECT EXISTS(SELECT 1 FROM events UNION ALL SELECT 1 FROM payment_events)"); return Convert.ToInt32(cmd.ExecuteScalar()) == 1; } }
  public void RetryPending() { lock (sync) Execute("UPDATE events SET next_attempt=NULL WHERE state='pending'"); }
  public (int Pending, int Errors) CodeCounts()
  {
    lock (sync) {
      using var cmd = Command("SELECT COALESCE(SUM(state='pending'),0),COALESCE(SUM(state='error'),0) FROM payment_events");
      using var r = cmd.ExecuteReader(); r.Read(); return (r.GetInt32(0),r.GetInt32(1));
    }
  }
  public bool EnqueueCode(PaymentCodeEvent item)
  {
    lock (sync) {
      var stable = JsonSerializer.Serialize(item with { EventId = "" }, Protocol.Json);
      var hash = Convert.ToHexString(HMACSHA256.HashData(fingerprintKey, Encoding.UTF8.GetBytes(stable)));
      using var cmd = Command("INSERT OR IGNORE INTO payment_events(event_id,fingerprint,payload) VALUES($id,$hash,$payload)", ("$id", item.EventId), ("$hash", hash), ("$payload", Encode(item)));
      return cmd.ExecuteNonQuery() == 1;
    }
  }
  public List<PaymentCodeEvent> PendingCodes()
  {
    lock (sync) {
      using var cmd = Command("SELECT payload FROM payment_events WHERE state='pending' AND (next_attempt IS NULL OR next_attempt <= $now) ORDER BY attempts,rowid LIMIT 4", ("$now", Protocol.Now()));
      using var r = cmd.ExecuteReader(); var result = new List<PaymentCodeEvent>();
      while (r.Read()) result.Add(Decode<PaymentCodeEvent>((byte[])r[0])); return result;
    }
  }
  public void ApplyCode(Receipt receipt)
  {
    lock (sync) {
      if (receipt.ReceiptStatus is "accepted" or "already_received") Execute("UPDATE payment_events SET state='receipted',error_code=NULL WHERE event_id=$id", ("$id", receipt.EventId));
      else Execute("UPDATE payment_events SET state=$state,error_code=$error,attempts=attempts+1,next_attempt=$next WHERE event_id=$id AND state='pending'", ("$id", receipt.EventId), ("$state", receipt.Retryable ? "pending" : "error"), ("$error", receipt.ErrorCode), ("$next", DateTimeOffset.UtcNow.AddSeconds(60).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")));
    }
  }
  public void Dispose() { connection.Dispose(); }
}
