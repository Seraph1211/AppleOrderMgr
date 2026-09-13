using AosCollector.Core;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;

var root = Path.Combine(Path.GetTempPath(), "aos-collector-tests-" + Guid.NewGuid());
Directory.CreateDirectory(root);
var passed = 0;
void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException("验证失败：" + name); passed++; System.Console.WriteLine("通过：" + name); }
var today = Protocol.BusinessDate();
string Line(string number = "W9900000001", string? day = null) => string.Join('\t', new[] { number, "contact@example.com", "account@example.com", "synthetic-password", "测试", "用户", "R001", "", "synthetic-account", "13800000000", "TEST/A-测试商品 x 2", "微信", "测试 TAG", $"https://www.apple.com.cn/xc/cn/vieworder/{number}/contact%40example.com", $"{day ?? today} 10:00:00.123" });
UploadEvent Event(string raw, string? scan = null) => new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "AOS订单记录-测试.txt", 1, Protocol.Now(), scan, null, raw);
var utf8 = new UTF8Encoding(false, true);
try {
  PaymentCodeTests.Run(Check, root);
  var line = Line();
  Check(FileParser.Parse(utf8.GetBytes(line + "\r\n"), "utf-8", false) is [{ PendingTail: false, BusinessDate: not null }], "15 列空字段、CRLF 与毫秒日期");
  Check(FileParser.Parse(utf8.GetBytes("\uFEFF" + line + "\n"), "utf-8", false)[0].RawLine == line, "UTF-8 BOM 与无 BOM 内容一致");
  Check(FileParser.Parse(utf8.GetBytes(line), "utf-8", false)[0].PendingTail, "未稳定无换行尾行等待");
  Check(!FileParser.Parse(utf8.GetBytes(line), "utf-8", true)[0].PendingTail, "完整稳定无换行尾行可接收");
  Check(FileParser.Parse(utf8.GetBytes(line[..^8]), "utf-8", true)[0].PendingTail, "缺失时间尾段持续等待");
  Check(FileParser.Parse(utf8.GetBytes("broken\n" + line + "\n"), "utf-8", true).Count == 2, "稳定坏行不阻塞后续好行");
  Check(FileParser.Parse(utf8.GetBytes(Line(day: "2026-02-30") + "\n"), "utf-8", true)[0].BusinessDate == null, "拒绝无效日历日期");
  try { FileParser.Parse([0xff, 0xfe, 0xff], "utf-8", true); Check(false, "拒绝乱码"); } catch (CollectorException e) { Check(e.Code == "ENCODING_INVALID", "拒绝错误编码"); }
  Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
  Check(FileParser.Parse(Encoding.GetEncoding("GB18030").GetBytes(line + "\r\n"), "gb18030", true)[0].RawLine == line, "显式 GB18030 不丢失中文");
  var splitUtf8 = FileParser.Parse([.. utf8.GetBytes(line + "\n"), 0xe6, 0xb5], "utf-8", false);
  Check(splitUtf8.Count == 2 && !splitUtf8[0].PendingTail && splitUtf8[1].PendingTail, "尾部半个 UTF-8 字符不阻塞前置完整行");
  var path = Path.Combine(root, "queue.sqlite"); var protector = new TestProtector();
  var first = Event(line); var scanId = Guid.NewGuid().ToString();
  using (var queue = new QueueStore(path, protector)) {
    Check(queue.Enqueue(first, today), "先持久化不可变事件");
    Check(!queue.Enqueue(Event(line, scanId), today), "同内容跨文件去重并关联补录扫描");
    Check(queue.ScanCounts(scanId, true).Status == "running", "未收到可靠回执不报告扫描完成");
    Check(queue.Enqueue(Event(Line("W9900000002")), today), "独立订单进入队列");
    queue.Apply(new(first.EventId, "accepted", Guid.NewGuid().ToString(), "ready", "source_disabled", null, false));
    Check(queue.ScanCounts(scanId, true).Status == "completed", "暂停入库也可可靠接收并完成传输");
    queue.Apply(new(first.EventId, "already_received", Guid.NewGuid().ToString(), "succeeded", "allowed", null, false));
    Check(queue.Counts().PendingUpload == 1 && queue.Counts().TodayDiscovered == 2, "重复回执不增加发现或待上传计数");
  }
  using (var queue = new QueueStore(path, protector)) {
    Check(queue.Pending().Count == 1 && queue.Pending()[0].RawLine.Contains("W9900000002"), "进程重启恢复未回执事件");
    Check(!queue.Enqueue(Event(line), today), "重启后内容指纹稳定");
    var pending = queue.Pending()[0]; queue.Retry(pending.EventId, "RATE_LIMITED", 60);
    Check(queue.Pending().Count == 0 && queue.Counts().PendingUpload == 1, "限流退避不删除本地队列");
    queue.RetryPending(); Check(queue.Pending()[0].EventId == pending.EventId, "重试保持原事件 ID 与载荷");
    queue.Apply(new(pending.EventId, "rejected", null, null, null, "VALIDATION_ERROR", false));
    Check(queue.Counts().UploadError == 1 && queue.Pending().Count == 0, "永久拒绝可见且不无限重传");
  }
  Check(!Encoding.UTF8.GetString(File.ReadAllBytes(path)).Contains("synthetic-password"), "SQLite 文件无密码或原文明文");
  try { using var invalid = new CollectorClient(new("test", "http://example.com", "synthetic", "device", [])); Check(false, "拒绝 HTTP"); } catch (CollectorException e) { Check(e.Code == "SERVER_URL_INVALID", "禁止明文 HTTP 与凭证重定向"); }
  var directory = Path.Combine(root, "files"); Directory.CreateDirectory(directory);
  var deviceId = Guid.NewGuid().ToString(); var directoryId = Guid.NewGuid().ToString(); var permitId = Guid.NewGuid().ToString();
  var config = new CollectorConfig("test", "https://example.com", "synthetic-token", deviceId, [new(directoryId, "测试目录", directory)]);
  var handler = new FakeServer(deviceId, permitId);
  var file = Path.Combine(directory, "AOS订单记录-测试.txt");
  using (var queue = new QueueStore(Path.Combine(root, "engine.sqlite"), protector))
  using (var engine = new CollectorEngine(config, queue, handler))
  using (var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(45))) {
    await File.WriteAllTextAsync(file, line + "\r\n", utf8);
    var run = engine.Run(shutdown.Token);
    async Task Until(Func<bool> condition) { var until = DateTimeOffset.UtcNow.AddSeconds(12); while (!condition()) { if (DateTimeOffset.UtcNow >= until) throw new InvalidOperationException("文件流程等待超时"); await Task.Delay(100); } }
    try {
      await Until(() => handler.AcceptedCount == 1); Check(queue.Counts().PendingUpload == 0, "文件首次扫描上传并应用逐条回执");
      await File.AppendAllTextAsync(file, Line("W9900000003") + "\r\n", utf8); await Until(() => handler.AcceptedCount == 2);
      Check(handler.AcceptedCount == 2, "文件追加只上传新记录");
      await File.WriteAllTextAsync(file, Line("W9900000003") + "\n" + line + "\n", utf8); engine.Signal(); await Task.Delay(1700);
      Check(handler.AcceptedCount == 2, "整文件重写和调换行序不重复上传");
      var renamed = Path.Combine(directory, "AOS订单记录-替换.txt"); File.Move(file, renamed); engine.Signal(); await Task.Delay(1700);
      Check(handler.AcceptedCount == 2, "文件重命名不重复上传");
      await File.AppendAllTextAsync(renamed, Line("W9900000004")[..^8], utf8); engine.Signal(); await Task.Delay(1700);
      Check(handler.AcceptedCount == 2 && engine.Status.Files.Any(f => f.PendingTail), "写入未完成尾行不提交");
      await File.AppendAllTextAsync(renamed, Line("W9900000004")[^8..] + "\n", utf8); engine.Signal(); await Until(() => handler.AcceptedCount == 3);
      Check(handler.AcceptedCount == 3, "尾行补全后提交且不阻塞旧记录");
      handler.FailNextReceipt = true;
      await File.AppendAllTextAsync(renamed, Line("W9900000005") + "\n", utf8); engine.Signal(); await Until(() => handler.AcceptedCount == 4);
      await Until(() => handler.Replays > 0 && queue.Counts().PendingUpload == 0);
      Check(handler.AcceptedCount == 4 && handler.Replays > 0, "服务端已接收但响应丢失时稳定事件重传");
    } finally { shutdown.Cancel(); try { await run; } catch (OperationCanceledException) { } }
  }
  var midnightDirectory = Path.Combine(root, "midnight"); Directory.CreateDirectory(midnightDirectory);
  var midnightFile = Path.Combine(midnightDirectory, "AOS订单记录-0910.txt");
  var clock = new TestClock(DateTimeOffset.Parse("2026-09-10T15:59:59Z"));
  var midnightConfig = config with { Directories = [new(directoryId, "跨日目录", midnightDirectory)] };
  using (var queue = new QueueStore(Path.Combine(root, "midnight.sqlite"), protector)) {
    queue.SetState("context", new CollectorContext(new(deviceId, "test", true, 1), 1, Protocol.Now(), 1, "aos", "2026-09-10", permitId, []));
    var unfinished = Line("W9900000007", "2026-09-10");
    await File.WriteAllTextAsync(midnightFile, Line("W9900000006", "2026-09-10") + "\n" + unfinished[..^8], utf8);
    using (var engine = new CollectorEngine(midnightConfig, queue, new FakeServer(deviceId, permitId), clock)) await engine.Scan(CancellationToken.None);
    Check(queue.Pending().Count == 1, "跨日前登记旧文件与不完整尾行");
    clock.Current = clock.Current.AddSeconds(2);
    queue.SetState("context", new CollectorContext(new(deviceId, "test", true, 1), 1, Protocol.Now(), 1, "aos", "2026-09-11", Guid.NewGuid().ToString(), []));
    await File.AppendAllTextAsync(midnightFile, unfinished[^8..] + "\n", utf8);
    using (var engine = new CollectorEngine(midnightConfig, queue, new FakeServer(deviceId, permitId), clock)) await engine.Scan(CancellationToken.None);
    Check(queue.Pending().Count == 2 && queue.Pending().All(e => e.CapturePermitId == permitId), "跨午夜并重启后补全旧尾行，保留原日期采集许可");
    await File.WriteAllTextAsync(Path.Combine(midnightDirectory, "AOS订单记录-0901.txt"), Line("W9900000008", "2026-09-01") + "\n", utf8);
    using (var engine = new CollectorEngine(midnightConfig, queue, new FakeServer(deviceId, permitId), clock)) await engine.Scan(CancellationToken.None);
    Check(queue.Pending().Count == 2, "首次发现未登记历史文件不自动扩大补录范围");
  }
  using (var client = new CollectorClient(config, new RateLimitServer())) {
    try { await client.Context(CancellationToken.None); Check(false, "HTTP 429"); } catch (CollectorException e) { Check(e.Code == "RATE_LIMITED" && e.RetryAfterSeconds == 7, "遵守 Retry-After 秒数"); }
  }
  System.Console.WriteLine($"全部 {passed} 项采集器测试通过。");
} finally { Directory.Delete(root, true); }

