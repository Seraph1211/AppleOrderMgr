namespace AosCollector.Core;

public sealed partial class QueueStore
{
  private void InitializeMonitor()
  {
    Execute("CREATE TABLE IF NOT EXISTS monitor_reports (id TEXT PRIMARY KEY, ended_at TEXT NOT NULL, payload BLOB NOT NULL); CREATE TABLE IF NOT EXISTS monitor_transport (id INTEGER PRIMARY KEY CHECK(id=1), received INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO monitor_transport(id) VALUES(1);");
  }
  public void AddTransport(long received, long sent)
  {
    lock (sync) { Execute("UPDATE monitor_transport SET received=received+$r,sent=sent+$s WHERE id=1", ("$r", received), ("$s", sent)); }
  }
  public (long Received, long Sent) Transport()
  {
    lock (sync) { using var cmd = Command("SELECT received,sent FROM monitor_transport WHERE id=1"); using var r = cmd.ExecuteReader(); r.Read(); return (r.GetInt64(0), r.GetInt64(1)); }
  }
  public void EnqueueMonitor(MonitorReport report)
  {
    lock (sync) { Execute("INSERT OR IGNORE INTO monitor_reports(id,ended_at,payload) VALUES($id,$at,$payload)", ("$id", report.Id), ("$at", report.EndedAt), ("$payload", Encode(report))); }
  }
  public MonitorReport? LatestMonitor()
  {
    lock (sync) { using var cmd = Command("SELECT payload FROM monitor_reports ORDER BY ended_at DESC,id LIMIT 1"); return cmd.ExecuteScalar() is byte[] bytes ? Decode<MonitorReport>(bytes) : null; }
  }
  public List<MonitorReport> PendingMonitor()
  {
    lock (sync) { using var cmd = Command("SELECT payload FROM monitor_reports ORDER BY ended_at,id LIMIT 10"); using var r = cmd.ExecuteReader(); var result = new List<MonitorReport>(); while (r.Read()) result.Add(Decode<MonitorReport>((byte[])r[0])); return result; }
  }
  public void AcknowledgeMonitor(IEnumerable<string> ids)
  {
    lock (sync) { foreach (var id in ids) Execute("DELETE FROM monitor_reports WHERE id=$id", ("$id", id)); }
  }
  public (int Pending, long Expired) MonitorCounts(DateTimeOffset now)
  {
    lock (sync) {
      var before = now.AddDays(-90).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
      using var count = Command("SELECT COUNT(*) FROM monitor_reports WHERE ended_at<$at", ("$at", before)); var removed = Convert.ToInt64(count.ExecuteScalar());
      var expired = GetState<long>("monitorExpired") + removed;
      if (removed > 0) { SetState("monitorExpired", expired); Execute("DELETE FROM monitor_reports WHERE ended_at<$at", ("$at", before)); }
      using var pending = Command("SELECT COUNT(*) FROM monitor_reports"); return (Convert.ToInt32(pending.ExecuteScalar()), expired);
    }
  }
}
