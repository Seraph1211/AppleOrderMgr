using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Channels;

namespace AosCollector.Core;

public sealed class CollectorEngine : IDisposable
{
  private readonly QueueStore store;
  private readonly CollectorConfig config;
  private readonly CollectorClient client;
  private readonly TimeProvider clock;
  private readonly Channel<bool> signals = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropOldest });
  private readonly List<FileSystemWatcher> watchers = [];
  private readonly Dictionary<string, (string Hash, DateTimeOffset At)> stableFiles = [];
  private readonly Dictionary<string, ScanRequest> activeScans = [];
  private CollectorContext? context;
  private string connectionState = "等待连接";
  private string? lastScanAt;
  private string? lastNewOrderAt;
  private string? errorCode;
  private List<DirectoryStatus> directories = [];
  private List<FileStatus> files = [];
  private bool authPaused;
  private DateTimeOffset nextConnect = DateTimeOffset.MinValue;
  private int connectionFailures;
  private DateTimeOffset lastHeartbeat = DateTimeOffset.MinValue;
  public CollectorStatus Status => new("运行中", connectionState, context?.ActiveSource ?? "unknown", lastScanAt, errorCode, store.Counts(), directories, files, Protocol.Now(), context?.ServerCounts, context?.ServerTime, "1.2.2", store.CodeCounts().Pending, store.CodeCounts().Errors);

  public CollectorEngine(CollectorConfig config, QueueStore store, HttpMessageHandler? handler = null, TimeProvider? clock = null)
  {
    this.clock = clock ?? TimeProvider.System;
    this.config = config; this.store = store; client = new CollectorClient(config, handler, store);
    context = store.GetState<CollectorContext>("context");
    foreach (var dir in config.Directories) {
      try {
        if (!Directory.Exists(dir.Path)) continue;
        var watcher = new FileSystemWatcher(dir.Path, "AOS*.txt") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size, IncludeSubdirectories = false, EnableRaisingEvents = true };
        watcher.Created += (_, _) => Signal(); watcher.Changed += (_, _) => Signal(); watcher.Renamed += (_, _) => Signal(); watcher.Deleted += (_, _) => Signal(); watcher.Error += (_, _) => Signal();
        watchers.Add(watcher);
      } catch (Exception) { errorCode = "DIRECTORY_UNREADABLE"; }
    }
  }
  public void Signal() => signals.Writer.TryWrite(true);
  public void RetryConnection() { authPaused = false; nextConnect = DateTimeOffset.MinValue; connectionFailures = 0; store.RetryPending(); Signal(); }
  public async Task Run(CancellationToken token)
  {
    while (!token.IsCancellationRequested) {
      try {
        if (!authPaused && DateTimeOffset.UtcNow >= nextConnect) {
          try {
            var latest = await client.Context(token);
            if (latest.Device.Id != config.DeviceId || latest.ProtocolVersion != 1) throw new CollectorException("DEVICE_IDENTITY_CHANGED");
            context = latest; store.SetState("context", latest); connectionState = "已连接"; connectionFailures = 0; nextConnect = DateTimeOffset.UtcNow.AddSeconds(15); errorCode = null;
            foreach (var scan in latest.PendingScanRequests) activeScans[scan.Id] = scan;
            foreach (var id in activeScans.Keys.Where(id => !latest.PendingScanRequests.Any(s => s.Id == id)).ToList()) activeScans.Remove(id);
          } catch (CollectorException e) { SetFailure(e.Code, e.RetryAfterSeconds); }
        }
        await Scan(token);
        foreach (var dir in config.Directories) {
          try { PaymentCodeCollector.Scan(dir, config, store, token); }
          catch (CollectorException e) { errorCode = e.Code; }
          catch (Exception) { errorCode = "PAYMENT_FILE_READ_FAILED"; }
        }
        if (!authPaused && connectionState == "已连接") await Upload(token);
        if (!authPaused && connectionState == "已连接") {
          var codes = store.PendingCodes();
          if (codes.Count > 0) {
            try {
              var sent = codes.Select(c => c.EventId).ToHashSet(); var receipts = await client.SendCodes(codes, token);
              foreach (var receipt in receipts) if (sent.Contains(receipt.EventId)) store.ApplyCode(receipt);
              foreach (var id in sent.Except(receipts.Select(r => r.EventId))) store.ApplyCode(new(id, "rejected", null, null, null, "RECEIPT_MISSING", true));
            }
            catch (CollectorException e) { SetFailure(e.Code, e.RetryAfterSeconds); }
          }
        }
        if (!authPaused && connectionState == "已连接" && DateTimeOffset.UtcNow - lastHeartbeat > TimeSpan.FromSeconds(15)) {
          try {
            foreach (var scan in activeScans.Values)
              foreach (var batch in store.ScanReceipts(scan.Id).Chunk(100)) await client.ConfirmScan(scan.Id, [.. batch], token);
            var scanResults = activeScans.Values.Select(s => store.ScanCounts(s.Id, directories.All(d => d.State is "ready" or "waiting_file") && files.All(f => !f.PendingTail && f.ErrorCode == null), errorCode?.StartsWith("DIRECTORY_") == true ? errorCode : null)).ToList();
            context = await client.Heartbeat(new(Guid.NewGuid().ToString(), "1.2.2", Environment.OSVersion.VersionString, Protocol.Now(), lastScanAt, lastNewOrderAt, directories, store.Counts(), scanResults), token);
            store.SetState("context", context); lastHeartbeat = DateTimeOffset.UtcNow;
          } catch (CollectorException e) { SetFailure(e.Code, e.RetryAfterSeconds); }
        }
      } catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
      catch (Exception) { errorCode = "LOCAL_PROCESSING_FAILED"; }
      using var wait = CancellationTokenSource.CreateLinkedTokenSource(token); wait.CancelAfter(TimeSpan.FromSeconds(5));
      try { await signals.Reader.ReadAsync(wait.Token); await Task.Delay(750, token); }
      catch (OperationCanceledException) when (!token.IsCancellationRequested) { }
    }
  }
  private void SetFailure(string code, int? retryAfterSeconds = null)
  {
    nextConnect = DateTimeOffset.UtcNow.AddSeconds(retryAfterSeconds ?? (code == "DEVICE_DISABLED" ? 60 : Math.Min(60, 1 << Math.Min(++connectionFailures, 6))));
    errorCode = code; connectionState = code is "DEVICE_UNAUTHORIZED" or "DEVICE_DISABLED" ? "凭证失效或设备禁用" : "连接异常，等待恢复";
    authPaused = code is "DEVICE_UNAUTHORIZED" or "DEVICE_IDENTITY_CHANGED";
  }
  internal async Task Scan(CancellationToken token)
  {
    var nextDirectories = new List<DirectoryStatus>(); var nextFiles = new List<FileStatus>();
    foreach (var dir in config.Directories) {
      var currentFiles = new List<string>(); var state = "ready"; string? dirError = null;
      try {
        if (!Directory.Exists(dir.Path)) throw new DirectoryNotFoundException();
        var paths = Directory.GetFiles(dir.Path, "AOS订单记录-*.txt", SearchOption.TopDirectoryOnly);
        if (paths.Length == 0) state = "waiting_file";
        foreach (var path in paths) {
          token.ThrowIfCancellationRequested(); var name = Path.GetFileName(path);
          if (currentFiles.Count < 20) currentFiles.Add(name);
          try {
            var info = new FileInfo(path);
            if (info.Length > 64 * 1024 * 1024) { nextFiles.Add(new(dir.Label, name, 0, false, "FILE_TOO_LARGE")); dirError = "FILE_TOO_LARGE"; continue; }
            // 允许抢购程序并发写入、删除或重命名；内容稳定性另行判断。
            byte[] bytes;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
              using var memory = new MemoryStream(); var buffer = new byte[65536]; int read;
              while ((read = await stream.ReadAsync(buffer, token)) > 0) { if (memory.Length + read > 64 * 1024 * 1024) throw new CollectorException("FILE_TOO_LARGE"); await memory.WriteAsync(buffer.AsMemory(0, read), token); }
              bytes = memory.ToArray();
            }
            var hash = Convert.ToHexString(SHA256.HashData(bytes));
            var stable = stableFiles.TryGetValue(path, out var old) && old.Hash == hash && DateTimeOffset.UtcNow - old.At >= TimeSpan.FromMilliseconds(750);
            if (!stableFiles.TryGetValue(path, out var previous) || previous.Hash != hash) stableFiles[path] = (hash, DateTimeOffset.UtcNow);
            var parsed = FileParser.Parse(bytes, config.Encoding, stable);
            var key = "file:" + Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(path)));
            var instanceKey = $"instance:{dir.DirectoryId}:{info.CreationTimeUtc.Ticks}";
            var identity = store.GetState<FileIdentity>(key) ?? store.GetState<FileIdentity>(instanceKey);
            if (identity == null || identity.Created != info.CreationTimeUtc.Ticks || bytes.Length < identity.Length) identity = new(Guid.NewGuid().ToString(), info.CreationTimeUtc.Ticks, bytes.Length);
            else identity = identity with { Length = bytes.Length };
            var registrations = identity.RegisteredDates ?? new Dictionary<string, string?>();
            var today = Protocol.BusinessDate(clock.GetUtcNow());
            if (parsed.Any(l => l.BusinessDate == today || l.PendingTail)) {
              var todayPermit = context?.ActiveSource == "aos" && context.BusinessDate == today ? context.CapturePermitId : null;
              if (!registrations.ContainsKey(today) || todayPermit != null) registrations[today] = todayPermit;
            }
            identity = identity with { RegisteredDates = registrations };
            store.SetState(key, identity); store.SetState(instanceKey, identity);
            var count = 0;
            foreach (var line in parsed) {
              if (line.PendingTail) continue;
              // 当前日与先前登记日期继续读取；旧队列独立恢复，未登记历史日期不自动回填。
              if (line.BusinessDate != null && line.BusinessDate != Protocol.BusinessDate(clock.GetUtcNow()) && !registrations.ContainsKey(line.BusinessDate) && !activeScans.Values.Any(s => s.BusinessDate == line.BusinessDate)) continue;
              var scans = activeScans.Values.Where(s => line.BusinessDate == null || s.BusinessDate == line.BusinessDate).ToList();
              var permit = context?.ActiveSource == "aos" && context.BusinessDate == line.BusinessDate ? context.CapturePermitId : line.BusinessDate != null ? registrations.GetValueOrDefault(line.BusinessDate) : null;
              var item = new UploadEvent(Guid.NewGuid().ToString(), dir.DirectoryId, identity.Id, name, line.LineNumber, Protocol.Now(), scans.FirstOrDefault()?.Id, permit, line.RawLine);
              if (store.Enqueue(item, line.BusinessDate)) lastNewOrderAt = Protocol.Now();
              foreach (var scan in scans.Skip(1)) store.Enqueue(item with { ScanRequestId = scan.Id }, line.BusinessDate);
              count++;
            }
            var namedDate = System.Text.RegularExpressions.Regex.Match(name, @"^AOS订单记录-(\d{4})");
            var mismatch = namedDate.Success && parsed.Any(l => l.BusinessDate != null && l.BusinessDate[5..].Replace("-", "") != namedDate.Groups[1].Value);
            nextFiles.Add(new(dir.Label, name, count, parsed.Any(l => l.PendingTail), null, mismatch ? "FILE_NAME_DATE_MISMATCH" : null));
          } catch (OperationCanceledException) { throw; }
          catch (CollectorException e) { nextFiles.Add(new(dir.Label, name, 0, false, e.Code)); dirError = e.Code; }
          catch (Exception) { nextFiles.Add(new(dir.Label, name, 0, false, "FILE_READ_FAILED")); dirError = "FILE_READ_FAILED"; }
        }
        if (dirError != null) state = "unreadable";
      } catch (OperationCanceledException) { throw; }
      catch (DirectoryNotFoundException) { state = "missing"; dirError = "DIRECTORY_MISSING"; }
      catch (Exception) { state = "unreadable"; dirError = "DIRECTORY_UNREADABLE"; }
      nextDirectories.Add(new(dir.DirectoryId, dir.Label, state, currentFiles, dirError == null ? Protocol.Now() : null, dirError));
    }
    directories = nextDirectories; files = nextFiles;
    if (directories.All(d => d.ErrorCode == null)) lastScanAt = Protocol.Now();
    else errorCode = directories.First(d => d.ErrorCode != null).ErrorCode;
  }
  private async Task Upload(CancellationToken token)
  {
    var pending = store.Pending(); if (pending.Count == 0) return;
    var batch = new List<UploadEvent>();
    foreach (var item in pending) {
      if (JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, records = batch.Append(item) }, Protocol.Json).Length > 1000000) break;
      batch.Add(item);
    }
    if (batch.Count == 0) { store.Apply(new(pending[0].EventId, "rejected", null, null, null, "PAYLOAD_TOO_LARGE", false)); return; }
    try {
      var receipts = await client.Send(batch, token); var sent = batch.Select(i => i.EventId).ToHashSet();
      foreach (var receipt in receipts) if (sent.Contains(receipt.EventId)) store.Apply(receipt);
      foreach (var item in batch) if (!receipts.Any(r => r.EventId == item.EventId)) store.Retry(item.EventId, "RECEIPT_MISSING");
    } catch (CollectorException e) {
      foreach (var item in batch) store.Retry(item.EventId, e.Code, e.RetryAfterSeconds ?? (e.Code == "RATE_LIMITED" ? 60 : null));
      SetFailure(e.Code, e.RetryAfterSeconds);
    }
  }
  private sealed record FileIdentity(string Id, long Created, long Length, Dictionary<string, string?>? RegisteredDates = null);
  public void Dispose() { foreach (var watcher in watchers) watcher.Dispose(); client.Dispose(); }
}
