using AosCollector.Core;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace AosCollector.Windows;

// 每个GUI进程一个本机管道；SYSTEM跨桌面请求退出，不依赖会话窗口枚举。
internal sealed class TrayControl : IDisposable
{
  private readonly CancellationTokenSource cancellation = new();
  private readonly Task server;
  private static string Name(int pid) => $"AppleOrderMgr.AosCollector.Tray.{pid}";
  public TrayControl(Func<Task<bool>> requestClose, Action close) { server = Serve(requestClose, close, cancellation.Token); }
  private static PipeSecurity Security()
  {
    var security = new PipeSecurity();
    foreach (var sid in new[] { WellKnownSidType.BuiltinAdministratorsSid, WellKnownSidType.LocalSystemSid })
      security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
    security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
    return security;
  }
  private static async Task Serve(Func<Task<bool>> prepare, Action close, CancellationToken token)
  {
    while (!token.IsCancellationRequested) {
      try {
        using var pipe = NamedPipeServerStreamAcl.Create(Name(Environment.ProcessId), PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 256, 256, Security());
        await pipe.WaitForConnectionAsync(token);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(5));
        var command = new byte[1];
        if (await pipe.ReadAsync(command, timeout.Token) != 1 || command[0] != 1) continue;
        var accepted = await prepare();
        await pipe.WriteAsync(new byte[] { accepted ? (byte)1 : (byte)0 }, timeout.Token);
        if (accepted) close();
      } catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
      catch (Exception) { try { await Task.Delay(200, token); } catch (OperationCanceledException) { break; } }
    }
  }
  public static bool RequestClose(int pid)
  {
    try {
      using var pipe = new NamedPipeClientStream(".", Name(pid), PipeDirection.InOut, PipeOptions.Asynchronous);
      using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
      pipe.ConnectAsync(timeout.Token).GetAwaiter().GetResult();
      pipe.WriteAsync(new byte[] { 1 }, timeout.Token).GetAwaiter().GetResult();
      var response = new byte[1];
      if (pipe.ReadAsync(response, timeout.Token).GetAwaiter().GetResult() != 1 || response[0] != 1) throw new CollectorException("TRAY_BUSY");
      return true;
    } catch (CollectorException) { throw; }
    catch (Exception) { return false; }
  }
  public void Dispose() { cancellation.Cancel(); /* 不阻塞GUI回调；异步服务器随取消收尾。 */ }
}
