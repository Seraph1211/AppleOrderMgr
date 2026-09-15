using AosCollector.Core;
using System.Text;
using System.Net;
using System.Text.Json;

internal static class MonitorTests
{
  public static async Task RunAsync(Action<bool, string> check, string root)
  {
    using var store = new QueueStore(Path.Combine(root, "monitor-offline.sqlite"), new TestProtector());
    var handler = new SlowServer();
    var config = new CollectorConfig("test", "https://example.com", "synthetic", Guid.NewGuid().ToString(), []);
    using var engine = new MonitorEngine(config, store, handler, TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(20));
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    var running = engine.Run(stop.Token);
    try {
      var deadline = DateTimeOffset.UtcNow.AddSeconds(3);
      while ((!handler.UploadStarted || store.MonitorCounts(DateTimeOffset.UtcNow).Pending < 3) && DateTimeOffset.UtcNow < deadline) await Task.Delay(20);
      check(handler.UploadStarted && store.MonitorCounts(DateTimeOffset.UtcNow).Pending >= 3, "上传阻塞期间独立采样持续入队");
    } finally { stop.Cancel(); await running; }
  }
  private sealed class SlowServer : HttpMessageHandler
  {
    public bool UploadStarted;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
      try {
        if (request.Method == HttpMethod.Post) { UploadStarted = true; await Task.Delay(Timeout.Infinite, token); }
        return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new { success = true, data = new MonitorContext(new string('a', 64), []) }, Protocol.Json)) };
      } catch (Exception) { throw; }
    }
  }
  public static void Run(Action<bool, string> check, string root)
  {
    var path = Path.Combine(root, "monitor"); Directory.CreateDirectory(path);
    var now = new DateTimeOffset(2026, 9, 15, 0, 3, 0, TimeSpan.FromHours(8));
    var rule = new MonitorRule(Guid.NewGuid().ToString(), 1, "代理异常", true, "any", ["没有可用的代理"], ["购买异常"], 10, 2, "warning", [], []);
    var context = new MonitorContext(new string('a', 64), [rule]);
    var directory = new DirectoryConfig(Guid.NewGuid().ToString(), "实例一", path);
    var yesterday = Path.Combine(path, "Log20260914_8880.txt"); var today = Path.Combine(path, "Log20260915_1234.txt");
    var first = "2026-09-14 23:58:00.000 [1]没有可用的代理 http://user:secret@example.com:80";
    File.WriteAllText(yesterday, first + "\r\n2026-09-14 22:00:00.000 [1]没有可用的代理\r\n");
    File.WriteAllText(today, "2026-09-15 00:01:00.000 [1]购买异常 没有可用的代理\n2026-09-15 00:02:00.000 [1]没有可用的代理\n");
    var protector = new TestProtector();
    var device = Guid.NewGuid().ToString(); var db = Path.Combine(root, "monitor.sqlite");
    using (var store = new QueueStore(db, protector)) {
      var monitor = new LogMonitor(store);
      var scan = monitor.Scan(directory, "utf-8", device, context, now);
      check(scan.State == "ready" && scan.Results[0].Count == 2 && scan.Files.Count == 2, "日志按北京时间跨午夜多文件滚动窗口与排除摘要");
      check(!System.Text.Json.JsonSerializer.Serialize(scan).Contains("secret"), "日志样例不包含原文和代理凭证");
      check(monitor.Scan(directory, "utf-8", device, context, now).Results[0].Count == 2, "重复扫描不重复累计");
      File.WriteAllText(Path.Combine(path, "Log20260915_5678.txt"), first + "\n");
      check(monitor.Scan(directory, "utf-8", device, context, now).Results[0].Count == 2, "同目录跨文件相同记录去重");
      File.AppendAllText(today, "2026-09-15 00:02:30.000 [1]没有可用的");
      check(monitor.Scan(directory, "utf-8", device, context, now).State == "catching_up", "半行不误判为检测正常");
      File.AppendAllText(today, "代理\n");
      check(monitor.Scan(directory, "utf-8", device, context, now).Results[0].Count == 3, "尾行补完仅累计一次");
      var second = directory with { DirectoryId = Guid.NewGuid().ToString() };
      check(monitor.Scan(second, "utf-8", device, context, now).Results[0].Count == 3, "实例之间独立计数");
      var changed = new MonitorContext(new string('b', 64), [rule with { Keywords = ["购买异常"], Excludes = [] }]);
      check(monitor.Scan(directory, "utf-8", device, changed, now).Results[0].Count == 1, "规则版本变化重新检查窗口");
      File.WriteAllText(today, "2026-09-15 00:02:50.000 [1]购买异常\n");
      check(monitor.Scan(directory, "utf-8", device, changed, now).State == "ready", "日志截断重写可继续读取");
      var xmlPath = Path.Combine(root, "monitor-xml"); Directory.CreateDirectory(xmlPath);
      var xmlFile = Path.Combine(xmlPath, "Log20260915_4321.txt");
      File.WriteAllText(xmlFile, "2026-09-15 00:01:00.000 [1]购买异常\n");
      var xmlDirectory = new DirectoryConfig(Guid.NewGuid().ToString(), "多行响应实例", xmlPath);
      check(monitor.Scan(xmlDirectory, "utf-8", device, changed, now).State == "ready", "时间戳记录首次扫描正常");
      File.AppendAllText(xmlFile, "<response>\n<message>购买异常</message>\n</response>\n2026-09-15 00:02:00.000 [1]购买异常\n");
      var xmlScan = monitor.Scan(xmlDirectory, "utf-8", device, changed, now);
      check(xmlScan.State == "ready" && xmlScan.Results[0].Count == 2, "跨扫描的XML续行不标解析异常且不参与规则计数");
      var leadingXmlPath = Path.Combine(root, "monitor-leading-xml"); Directory.CreateDirectory(leadingXmlPath);
      File.WriteAllText(Path.Combine(leadingXmlPath, "Log20260915_4322.txt"), "<response>\n</response>\n2026-09-15 00:02:00.000 [1]购买异常\n");
      check(monitor.Scan(new(Guid.NewGuid().ToString(), "无起始时间实例", leadingXmlPath), "utf-8", device, changed, now).State == "invalid", "文件开头无时间戳的XML仍标解析异常");
      File.AppendAllText(today, "broken line\n");
      check(monitor.Scan(directory, "utf-8", device, changed, now).State == "invalid", "坏行标记无法检测");
      check(monitor.Scan(directory with { Path = path + "missing" }, "utf-8", device, context, now).State == "missing", "缺失目录可见");
      store.AddTransport(100, 200); check(store.Transport() == (100, 200), "采集器正文双向计数");
      var report = new MonitorReport(Guid.NewGuid().ToString(), context.Revision, now.AddMinutes(-1).ToString("O"), now.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), new(1, 2, 3, 4, "complete"), [scan]);
      store.EnqueueMonitor(report); store.EnqueueMonitor(report);
      check(store.PendingMonitor().Count == 1, "监控队列幂等");
    }
    using (var store = new QueueStore(db, protector)) {
      check(store.PendingMonitor().Count == 1 && store.HasEvents(), "重启保留监控队列并保护设备身份");
      check(store.MonitorCounts(now.AddDays(91)).Expired == 1 && store.PendingMonitor().Count == 0, "90天过期计数与队列清理");
    }
    var samplePath = Environment.GetEnvironmentVariable("MONITOR_SAMPLE_PATH");
    if (!string.IsNullOrWhiteSpace(samplePath)) {
      var replay = Path.Combine(root, "real-log-replay"); Directory.CreateDirectory(replay);
      File.Copy(samplePath, Path.Combine(replay, "Log20260913_8880.txt"));
      using var replayStore = new QueueStore(Path.Combine(root, "replay.sqlite"), new TestProtector());
      var replayRules = new[] { "监控库存异常", "没有可用的启动代理", "没有可用的监控代理" }.Select(k => rule with { Id = Guid.NewGuid().ToString(), Keywords = [k], Excludes = [] }).ToList();
      var observation = new LogMonitor(replayStore).Scan(new(Guid.NewGuid().ToString(), "离线回放", replay), "utf-8", device, new(new string('c', 64), replayRules), new DateTimeOffset(2026, 9, 13, 23, 59, 58, 292, TimeSpan.FromHours(8)));
      check(observation.State == "ready" && observation.Results.Select(r => r.Count).SequenceEqual(new[] { 13, 2, 0 }), "附件真实日志离线回放与独立统计一致，无网络上传");
    }
    var traffic = new TrafficMonitor();
    List<InterfaceCounter> Network(long received, long sent, string id = "eth") => [new(id, "网卡", true, received, sent), new("virtual", "内部网卡", false, 999, 999)];
    check(traffic.Sample(Network(100, 200), [], (0, 0), now).Quality == "gap", "首次流量不冒认历史累计");
    var delta = traffic.Sample(Network(400, 600), [], (10, 20), now.AddMinutes(1));
    check(delta.Quality == "complete" && delta.ReceivedBytes == 300 && delta.SentBytes == 400 && delta.CollectorReceivedBytes == 10, "默认出口差值及采集器正文分别统计");
    check(traffic.Sample(Network(1, 2), [], (20, 30), now.AddMinutes(2)).Quality == "gap", "计数重置标记缺口");
    check(traffic.Sample(Network(100, 200, "new"), [], (20, 30), now.AddMinutes(3)).Quality == "gap", "网卡替换不抬高流量");
    check(traffic.Sample(Network(1000, 2000, "new"), [], (20, 30), now.AddMinutes(10)).Quality == "gap", "采样中断不标完整");
    check(traffic.Sample(Network(1000, 2000), ["missing"], (20, 30), now.AddMinutes(11)).Quality == "unavailable", "指定网卡缺失不自动换口径");
  }
}
