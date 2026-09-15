namespace AosCollector.Core;

public sealed class MonitorEngine : IDisposable
{
  private readonly CollectorConfig config;
  private readonly QueueStore store;
  private readonly CollectorClient client;
  private readonly LogMonitor logs;
  private readonly TrafficMonitor traffic = new();
  private readonly TimeSpan sampleInterval;
  private readonly TimeSpan pollInterval;
  private readonly object statusSync = new();
  private MonitorContext? context;
  private MonitorStatus status = new("等待首次采样", null, null, 0, 0, [], null, null);
  public MonitorStatus Status { get { lock (statusSync) return status; } }
  private void Update(Func<MonitorStatus, MonitorStatus> change) { lock (statusSync) status = change(status); }
  public MonitorEngine(CollectorConfig config, QueueStore store, HttpMessageHandler? handler = null, TimeSpan? sampleInterval = null, TimeSpan? pollInterval = null)
  {
    this.config = config; this.store = store; this.sampleInterval = sampleInterval ?? TimeSpan.FromSeconds(60); this.pollInterval = pollInterval ?? TimeSpan.FromSeconds(15);
    client = new CollectorClient(config, handler, store); logs = new(store);
    context = store.GetState<MonitorContext>("monitor-context");
  }
  public async Task Run(CancellationToken token)
  {
    try { await Task.WhenAll(SampleLoop(token), UploadLoop(token)); }
    catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    catch (Exception) { Update(s => s with { State = "监控运行异常" }); }
  }
  private async Task SampleLoop(CancellationToken token)
  {
    var started = DateTimeOffset.UtcNow;
    try { traffic.Sample(TrafficMonitor.ReadInterfaces(), config.Monitoring?.InterfaceIds ?? [], store.Transport(), started); }
    catch (Exception) { traffic.Reset(); }
    using var timer = new PeriodicTimer(sampleInterval);
    while (!token.IsCancellationRequested) {
      try {
        if (!await timer.WaitForNextTickAsync(token)) break;
        var now = DateTimeOffset.UtcNow;
        if (now <= started) { traffic.Reset(); Update(s => s with { State = "系统时钟回退，等待恢复" }); continue; }
        var counts = store.MonitorCounts(now);
        TrafficDelta delta;
        try { delta = traffic.Sample(TrafficMonitor.ReadInterfaces(), config.Monitoring?.InterfaceIds ?? [], store.Transport(), now); }
        catch (Exception) { traffic.Reset(); delta = new(0, 0, 0, 0, "unavailable"); }
        if (now - started > TimeSpan.FromSeconds(120)) { started = now.AddSeconds(-60); delta = delta with { ReceivedBytes = 0, SentBytes = 0, Quality = "gap" }; }
        var current = Volatile.Read(ref context);
        var observations = current == null ? new List<MonitorObservation>() : (config.Monitoring?.Directories ?? []).Select(d => logs.Scan(d, config.Encoding, config.DeviceId, current, now)).ToList();
        var report = new MonitorReport(Guid.NewGuid().ToString(), current?.Revision ?? new string('0', 64), started.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), now.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), delta, observations);
        store.EnqueueMonitor(report); started = now;
        Update(s => s with { State = current == null ? "等待规则同步" : s.LastUploadAt == null || now - DateTimeOffset.Parse(s.LastUploadAt) > TimeSpan.FromMinutes(2) ? "采样正常，等待上传" : "运行中", LastScanAt = now.ToString("O"), Pending = counts.Pending + 1, Expired = counts.Expired, Instances = observations, Traffic = delta, Revision = current?.Revision });
      } catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
      catch (Exception) { Update(s => s with { State = "监控采样异常" }); }
    }
  }
  private async Task UploadLoop(CancellationToken token)
  {
    while (!token.IsCancellationRequested) {
      try {
        try {
          var current = await client.MonitorContext(token); store.SetState("monitor-context", current); Volatile.Write(ref context, current);
        } catch (Exception) when (!token.IsCancellationRequested) { Update(s => s with { State = "规则连接失败，继续本地采样" }); }
        // 优先最新报告，避免90天补传阻塞当前告警；网络延迟不阻塞采样线程。
        var latest = store.LatestMonitor();
        if (latest != null) {
          var receipts = await client.SendMonitor([latest], token); store.AcknowledgeMonitor(receipts.Accepted.Where(id => id == latest.Id));
        }
        for (var i = 0; i < 6; i++) {
          var batch = store.PendingMonitor(); if (batch.Count == 0) break;
          while (batch.Count > 1 && System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { reports = batch }, Protocol.Json).Length > 900000) batch.RemoveAt(batch.Count - 1);
          var receipts = await client.SendMonitor(batch, token); var sent = batch.Select(r => r.Id).ToHashSet(); store.AcknowledgeMonitor(receipts.Accepted.Where(sent.Contains));
        }
        if (latest != null) Update(s => s with { State = "运行中", LastUploadAt = Protocol.Now(), Pending = store.MonitorCounts(DateTimeOffset.UtcNow).Pending });
      } catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
      catch (Exception) { Update(s => s with { State = "监控上报异常，继续本地采样" }); }
      try { await Task.Delay(pollInterval, token); }
      catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
    }
  }
  public void Dispose() { client.Dispose(); }
}