sealed class TestProtector : IProtector {
  private readonly byte[] key = RandomNumberGenerator.GetBytes(32);
  public byte[] Protect(byte[] plain) { var nonce = RandomNumberGenerator.GetBytes(12); var cipher = new byte[plain.Length]; var tag = new byte[16]; using var aes = new AesGcm(key, 16); aes.Encrypt(nonce, plain, cipher, tag); return [.. nonce, .. tag, .. cipher]; }
  public byte[] Unprotect(byte[] encrypted) { var plain = new byte[encrypted.Length - 28]; using var aes = new AesGcm(key, 16); aes.Decrypt(encrypted.AsSpan(0, 12), encrypted.AsSpan(28), encrypted.AsSpan(12, 16), plain); return plain; }
}
sealed class FakeServer(string device, string permit) : HttpMessageHandler {
  private readonly HashSet<string> accepted = []; private readonly object gate = new();
  public int AcceptedCount { get { lock (gate) return accepted.Count; } }
  public int Replays; public bool FailNextReceipt;
  protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
    if (request.RequestUri!.AbsolutePath.EndsWith("records")) {
      var bytes = await request.Content!.ReadAsByteArrayAsync(token); using var json = JsonDocument.Parse(bytes);
      var results = new List<Receipt>();
      foreach (var record in json.RootElement.GetProperty("records").EnumerateArray()) {
        var id = record.GetProperty("eventId").GetString()!; bool fresh; lock (gate) fresh = accepted.Add(id); if (!fresh) Interlocked.Increment(ref Replays);
        results.Add(new(id, fresh ? "accepted" : "already_received", Guid.NewGuid().ToString(), "ready", "allowed", null, false));
      }
      if (FailNextReceipt) { FailNextReceipt = false; throw new HttpRequestException("synthetic-response-loss"); }
      return Reply(new { results });
    }
    return Reply(new CollectorContext(new(device, "test", true, 1), 1, Protocol.Now(), 1, "aos", Protocol.BusinessDate(), permit, []));
  }
  private static HttpResponseMessage Reply(object data) => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new { success = true, data }, Protocol.Json), Encoding.UTF8, "application/json") };
}
sealed class RateLimitServer : HttpMessageHandler {
  protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) { var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests); response.Headers.RetryAfter = new(TimeSpan.FromSeconds(7)); return Task.FromResult(response); }
}

sealed class TestClock(DateTimeOffset current) : TimeProvider { public DateTimeOffset Current = current; public override DateTimeOffset GetUtcNow() => Current; }
