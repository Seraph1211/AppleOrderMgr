using System.ServiceProcess;

namespace AosCollector.Windows;

internal static class Program
{
  [STAThread]
  private static void Main(string[] args)
  {
    try {
      if (args.Contains("--refresh-updater")) { UpdateAgent.RefreshInstalledUpdater(); return; }
      if (args.Contains("--update-agent")) { UpdateAgent.RunOnce().GetAwaiter().GetResult(); return; }
      if (args.Contains("--install-silent")) {
        var keyIndex = Array.IndexOf(args, "--update-public-key");
        if (keyIndex < 0 || keyIndex + 1 >= args.Length || !File.Exists(args[keyIndex + 1])) throw new AosCollector.Core.CollectorException("UPDATE_PUBLIC_KEY_REQUIRED");
        using var gate = UpdateAgent.AcquireGate(30000);
        UpdateAgent.CloseTray(); Installer.Install(); UpdateAgent.Install(args[keyIndex + 1]); return;
      }
      if (args.Contains("--service")) { ServiceBase.Run(new CollectorService()); return; }
      ApplicationConfiguration.Initialize();
      if (args.Contains("--install") || args.Contains("--uninstall") || !Installer.IsInstalled()) Application.Run(new SetupForm(args.Contains("--uninstall")));
      else Application.Run(new MainForm(args.Contains("--tray")));
    } catch (Exception) {
      if (args.Contains("--install-silent") || args.Contains("--update-agent") || args.Contains("--refresh-updater")) { Environment.ExitCode = 1; return; }
      if (!args.Contains("--service")) MessageBox.Show("采集器启动失败，请检查安装和本地数据目录权限。原有队列保留。", "AOS 采集器", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
  }
}
