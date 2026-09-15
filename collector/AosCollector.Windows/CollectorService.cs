using AosCollector.Core;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;

namespace AosCollector.Windows;

internal sealed class CollectorService : ServiceBase
{
  public const string NameValue = "AppleOrderMgrAosCollector";
  public const string PipeName = "AppleOrderMgr.AosCollector.v1";
  private CancellationTokenSource? shutdown;
  private CancellationTokenSource? engineCancellation;
  private Task? pipeTask;
  private Task? engineTask;
  private CollectorEngine? engine;
  private MonitorEngine? monitor;
  private Task? monitorTask;
  private QueueStore? queue;
  public CollectorService() { ServiceName = NameValue; CanStop = true; AutoLog = false; }
  protected override void OnStart(string[] args)
  {
    shutdown = new(); queue = new QueueStore(LocalStorage.QueuePath, LocalStorage.Protector);
    try { var config = LocalStorage.ReadConfig(); if (config != null) StartEngine(config); }
    catch (Exception) { /* 配置错误仍提供本地修复窗口，不输出敏感异常。 */ }
    pipeTask = Serve(shutdown.Token);
  }
  private void StartEngine(CollectorConfig config)
  {
    engineCancellation = new(); engine = new CollectorEngine(config, queue!);
    engineTask = Task.Run(() => engine.Run(engineCancellation.Token));
    monitor = new MonitorEngine(config, queue!); monitorTask = Task.Run(() => monitor.Run(engineCancellation.Token));
  }
  private async Task StopEngine()
  {
    try { engineCancellation?.Cancel(); await Task.WhenAll(new[] { engineTask, monitorTask }.OfType<Task>()); }
    catch (OperationCanceledException) { }
    finally { monitor?.Dispose(); monitor = null; monitorTask = null; engine?.Dispose(); engine = null; engineTask = null; engineCancellation?.Dispose(); engineCancellation = null; }
  }
  protected override void OnStop()
  {
    shutdown?.Cancel();
    try { RequestAdditionalTime(30000); StopEngine().GetAwaiter().GetResult(); pipeTask?.GetAwaiter().GetResult(); }
    catch (Exception) { }
    queue?.Dispose(); shutdown?.Dispose();
  }
  private static PipeSecurity Security()
  {
    var security = new PipeSecurity();
    foreach (var sid in new[] { WellKnownSidType.BuiltinAdministratorsSid, WellKnownSidType.LocalSystemSid, WellKnownSidType.LocalServiceSid })
      security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
    // 拒绝网络身份，命名管道仅用于本机 GUI。
    security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
    return security;
  }
  private async Task Serve(CancellationToken token)
  {
    while (!token.IsCancellationRequested) {
      try {
        using var pipe = NamedPipeServerStreamAcl.Create(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, Security());
        await pipe.WaitForConnectionAsync(token);
        using var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(30));
        var line = await reader.ReadLineAsync(timeout.Token);
        object response;
        try {
          if (line == null || line.Length > 65536) throw new CollectorException("LOCAL_REQUEST_INVALID");
          using var json = JsonDocument.Parse(line);
          response = new { success = true, data = await Handle(json.RootElement, timeout.Token) };
        } catch (CollectorException e) { response = new { success = false, error = e.Code }; }
        catch (Exception) { response = new { success = false, error = "LOCAL_OPERATION_FAILED" }; }
        await writer.WriteLineAsync(JsonSerializer.Serialize(response, Protocol.Json));
      } catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
      catch (Exception) { try { await Task.Delay(500, token); } catch (OperationCanceledException) { break; } }
    }
  }
  private async Task<object> Handle(JsonElement request, CancellationToken token)
  {
    try {
      var command = request.GetProperty("command").GetString();
      if (command == "status") return engine?.Status ?? new CollectorStatus("运行中", "等待配置", "unknown", null, null, queue!.Counts(), [], [], Protocol.Now());
      if (command == "monitor-status") return monitor?.Status ?? new MonitorStatus("等待配置", null, null, 0, 0, [], null, null);
      if (command == "interfaces") return TrafficMonitor.ReadInterfaces();
      if (command == "config") return LocalStorage.SafeConfig(LocalStorage.ReadConfig());
      if (command == "scan") { engine?.Signal(); return new { queued = true }; }
      if (command == "retry") { engine?.RetryConnection(); return new { queued = true }; }
      if (command is "test" or "save") {
        var candidate = request.GetProperty("config").Deserialize<CollectorConfig>(Protocol.Json) ?? throw new CollectorException("CONFIG_INVALID");
        var old = LocalStorage.ReadConfig();
        if (string.IsNullOrEmpty(candidate.Credential) && old != null) candidate = candidate with { Credential = old.Credential };
        if (candidate.DeviceName.Length is < 1 or > 100 || candidate.Directories.Count is < 1 or > 20 || candidate.Encoding is not "utf-8" and not "gb18030") throw new CollectorException("CONFIG_INVALID");
        foreach (var dir in candidate.Directories) {
          if (!Guid.TryParse(dir.DirectoryId, out _) || !Path.IsPathFullyQualified(dir.Path) || dir.Path.StartsWith(@"\\") || dir.Label.Length is < 1 or > 100 || dir.Label.IndexOfAny(['/', '\\']) >= 0) throw new CollectorException("DIRECTORY_INVALID");
          try { using var entries = Directory.EnumerateFiles(dir.Path, "AOS订单记录-*.txt").GetEnumerator(); if (entries.MoveNext()) { using var stream = new FileStream(entries.Current, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); stream.ReadByte(); } }
          catch (Exception) { throw new CollectorException("SERVICE_DIRECTORY_UNREADABLE"); }
        }
        var monitorDirs = candidate.Monitoring?.Directories ?? [];
        if (monitorDirs.Count > 20 || monitorDirs.Select(d => d.DirectoryId).Distinct().Count() != monitorDirs.Count || monitorDirs.Select(d => Path.GetFullPath(d.Path).TrimEnd('\\')).Distinct(StringComparer.OrdinalIgnoreCase).Count() != monitorDirs.Count || (candidate.Monitoring?.InterfaceIds.Count ?? 0) > 20) throw new CollectorException("CONFIG_INVALID");
        foreach (var dir in monitorDirs) {
          if (!Guid.TryParse(dir.DirectoryId, out _) || !Path.IsPathFullyQualified(dir.Path) || dir.Path.StartsWith(@"\\") || dir.Label.Length is < 1 or > 100 || dir.Label.IndexOfAny(['/', '\\']) >= 0) throw new CollectorException("DIRECTORY_INVALID");
          try { using var entries = Directory.EnumerateFiles(dir.Path, "Log*.txt").GetEnumerator(); if (entries.MoveNext()) { using var stream = new FileStream(entries.Current, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); stream.ReadByte(); } }
          catch (Exception) { throw new CollectorException("SERVICE_DIRECTORY_UNREADABLE"); }
        }
        using var client = new CollectorClient(candidate); var context = await client.Context(token);
        if (context.ProtocolVersion != 1) throw new CollectorException("UNSUPPORTED_SCHEMA_VERSION");
        candidate = candidate with { DeviceId = context.Device.Id };

        if (old != null && queue!.HasEvents() &&
          (!StringComparer.OrdinalIgnoreCase.Equals(old.ServerUrl.TrimEnd('/'), candidate.ServerUrl.TrimEnd('/')) || old.DeviceId != candidate.DeviceId)) throw new CollectorException("PENDING_QUEUE_IDENTITY_CHANGE");
        if (command == "save") {
          await StopEngine();
          try { LocalStorage.WriteConfig(candidate); StartEngine(candidate); }
          catch (Exception) { if (old != null) { LocalStorage.WriteConfig(old); StartEngine(old); } throw new CollectorException("CONFIG_SAVE_FAILED"); }
        }
        return new { device = context.Device.Name, activeSource = context.ActiveSource, directoriesReadable = true };
      }
      throw new CollectorException("LOCAL_COMMAND_INVALID");
    } catch (CollectorException) { throw; }
    catch (Exception) { throw new CollectorException("LOCAL_OPERATION_FAILED"); }
  }
}

internal static class ServiceClient
{
  public static async Task<JsonElement> Call(object request)
  {
    try {
      using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(35));
      using var pipe = new NamedPipeClientStream(".", CollectorService.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
      await pipe.ConnectAsync(timeout.Token);
      using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
      using var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true);
      await writer.WriteLineAsync(JsonSerializer.Serialize(request, Protocol.Json));
      var line = await reader.ReadLineAsync(timeout.Token) ?? throw new CollectorException("SERVICE_NOT_AVAILABLE");
      using var json = JsonDocument.Parse(line);
      if (!json.RootElement.GetProperty("success").GetBoolean()) throw new CollectorException(json.RootElement.GetProperty("error").GetString() ?? "LOCAL_OPERATION_FAILED");
      return json.RootElement.GetProperty("data").Clone();
    } catch (CollectorException) { throw; }
    catch (Exception) { throw new CollectorException("SERVICE_NOT_AVAILABLE"); }
  }
}
