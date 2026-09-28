using AosCollector.Core;
using System.Text;

internal static class FullLogTests
{
  public static void Run(Action<bool, string> check, string root)
  {
    var now = new DateTimeOffset(2026, 9, 29, 2, 0, 0, TimeSpan.FromHours(8));
    var path = Path.Combine(root, "full-logs"); Directory.CreateDirectory(path);
    var file = Path.Combine(path, "Log20260929_123.txt");
    var first = "2026-09-29 01:40:10.229 [2][128]A47-没有有货的店铺\r\n";
    var xml = "<response>\n<message>完整响应</message>\n</response>\n";
    File.WriteAllText(file, first + first + xml + "普通无时间行\n", new UTF8Encoding(false));
    File.SetLastWriteTimeUtc(file, now.AddSeconds(-10).UtcDateTime);
    var db = Path.Combine(root, "full-logs.sqlite");
    var localId = Guid.NewGuid().ToString();
    var directory = new DirectoryConfig(localId, "实例一", path);
    List<FullLogEntry> original;
    var protector = new TestProtector();
    using (var store = new QueueStore(db, protector)) {
      var scanner = new FullLogScanner(store);
      var status = scanner.Scan(directory, "utf-8", now);
      original = store.PendingFullLogs();
      check(original.Count == 6 && original.Count(e => e.Message == first) == 2, "完整日志保留真实重复行");
      check(original.Take(5).All(e => e.AccountNumber == "128") && original.Last().AccountNumber == null, "第二组方括号账号、XML继承及普通行不猜账号");
      check(original.Last().LoggedAt == null && original.Last().ContextAt == original.First().LoggedAt, "无时间行只借用前文排序，不伪造原时间或账号");
      check(original.Skip(2).Take(3).All(e => e.ParseState == "continuation"), "全部XML续行保留正文");
      check(status.ScannedBytes == status.TotalBytes && status.Pending == 6, "扫描完成和可靠接收分别统计");
      check(new FullLogScanner(store, 1).Scan(directory, "utf-8", now).State == "backpressure", "队列反压可见且不丢弃待传片段");
      scanner.Scan(directory, "utf-8", now);
      check(store.PendingFullLogs().Count == 6, "重复扫描不重复上传");
      scanner.Scan(directory with { DirectoryId = Guid.NewGuid().ToString() }, "utf-8", now);
      check(store.PendingFullLogs().Count == 12, "同账号跨实例独立保存");
      store.AcknowledgeFullLogs(store.PendingFullLogs().Select(e => e.Id));
      check(store.HasEvents(), "可靠接收后仍保留文件游标的设备身份保护");
      File.AppendAllText(file, first);
      File.SetLastWriteTimeUtc(file, now.AddSeconds(-9).UtcDateTime);
      scanner.Scan(directory, "utf-8", now);
      check(store.PendingFullLogs().Count == 1 && store.PendingFullLogs()[0].LineNumber == 7, "追加与已确认游标保持一致");
    }
    using (var store = new QueueStore(db, protector)) {
      check(store.HasEvents() && store.PendingFullLogs().Count == 1, "重启保留完整日志队列和身份保护");
      new FullLogScanner(store).Scan(directory, "utf-8", now);
      check(store.PendingFullLogs().Count == 1, "重启恢复游标不重复采集");
      store.AcknowledgeFullLogs(store.PendingFullLogs().Select(e => e.Id));
      File.WriteAllText(file, first); File.SetLastWriteTimeUtc(file, now.AddSeconds(-8).UtcDateTime);
      new FullLogScanner(store).Scan(directory, "utf-8", now);
      check(store.PendingFullLogs().Single().FileId != original[0].FileId && store.PendingFullLogs().Single().ByteOffset == 0, "截断新文件版本可追溯");
      store.AcknowledgeFullLogs(store.PendingFullLogs().Select(e => e.Id));
      var longLine = "2026-09-29 01:41:00.000 [2][128]" + new string('中', 23000) + "\n";
      File.AppendAllText(file, longLine); File.SetLastWriteTimeUtc(file, now.AddSeconds(-7).UtcDateTime);
      new FullLogScanner(store).Scan(directory, "utf-8", now);
      var parts = store.PendingFullLogs().OrderBy(e => e.ByteOffset).ToList();
      check(parts.Count > 4 && string.Concat(parts.Select(e => e.Message)) == longLine, "超长中文行分段无损重组");
      check(parts.All(e => e.AccountNumber == "128" && e.LineNumber == 2 && e.Message.Length <= 16000), "长行所有片段保留账号和物理行号");
      store.AcknowledgeFullLogs(parts.Select(e => e.Id));
      File.AppendAllText(file, "2026-09-29 01:42:00.000 [2][129]未完"); File.SetLastWriteTimeUtc(file, now.UtcDateTime);
      new FullLogScanner(store).Scan(directory, "utf-8", now);
      check(store.PendingFullLogs().Count == 0, "活跃半行等待稳定");
      new FullLogScanner(store).Scan(directory, "utf-8", now.AddSeconds(6));
      check(store.PendingFullLogs().Single().AccountNumber == "129", "稳定无换行尾部可查询");
      File.AppendAllText(file, "成\n"); File.SetLastWriteTimeUtc(file, now.AddSeconds(1).UtcDateTime);
      new FullLogScanner(store).Scan(directory, "utf-8", now.AddSeconds(7));
      check(store.PendingFullLogs().Last().PartIndex == 1 && store.PendingFullLogs().Last().LineNumber == 3, "稳定尾行后追加继续同一物理行");
      File.WriteAllText(Path.Combine(path, "Log20260831_old.txt"), "2026-08-31 01:00:00.000 [9][128]历史\n");
      File.WriteAllText(Path.Combine(path, "Log20260830_expired.txt"), "2026-08-30 01:00:00.000 [9][128]过期\n");
      var state = new FullLogScanner(store).Scan(directory, "utf-8", now);
      check(state.Dates.Contains("2026-08-31") && !state.Dates.Contains("2026-08-30"), "30天旧日志覆盖与自然日边界");
      check(store.PendingFullLogs().Any(e => e.BusinessDate == "2026-08-31"), "历史文件首次补采");
      File.WriteAllBytes(Path.Combine(path, "Log20260929_bad.txt"), [0xff, 0x00, 0x0a]);
      new FullLogScanner(store).Scan(directory, "utf-8", now);
      check(store.PendingFullLogs().Any(e => e.ParseState == "encoding_error" && e.RawBase64 == "/wAK"), "损坏编码保存原始字节，正文不含数据库零字节");
      var partial = Path.Combine(path, "Log20260929_partial.txt");
      File.WriteAllText(partial, "2026-09-29 01:43:00.000 [2][1"); File.SetLastWriteTimeUtc(partial, now.AddSeconds(-30).UtcDateTime);
      new FullLogScanner(store).Scan(directory, "utf-8", now);
      check(!store.PendingFullLogs().Any(e => e.FileName.EndsWith("partial.txt")), "未写完账号头不提前提交错误账号");
      File.AppendAllText(partial, "28]完整账号\n");
      new FullLogScanner(store).Scan(directory, "utf-8", now);
      check(store.PendingFullLogs().Any(e => e.FileName.EndsWith("partial.txt") && e.AccountNumber == "128"), "账号头补全后完整索引");
      check(store.ExpireFullLogs("2026-09-01") > 0 && store.PendingFullLogs().All(e => e.BusinessDate != "2026-08-31"), "过期补传计数可见");
    }
    var gbPath = Path.Combine(root, "full-logs-gb"); Directory.CreateDirectory(gbPath);
    Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    File.WriteAllBytes(Path.Combine(gbPath, "Log20260929_gb.txt"), Encoding.GetEncoding("gb18030").GetBytes(first));
    using var gbStore = new QueueStore(Path.Combine(root, "full-gb.sqlite"), new TestProtector());
    new FullLogScanner(gbStore).Scan(new(Guid.NewGuid().ToString(), "GB实例", gbPath), "gb18030", now);
    check(gbStore.PendingFullLogs().Single().Message == first, "GB18030完整原文与账号解析");
  }
  public static async Task RunAsync(Action<bool, string> check, string root)
  {
    var handler = new LogTransportHandler();
    var directory = new DirectoryConfig(Guid.NewGuid().ToString(), "网络测试", root);
    var config = new CollectorConfig("网络测试", "https://example.test", "aos_synthetic", Guid.NewGuid().ToString(), [directory]);
    handler.ExpectedDeviceId = config.DeviceId;
    using var client = new CollectorClient(config, handler);
    var item = new FullLogEntry(Guid.NewGuid().ToString(), directory.DirectoryId, Guid.NewGuid().ToString(), "Log20260929_net.txt", "2026-09-29", "2026-09-28T17:40:10.229Z", "128", 1, 0, 0, "中文完整日志\n", null, "parsed");
    try { await client.SendFullLogs([item], CancellationToken.None); check(false, "首次响应丢失"); }
    catch (CollectorException error) { check(error.Code == "CONNECTION_FAILED", "日志响应丢失不伪造成功回执"); }
    var receipt = await client.SendFullLogs([item], CancellationToken.None);
    check(receipt.Accepted.SequenceEqual(new[] { item.Id }) && handler.Bodies.Count == 2 && handler.Bodies[0] == handler.Bodies[1], "gzip重传保持原始事件和正文");
    var protector = new FailingProtector(new TestProtector());
    using var store = new QueueStore(Path.Combine(root, "full-log-atomic.sqlite"), protector);
    protector.Remaining = 2;
    var cursor = new FullLogCursor(item.FileId, 0, 12, "", 12, 0, 2, 0, null, null, "unparsed", null, null, 0);
    try { store.CommitFullLogs("fault-test", cursor, [item, item with { Id = Guid.NewGuid().ToString(), ByteOffset = 1 }], "2026-09-29"); check(false, "模拟事务中断"); }
    catch (InvalidOperationException) { check(store.PendingFullLogs().Count == 0 && store.GetState<FullLogCursor>("fault-test") == null, "队列与游标事务中断整体回滚"); }
  }
  private sealed class FailingProtector(IProtector inner) : IProtector
  {
    public int Remaining { get; set; }
    public byte[] Protect(byte[] value) { if (Remaining > 0 && --Remaining == 0) throw new InvalidOperationException("合成写入故障"); return inner.Protect(value); }
    public byte[] Unprotect(byte[] value) => inner.Unprotect(value);
  }
  private sealed class LogTransportHandler : System.Net.Http.HttpMessageHandler
  {
    public List<string> Bodies { get; } = [];
    public string ExpectedDeviceId { get; set; } = "";
    protected override async Task<System.Net.Http.HttpResponseMessage> SendAsync(System.Net.Http.HttpRequestMessage request, CancellationToken token)
    {
      try {
        if (request.Content == null || !request.Content.Headers.ContentEncoding.Contains("gzip") || request.Headers.Authorization?.Parameter != "aos_synthetic" || !request.Headers.TryGetValues("X-AOS-Device-Id", out var ids) || ids.Single() != ExpectedDeviceId) throw new InvalidOperationException("完整日志必须gzip设备认证传输");
        await using var input = await request.Content.ReadAsStreamAsync(token);
        await using var gzip = new System.IO.Compression.GZipStream(input, System.IO.Compression.CompressionMode.Decompress);
        using var reader = new StreamReader(gzip);
        var text = await reader.ReadToEndAsync(token); Bodies.Add(text);
        using var json = System.Text.Json.JsonDocument.Parse(text);
        var id = json.RootElement.GetProperty("entries")[0].GetProperty("id").GetString();
        if (Bodies.Count == 1) throw new HttpRequestException("合成已接收响应丢失");
        return new(System.Net.HttpStatusCode.OK) { Content = System.Net.Http.Json.JsonContent.Create(new { success = true, data = new { accepted = new[] { id }, expired = Array.Empty<string>() } }) };
      } catch (Exception) { throw; }
    }
  }

}
