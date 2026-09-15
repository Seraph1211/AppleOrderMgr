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
  private static readonly string PublicKeyPath = Path.Combine(Root, "release-public.pem");
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
    if (!File.Exists(executable)) File.Copy(Environment.ProcessPath!, executable);
    Run("schtasks.exe", "/Create", "/TN", TaskName, "/TR", $"\"{executable}\" --update-agent", "/SC", "MINUTE", "/MO", "1", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F");
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
        EnumWindows((window, _) => { GetWindowThreadProcessId(window, out var owner); if (owner == process.Id) PostMessageW(window, 0x8000 + 427, IntPtr.Zero, IntPtr.Zero); return true; }, IntPtr.Zero);
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
  public static async Task RunOnce()
  {
    using var mutex = new Mutex(false, @"Global\AppleOrderMgrAosUpdater");
    var acquired = false;
    try {
      try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
      if (!acquired) return;
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
      }
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
        File.Move(CandidatePath, Installer.Executable, true);
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
    } catch (Exception) {
      // 计划任务无交互窗口；保留已落盘阶段，下一轮先恢复或重报。
    } finally { if (acquired) mutex.ReleaseMutex(); }
  }
}
