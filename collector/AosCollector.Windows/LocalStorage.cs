using AosCollector.Core;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

namespace AosCollector.Windows;

internal sealed class WindowsProtector : IProtector
{
  public byte[] Protect(byte[] plain) => ProtectedData.Protect(plain, null, DataProtectionScope.LocalMachine);
  public byte[] Unprotect(byte[] encrypted) => ProtectedData.Unprotect(encrypted, null, DataProtectionScope.LocalMachine);
}
internal static class LocalStorage
{
  public static readonly string DataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "AppleOrderMgr", "AosCollector");
  public static string ConfigPath => Path.Combine(DataDirectory, "config.enc");
  public static string QueuePath => Path.Combine(DataDirectory, "queue.sqlite");
  public static readonly WindowsProtector Protector = new();
  public static void InitializeAcl()
  {
    Directory.CreateDirectory(DataDirectory);
    var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false);
    foreach (var sid in new[] { WellKnownSidType.BuiltinAdministratorsSid, WellKnownSidType.LocalSystemSid, WellKnownSidType.LocalServiceSid })
      security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    new DirectoryInfo(DataDirectory).SetAccessControl(security);
  }
  public static CollectorConfig? ReadConfig() => File.Exists(ConfigPath) ? JsonSerializer.Deserialize<CollectorConfig>(Protector.Unprotect(File.ReadAllBytes(ConfigPath)), Protocol.Json) : null;
  public static void WriteConfig(CollectorConfig config)
  {
    var temporary = ConfigPath + ".new";
    using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) {
      var bytes = Protector.Protect(JsonSerializer.SerializeToUtf8Bytes(config, Protocol.Json)); stream.Write(bytes); stream.Flush(true);
    }
    File.Move(temporary, ConfigPath, true);
  }
  public static object SafeConfig(CollectorConfig? config) => new { deviceName = config?.DeviceName ?? "", serverUrl = config?.ServerUrl ?? "", credentialConfigured = !string.IsNullOrEmpty(config?.Credential), deviceId = config?.DeviceId ?? "", directories = config?.Directories ?? [], encoding = config?.Encoding ?? "utf-8" };
}
