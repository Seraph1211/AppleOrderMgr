using System.Runtime.InteropServices;
using AosCollector.Core;
using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace AosCollector.Windows;

// 独立固定副本运行计划任务，不能替换自身。只安装受信发布清单指定的同产品程序。
internal static class UpdateAgent
{
  private static readonly string Root = Path.Combine(Installer.InstallDirectory, "Updater");
  private static readonly string JournalPath = Path.Combine(Root, "journal.json");
  internal static readonly string PublicKeyPath = Path.Combine(Root, "release-public.pem");
  private static readonly string CandidatePath = Path.Combine(Root, "candidate.exe");
  private static readonly string PreviousPath = Path.Combine(Root, "previous.exe");
  private const string TaskName = "AppleOrderMgr AOS Update";
  private sealed record Journal(string JobId, string TargetVersion, string PreviousVersion, string Phase, string? Error = null, bool TrayWasRunning = false);

  public static void Install(string keyPath)
  {
    var key = File.ReadAllText(keyPath);
    using (var rsa = System.Security.Cryptography.RSA.Create()) { rsa.ImportFromPem(key); if (rsa.KeySize < 2048) throw new CollectorException("UPDATE_PUBLIC_KEY_INVALID"); }
    Directory.CreateDirectory(Root);
    var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false);
    foreach (var sid in new[] { WellKnownSidType.BuiltinAdministratorsSid, WellKnownSidType.LocalSystemSid })
      acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    new DirectoryInfo(Root).SetAccessControl(acl);
    // 公钥固定在管理员保护目录，采集服务和源文件不能修改信任根。
    if (File.Exists(PublicKeyPath) && File.ReadAllText(PublicKeyPath) != key) throw new CollectorException("UPDATE_PUBLIC_KEY_CHANGED");
    File.WriteAllText(PublicKeyPath, key);
    var executable = Path.Combine(Root, "AosUpdater.exe");
    RefreshUpdater(executable);
    Run("schtasks.exe", "/Create", "/TN", TaskName, "/TR", $"\"{executable}\" --update-agent", "/SC", "MINUTE", "/MO", "1", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F");
  }
  private static void RefreshUpdater(string executable)
  {
    using var gate = AcquireGate(30000);
    var source = Installer.Executable;
    if (Path.GetFullPath(Environment.ProcessPath!).Equals(executable, StringComparison.OrdinalIgnoreCase)) return;
    if (File.Exists(executable)) {
      using var old = File.OpenRead(executable); using var current = File.OpenRead(source);
      if (System.Security.Cryptography.SHA256.HashData(old).SequenceEqual(System.Security.Cryptography.SHA256.HashData(current))) return;
    }
    var temporary = executable + ".new";
    File.Copy(source, temporary, true);
    File.Move(temporary, executable, true);
  }
  public static void RefreshInstalledUpdater()
  {
    // 由已安装并通过发布签名校验的程序执行。旧更新进程结束后再替换其固定副本。
    for (var attempt = 0; attempt < 12; attempt++) {
      try { if (File.Exists(PublicKeyPath)) { RefreshUpdater(Path.Combine(Root, "AosUpdater.exe")); } return; }
      catch (Exception) { Thread.Sleep(1000); }
    }
    throw new CollectorException("UPDATER_REFRESH_FAILED");
  }
  private sealed class Gate(Mutex mutex) : IDisposable
  {
    public void Dispose() { mutex.ReleaseMutex(); mutex.Dispose(); }
  }
  public static IDisposable AcquireGate(int timeout = 0)
  {
    var mutex = new Mutex(false, @"Global\AppleOrderMgrAosUpdater");
    try {
      bool acquired; try { acquired = mutex.WaitOne(timeout); } catch (AbandonedMutexException) { acquired = true; }
      if (!acquired) throw new CollectorException("UPDATE_IN_PROGRESS");
      return new Gate(mutex);
    } catch (Exception) { mutex.Dispose(); throw; }
  }
  private static void StartUpdaterRefresh()
  {
    Process.Start(new ProcessStartInfo(Installer.Executable, "--refresh-updater") { UseShellExecute = false, CreateNoWindow = true });
  }
  public static void StopAndExitOthers()
  {
    using var gate = AcquireGate();
    CloseTray();
    Installer.SetRunning(false);
  }
  public static void RemoveTask()
  {
    try { Run("schtasks.exe", "/Delete", "/TN", TaskName, "/F"); } catch (Exception) { }
  }
  private static void Run(string file, params string[] args)
  {
    var info = new ProcessStartInfo(file) { UseShellExecute = false, CreateNoWindow = true };
    foreach (var arg in args) info.ArgumentList.Add(arg);
    using var process = Process.Start(info) ?? throw new CollectorException("UPDATE_COMMAND_FAILED");
    if (!process.WaitForExit(30000) || process.ExitCode != 0) throw new CollectorException("UPDATE_COMMAND_FAILED");
  }
  private static void Save(Journal journal)
  {
    using (var stream = new FileStream(JournalPath + ".new", FileMode.Create, FileAccess.Write, FileShare.None)) {
      var bytes = JsonSerializer.SerializeToUtf8Bytes(journal, Protocol.Json); stream.Write(bytes); stream.Flush(true);
    }
    File.Move(JournalPath + ".new", JournalPath, true);
  }
  private static bool HasTray()
  {
    var found = false;
    foreach (var process in Process.GetProcessesByName("AosCollector")) {
      using (process) { if (process.Id != Environment.ProcessId && process.SessionId != 0 && StringComparer.OrdinalIgnoreCase.Equals(process.MainModule?.FileName, Installer.Executable)) found = true; }
    }
    return found;
  }
  private static void RestoreTray(Journal journal)
  {
    if (!journal.TrayWasRunning || HasTray()) return;
    try { Run("schtasks.exe", "/Run", "/TN", "AppleOrderMgr AOS Tray"); } catch (Exception) { }
  }
  private static string InstalledVersion() => (FileVersionInfo.GetVersionInfo(Installer.Executable).ProductVersion ?? "0.0.0").Split('+')[0];
  private delegate bool WindowVisitor(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visitor, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static void CloseTray()
  {
    foreach (var process in Process.GetProcessesByName("AosCollector")) {
      using (process) {
        if (process.Id == Environment.ProcessId || process.SessionId == 0) continue;
        if (!StringComparer.OrdinalIgnoreCase.Equals(process.MainModule?.FileName, Installer.Executable)) continue;
        // 发送自定义退出通知，GUI 保存中的操作由下一轮更新重试，禁止终止用户配置写入。
        if (!TrayControl.RequestClose(process.Id) && !process.HasExited) {
          // 仅用于旧版首次引导：安装程序须在同一交互会话运行。
          if (process.SessionId != Process.GetCurrentProcess().SessionId) throw new CollectorException("LEGACY_TRAY_SESSION");
          EnumWindows((window, _) => { GetWindowThreadProcessId(window, out var owner); if (owner == process.Id) PostMessageW(window, 0x8000 + 427, IntPtr.Zero, IntPtr.Zero); return true; }, IntPtr.Zero);
        }
        if (!process.WaitForExit(10000)) throw new CollectorException("TRAY_STILL_RUNNING");
      }
    }
  }
  private static async Task<bool> Healthy(string version)
  {
    for (var i = 0; i < 12; i++) {
      try {
        var status = await ServiceClient.Call(new { command = "status" });
        if (status.TryGetProperty("agentVersion", out var agent) && agent.GetString() == version &&
          status.GetProperty("serviceState").GetString() == "运行中" && status.GetProperty("connectionState").GetString() == "已连接" &&
          status.TryGetProperty("lastScanAt", out var scan) && scan.ValueKind == JsonValueKind.String) return true;
      } catch (Exception) { }
      await Task.Delay(2000);
    }
    return false;
  }
  public static Task RunOnce() => Task.Run(() => {
    // Mutex绑定线程；在同一线程取得和释放，异步网络逻辑在内部执行。
    try { using var gate = AcquireGate(); RunCore().GetAwaiter().GetResult(); }
    catch (Exception) { /* 保留阶段日志，下次计划任务继续恢复。 */ }
  });
  private static async Task RunCore()
  {
    try {
      var config = LocalStorage.ReadConfig();
      if (config == null || !File.Exists(PublicKeyPath)) return;
      using var accounting = new QueueStore(LocalStorage.QueuePath, LocalStorage.Protector);
      using var client = new CollectorClient(config, accounting: accounting);
      using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(8));
      var token = timeout.Token;
      Journal? journal = File.Exists(JournalPath) ? JsonSerializer.Deserialize<Journal>(File.ReadAllText(JournalPath), Protocol.Json) : null;
      // 崩溃后先恢复正在替换的程序，绝不恢复旧队列快照覆盖新数据。
      if (journal != null && journal.Phase == "preparing") {
        Installer.SetRunning(true);
        journal = journal with { Phase = "failed", Error = "UPDATE_PREPARATION_INTERRUPTED" }; Save(journal);
      }
      if (journal != null && journal.Phase is "backed_up" or "switched") {
        if (InstalledVersion() == journal.TargetVersion && await Healthy(journal.TargetVersion)) {
          journal = journal with { Phase = "succeeded" }; Save(journal);
        } else {
          Installer.SetRunning(false);
          File.Copy(PreviousPath, Installer.Executable, true);
          Installer.SetRunning(true);
          journal = journal with { Phase = "rolled_back", Error = "UPDATE_RECOVERED" }; Save(journal);
        }
      }
      if (journal != null && journal.Phase is "succeeded" or "failed" or "rolled_back") {
        RestoreTray(journal);
        await client.ReportUpdate(journal.JobId, journal.Phase, InstalledVersion(), journal.Error, token);
        File.Delete(JournalPath);
        if (journal.Phase == "succeeded") StartUpdaterRefresh();
      }
      // 人工停止服务时不领取更新，也不通过失败恢复逻辑将其重新启动。
      if (!Installer.IsRunning()) return;
      var offer = await client.GetUpdate(token);
      if (offer.Job == null || offer.Envelope == null) return;
      if (!Guid.TryParse(offer.Job.Id, out _)) throw new CollectorException("UPDATE_JOB_INVALID");
      var previous = InstalledVersion();
      journal = new(offer.Job.Id, offer.Job.ReleaseVersion, previous, "downloading");
      try {
        var manifest = UpdateManifest.Verify(offer.Envelope, File.ReadAllText(PublicKeyPath));
        if (manifest.Version != offer.Job.ReleaseVersion || Version.Parse(manifest.Version) < Version.Parse(previous)) throw new CollectorException("UPDATE_DOWNGRADE_REJECTED");
        if (offer.Job.Status != "installing") await client.ReportUpdate(offer.Job.Id, "downloading", previous, null, token);
        Save(journal);
        await client.DownloadUpdate(offer.Job.Id, CandidatePath, manifest.Size, token);
        manifest.VerifyPackage(CandidatePath);
        var candidateVersion = (FileVersionInfo.GetVersionInfo(CandidatePath).ProductVersion ?? "").Split('+')[0];
        if (candidateVersion != manifest.Version) throw new CollectorException("UPDATE_VERSION_MISMATCH");
        journal = journal with { TrayWasRunning = HasTray() }; Save(journal);
        CloseTray();
        await client.ReportUpdate(offer.Job.Id, "installing", previous, null, token);
        journal = journal with { Phase = "preparing" }; Save(journal);
        Installer.SetRunning(false);
        using (var input = File.OpenRead(Installer.Executable))
        using (var output = new FileStream(PreviousPath + ".new", FileMode.Create, FileAccess.Write, FileShare.None)) { input.CopyTo(output); output.Flush(true); }
        File.Move(PreviousPath + ".new", PreviousPath, true);
        journal = journal with { Phase = "backed_up" }; Save(journal);
        // 同卷替换，旧程序和持久化恢复记录在此前均已落盘。
        // 更新目录仅管理员/SYSTEM可读，不能把其ACL随候选文件带入服务安装目录。
        var installedAcl = new FileInfo(Installer.Executable).GetAccessControl();
        var stagedExecutable = Installer.Executable + ".update";
        File.Copy(CandidatePath, stagedExecutable, true);
        new FileInfo(stagedExecutable).SetAccessControl(installedAcl);
        File.Move(stagedExecutable, Installer.Executable, true);
        journal = journal with { Phase = "switched" }; Save(journal);
        Installer.SetRunning(true);
        if (!await Healthy(manifest.Version)) throw new CollectorException("UPDATE_HEALTH_FAILED");
        journal = journal with { Phase = "succeeded" }; Save(journal);
      } catch (Exception error) {
        var code = error is CollectorException c ? c.Code : "UPDATE_INSTALL_FAILED";
        if (journal.Phase == "downloading" && code == "UPDATE_DOWNLOAD_FAILED") return;
        if (journal.Phase is "backed_up" or "switched") {
          Installer.SetRunning(false); File.Copy(PreviousPath, Installer.Executable, true); Installer.SetRunning(true);
          journal = journal with { Phase = "rolled_back", Error = code };
        } else {
          // 在备份之前失败也要恢复可能已停止的原服务。
          try { Installer.SetRunning(true); } catch (Exception) { }
          journal = journal with { Phase = "failed", Error = code };
        }
        Save(journal);
      }
      RestoreTray(journal);
      await client.ReportUpdate(journal.JobId, journal.Phase, InstalledVersion(), journal.Error, token);
      File.Delete(JournalPath);
      if (journal.Phase == "succeeded") StartUpdaterRefresh();
    } catch (Exception) {
      // 计划任务无交互窗口；保留已落盘阶段，下一轮先恢复或重报。
    }
  }
}
