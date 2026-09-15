using Microsoft.Win32;
using System.Diagnostics;
using System.Security.Cryptography;
using System.ServiceProcess;

namespace AosCollector.Windows;

internal static class Installer
{
  public static readonly string InstallDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "AppleOrderMgr", "AosCollector");
  public static string Executable => Path.Combine(InstallDirectory, "AosCollector.exe");
  private const string RegistryPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AppleOrderMgrAosCollector";
  public static bool IsInstalled() => ServiceController.GetServices().Any(service => { using (service) return service.ServiceName == CollectorService.NameValue; });
  private static void Run(string name, params string[] args)
  {
    var info = new ProcessStartInfo(name) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var arg in args) info.ArgumentList.Add(arg);
    using var process = Process.Start(info) ?? throw new InvalidOperationException();
    var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
    if (!process.WaitForExit(30000)) { process.Kill(); throw new System.TimeoutException(); }
    Task.WaitAll(stdout, stderr); if (process.ExitCode != 0) throw new InvalidOperationException("安装命令未成功");
  }
  public static bool IsRunning()
  {
    using var service = new ServiceController(CollectorService.NameValue);
    service.Refresh(); return service.Status == ServiceControllerStatus.Running;
  }
  public static void SetRunning(bool running)
  {
    using var service = new ServiceController(CollectorService.NameValue);
    service.Refresh();
    if (running && service.Status != ServiceControllerStatus.Running) { service.Start(); service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30)); }
    if (!running && service.Status != ServiceControllerStatus.Stopped) { service.Stop(); service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30)); }
  }
  public static void Install()
  {
    var existed = IsInstalled(); var source = Environment.ProcessPath ?? throw new InvalidOperationException();
    foreach (var process in Process.GetProcessesByName("AosCollector")) {
      using (process) {
        if (process.Id == Environment.ProcessId || process.SessionId == 0) continue;
        if (StringComparer.OrdinalIgnoreCase.Equals(process.MainModule?.FileName, Executable))
          throw new AosCollector.Core.CollectorException("TRAY_STILL_RUNNING");
      }
    }
    LocalStorage.InitializeAcl(); Directory.CreateDirectory(InstallDirectory);
    if (existed) SetRunning(false);
    var replacing = !Path.GetFullPath(source).Equals(Executable, StringComparison.OrdinalIgnoreCase);
    try {
      if (replacing) {
        var temp = Executable + ".new"; File.Copy(source, temp, true);
        using var a = File.OpenRead(source); using var b = File.OpenRead(temp);
        if (!SHA256.HashData(a).SequenceEqual(SHA256.HashData(b))) throw new IOException();
        a.Dispose(); b.Dispose();
        if (File.Exists(Executable)) File.Copy(Executable, Executable + ".previous", true);
        File.Move(temp, Executable, true);
      }
      if (!existed) Run("sc.exe", "create", CollectorService.NameValue, "binPath=", $"\"{Executable}\" --service", "start=", "auto", "obj=", @"NT AUTHORITY\LocalService", "DisplayName=", "Apple 订单 AOS 采集服务");
      Run("sc.exe", "failure", CollectorService.NameValue, "reset=", "86400", "actions=", "restart/5000/restart/10000/restart/60000");
      using var registry = Registry.LocalMachine.CreateSubKey(RegistryPath);
      registry.SetValue("DisplayName", "Apple 订单 AOS 采集器"); registry.SetValue("DisplayVersion", "1.2.3"); registry.SetValue("Publisher", "AppleOrderMgr");
      registry.SetValue("InstallLocation", InstallDirectory); registry.SetValue("UninstallString", $"\"{Executable}\" --uninstall"); registry.SetValue("ModifyPath", $"\"{Executable}\" --install");
      registry.SetValue("NoRepair", 0, RegistryValueKind.DWord);
      // 当前管理员交互登录后启动托盘，窗口退出不停止后台服务。
      Run("schtasks.exe", "/Create", "/TN", "AppleOrderMgr AOS Tray", "/TR", $"\"{Executable}\" --tray", "/SC", "ONLOGON", "/RL", "HIGHEST", "/IT", "/F");
      SetRunning(true);
    } catch (Exception) {
      if (existed && File.Exists(Executable + ".previous") && replacing) File.Copy(Executable + ".previous", Executable, true);
      if (existed) { try { SetRunning(true); } catch (Exception) { } }
      throw;
    }
  }
  public static void Uninstall()
  {
    UpdateAgent.RemoveTask();
    if (IsInstalled()) { SetRunning(false); Run("sc.exe", "delete", CollectorService.NameValue); }
    try { Run("schtasks.exe", "/Delete", "/TN", "AppleOrderMgr AOS Tray", "/F"); } catch (Exception) { }
    Registry.LocalMachine.DeleteSubKeyTree(RegistryPath, false);
    // 正在运行的卸载程序不能可靠自删；保留二进制供重装，队列及配置始终保留。
  }
}
internal sealed class SetupForm : Form
{
  public SetupForm(bool uninstall)
  {
    Text = uninstall ? "卸载 AOS 采集器" : "安装 / 修复 AOS 采集器"; Width = 580; Height = 340; StartPosition = FormStartPosition.CenterScreen; BackColor = Color.White;
    var text = new Label { Dock = DockStyle.Top, Height = 165, Padding = new Padding(24), Text = uninstall ? "将停止并注销 AOS 后台服务、移除登录托盘任务。\n\n本地配置和待发送队列保留，可在重新安装后恢复。程序文件保留在安装目录。" : "AOS 采集器 1.2.3 · Windows x64\n\n安装配置窗口、系统托盘与开机运行的后台服务。包含运行依赖。升级保留本地配置、设备身份和待发送队列。\n\n目录和服务器地址将在配置窗口中设置。" };
    var button = new Button { Text = uninstall ? "确认卸载，保留队列" : "安装 / 修复", Dock = DockStyle.Bottom, Height = 48 };
    button.Click += async (_, _) => {
      button.Enabled = false;
      try {
        await Task.Run(() => {
          using var gate = UpdateAgent.AcquireGate(30000);
          if (uninstall) Installer.Uninstall();
          else {
            Installer.Install();
            var publicKey = Path.Combine(AppContext.BaseDirectory, "release-public.pem");
            if (File.Exists(publicKey)) UpdateAgent.Install(publicKey);
          }
        });
        MessageBox.Show(uninstall ? "服务已卸载，队列与配置保留。" : "安装完成，可打开配置窗口。", "AOS 采集器");
        if (!uninstall) Process.Start(new ProcessStartInfo(Installer.Executable) { UseShellExecute = true }); Close();
      } catch (AosCollector.Core.CollectorException e) when (e.Code == "TRAY_STILL_RUNNING") { MessageBox.Show("请先保存配置并在托盘菜单选择退出，再安装或修复。后台队列会保留。", "AOS 采集器"); button.Enabled = true; }
      catch (Exception) { MessageBox.Show("安装操作未完成。请检查管理员权限、服务状态和目录权限；已有配置与队列保留。", "AOS 采集器", MessageBoxButtons.OK, MessageBoxIcon.Error); button.Enabled = true; }
    };
    Controls.Add(text); Controls.Add(button);
  }
}
