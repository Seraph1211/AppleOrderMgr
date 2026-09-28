namespace AosCollector.Core;

public sealed class FullLogEngine(CollectorConfig config, QueueStore store) : IDisposable
{
  private readonly CollectorClient client = new(config, accounting: store);
  private FullLogStates? latest;
  public async Task Run(CancellationToken token)
  {
    try {
      while (!token.IsCancellationRequested && !store.GetState<bool>("full-log-capable")) {
        try { if ((await client.FullLogContext(token)).Enabled) { store.SetState("full-log-capable", true); break; } }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception) { /* 服务端能力未部署时，原采集循环保持独立。 */ }
        await Task.Delay(TimeSpan.FromMinutes(1), token);
      }
      await Task.WhenAll(ScanLoop(token), UploadLoop(token));
    } catch (OperationCanceledException) when (token.IsCancellationRequested) { }
  }
  private async Task ScanLoop(CancellationToken token)
  {
    await Task.Yield();
    var scanner = new FullLogScanner(store);
    while (!token.IsCancellationRequested) {
      try {
        var now = DateTimeOffset.UtcNow;
        var states = new List<FullLogState>();
        foreach (var directory in config.Monitoring?.Directories ?? []) {
          token.ThrowIfCancellationRequested();
          states.Add(scanner.Scan(directory, config.Encoding, now, token));
        }
        Volatile.Write(ref latest, new FullLogStates(now.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), states));
      } catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
      catch (Exception) { /* 下轮重试，不能清空未确认队列或推进游标。 */ }
      await Task.Delay(TimeSpan.FromSeconds(30), token);
    }
  }
  private async Task UploadLoop(CancellationToken token)
  {
    string? sentState = null;
    while (!token.IsCancellationRequested) {
      var delay = 5; var uploadFailed = false; var throttled = false;
      try {
        store.ExpireFullLogs(FullLogScanner.FirstDate(DateTimeOffset.UtcNow));
        for (var i = 0; i < 4; i++) {
          var batch = store.PendingFullLogs(i != 3); if (batch.Count == 0) break;
          var receipt = await client.SendFullLogs(batch, token);
          var sent = batch.Select(item => item.Id).ToHashSet();
          store.AcknowledgeFullLogs(receipt.Accepted.Concat(receipt.Expired).Where(sent.Contains));
        }
      } catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
      catch (CollectorException error) { delay = error.RetryAfterSeconds ?? 30; uploadFailed = true; throttled = error.Code == "RATE_LIMITED"; }
      catch (Exception) { delay = 30; uploadFailed = true; }
      try {
        var snapshot = Volatile.Read(ref latest);
        if (!throttled && snapshot != null && (snapshot.ObservedAt != sentState || uploadFailed)) {
          var current = snapshot with { Instances = snapshot.Instances.Select(item => {
            var pending = store.FullLogCounts(item.LocalId).Pending;
            var state = uploadFailed && pending > 0 ? "error" : item.State == "catching_up" && item.ScannedBytes == item.TotalBytes && pending == 0 ? "ready" : item.State;
            return item with { Pending = pending, State = state };
          }).ToList() };
          await client.SendFullLogStates(current, token); sentState = snapshot.ObservedAt;
        }
      } catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
      catch (Exception) { /* 上报失败后保持本地队列，网站状态自然过期。 */ }
      await Task.Delay(TimeSpan.FromSeconds(delay), token);
    }
  }
  public void Dispose() { client.Dispose(); }
}
