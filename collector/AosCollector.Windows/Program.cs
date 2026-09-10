using System.ServiceProcess;

namespace AosCollector.Windows;

internal static class Program
{
  [STAThread]
  private static void Main(string[] args)
  {
    try {
      if (args.Contains("--service")) { ServiceBase.Run(new CollectorService()); return; }
      ApplicationConfiguration.Initialize();
      if (args.Contains("--install") || args.Contains("--uninstall") || !Installer.IsInstalled()) Application.Run(new SetupForm(args.Contains("--uninstall")));
      else Application.Run(new MainForm(args.Contains("--tray")));
    } catch (Exception) {
      if (!args.Contains("--service")) MessageBox.Show("采集器启动失败，请检查安装和本地数据目录权限。原有队列保留。", "AOS 采集器", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
  }
}
