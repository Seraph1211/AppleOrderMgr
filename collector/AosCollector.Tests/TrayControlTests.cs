using AosCollector.Core;
using AosCollector.Windows;
using System.IO.Pipes;

internal static class TrayControlTests
{
  public static async Task RunAsync(Action<bool, string> check)
  {
    foreach (var accepted in new[] { true, false }) {
      using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
      var pid = Random.Shared.Next(1000000, int.MaxValue);
      using var server = new NamedPipeServerStream($"AppleOrderMgr.AosCollector.Tray.{pid}", PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
      var peer = Task.Run(async () => {
        await server.WaitForConnectionAsync(timeout.Token);
        var command = new byte[1];
        if (await server.ReadAsync(command, timeout.Token) != 1 || command[0] != 1) throw new InvalidOperationException("退出协议不匹配");
        // 确保客户端读取时I/O尚未完成，复现直接读取ValueTask结果的实机缺陷。
        await Task.Delay(100, timeout.Token);
        await server.WriteAsync(new byte[] { accepted ? (byte)1 : (byte)0 }, timeout.Token);
      }, timeout.Token);
      try {
        var result = await Task.Run(() => TrayControl.RequestClose(pid), timeout.Token);
        check(accepted && result, "退出管道等待延迟回执完成");
      } catch (CollectorException e) when (!accepted) {
        check(e.Code == "TRAY_BUSY", "退出管道保留忙碌拒绝结果");
      } finally {
        await peer;
      }
    }
  }
}
