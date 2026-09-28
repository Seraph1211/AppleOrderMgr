namespace AosCollector.Core;

public sealed partial class QueueStore
{
  public const long MAX_LOG_QUEUE_BYTES = 128L * 1024 * 1024;
  private void InitializeFullLogs()
  {
    Execute("CREATE TABLE IF NOT EXISTS full_log_events (id TEXT PRIMARY KEY, local_id TEXT NOT NULL, file_id TEXT NOT NULL, byte_offset INTEGER NOT NULL, business_date TEXT NOT NULL, logged_at TEXT, size INTEGER NOT NULL, payload BLOB NOT NULL, UNIQUE(file_id,byte_offset)); CREATE INDEX IF NOT EXISTS full_log_send ON full_log_events(business_date DESC,logged_at DESC); CREATE TABLE IF NOT EXISTS full_log_sources (name TEXT PRIMARY KEY, business_date TEXT NOT NULL);");
  }
  // 游标与上传队列在同一事务推进，避免崩溃后丢失已读内容。
  public void CommitFullLogs(string stateKey, FullLogCursor cursor, List<FullLogEntry> entries, string sourceDate)
  {
    lock (sync) {
      using var transaction = connection.BeginTransaction();
      foreach (var entry in entries) {
        var bytes = Encode(entry);
        using var insert = Command("INSERT OR IGNORE INTO full_log_events(id,local_id,file_id,byte_offset,business_date,logged_at,size,payload) VALUES($id,$local,$file,$offset,$day,$at,$size,$payload)", ("$id", entry.Id), ("$local", entry.LocalId), ("$file", entry.FileId), ("$offset", entry.ByteOffset), ("$day", entry.BusinessDate), ("$at", entry.LoggedAt), ("$size", bytes.Length), ("$payload", bytes));
        insert.Transaction = transaction; insert.ExecuteNonQuery();
      }
      using var state = Command("INSERT INTO state(name,payload) VALUES($key,$payload) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload", ("$key", stateKey), ("$payload", Encode(cursor)));
      state.Transaction = transaction; state.ExecuteNonQuery();
      using var source = Command("INSERT INTO full_log_sources(name,business_date) VALUES($key,$day) ON CONFLICT(name) DO UPDATE SET business_date=excluded.business_date", ("$key", stateKey), ("$day", sourceDate));
      source.Transaction = transaction; source.ExecuteNonQuery(); transaction.Commit();
    }
  }
  public List<FullLogEntry> PendingFullLogs(bool newest = true)
  {
    lock (sync) {
      using var cmd = Command("SELECT payload FROM full_log_events ORDER BY " + (newest ? "business_date DESC,logged_at DESC,rowid" : "rowid") + " LIMIT 200");
      using var rows = cmd.ExecuteReader(); var result = new List<FullLogEntry>();
      while (rows.Read()) result.Add(Decode<FullLogEntry>((byte[])rows[0]));
      while (result.Count > 1 && System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { entries = result }, Protocol.Json).Length > 700000) result.RemoveAt(result.Count - 1);
      return result;
    }
  }
  public void AcknowledgeFullLogs(IEnumerable<string> ids)
  {
    lock (sync) {
      using var transaction = connection.BeginTransaction();
      foreach (var id in ids) { using var cmd = Command("DELETE FROM full_log_events WHERE id=$id", ("$id", id)); cmd.Transaction = transaction; cmd.ExecuteNonQuery(); }
      transaction.Commit();
    }
  }
  public (int Pending, long Bytes) FullLogCounts(string? localId = null)
  {
    lock (sync) {
      using var cmd = Command("SELECT COUNT(*),COALESCE(SUM(size),0) FROM full_log_events WHERE ($local IS NULL OR local_id=$local)", ("$local", localId));
      using var row = cmd.ExecuteReader(); row.Read(); return (row.GetInt32(0), row.GetInt64(1));
    }
  }
  public long ExpireFullLogs(string first)
  {
    lock (sync) {
      using var count = Command("SELECT COUNT(*) FROM full_log_events WHERE business_date<$first", ("$first", first));
      var total = GetState<long>("full-log-expired") + Convert.ToInt64(count.ExecuteScalar());
      using var transaction = connection.BeginTransaction();
      foreach (var sql in new[] {
        "DELETE FROM full_log_events WHERE business_date<$first",
        "DELETE FROM state WHERE name IN (SELECT name FROM full_log_sources WHERE business_date<$first)",
        "DELETE FROM full_log_sources WHERE business_date<$first"
      }) { using var cmd = Command(sql, ("$first", first)); cmd.Transaction = transaction; cmd.ExecuteNonQuery(); }
      using var state = Command("INSERT INTO state(name,payload) VALUES('full-log-expired',$payload) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload", ("$payload", Encode(total)));
      state.Transaction = transaction; state.ExecuteNonQuery(); transaction.Commit(); return total;
    }
  }
}
