using System.Text.Json;
using System.Text.Json.Serialization;

namespace AosCollector.Core;

public static class Protocol
{
  public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
  public static string BusinessDate(DateTimeOffset? time = null) => (time ?? DateTimeOffset.UtcNow).ToOffset(TimeSpan.FromHours(8)).ToString("yyyy-MM-dd");
  public static string Now() => DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
}

public sealed record DirectoryConfig(string DirectoryId, string Label, string Path);
public sealed record CollectorConfig(string DeviceName, string ServerUrl, string Credential, string DeviceId, List<DirectoryConfig> Directories, string Encoding = "utf-8", MonitorConfig? Monitoring = null);
public sealed record DeviceIdentity(string Id, string Name, bool Enabled, int CredentialVersion);
public sealed record ScanRequest(string Id, string? BackfillId, string BusinessDate, string From, string ToExclusive, int SettingsVersion);
public sealed record CollectorContext(DeviceIdentity Device, int ProtocolVersion, string ServerTime, int SettingsVersion, string ActiveSource, string BusinessDate, string? CapturePermitId, List<ScanRequest> PendingScanRequests, ServerCounts? ServerCounts = null);
public sealed record UploadEvent(string EventId, string DirectoryId, string FileInstanceId, string FileName, int LineNumber, string ObservedAt, string? ScanRequestId, string? CapturePermitId, string RawLine);
public sealed record Receipt(string EventId, string ReceiptStatus, string? RecordId, string? ProcessingStatus, string? Eligibility, string? ErrorCode, bool Retryable);
public sealed record FileStatus(string Directory, string FileName, int Records, bool PendingTail, string? ErrorCode, string? WarningCode = null);
public sealed record DirectoryStatus(string DirectoryId, string Label, string State, List<string> CurrentFileNames, string? LastSuccessfulScanAt, string? ErrorCode);
public sealed record ServerCounts(int TodayReceived, int Created, int Duplicate, int ManualReview, int Paused);
public sealed record LocalCounts(int PendingUpload, int UploadError, int TodayDiscovered);
public sealed record ScanResult(string ScanRequestId, string Status, int DiscoveredCount, int ReceiptedCount, int PendingUploadCount, string? ErrorCode);
public sealed record HeartbeatRequest(string HeartbeatId, string AgentVersion, string OsVersion, string ObservedAt, string? LastSuccessfulScanAt, string? LastNewOrderAt, List<DirectoryStatus> Directories, LocalCounts LocalCounts, List<ScanResult> ScanResults);
public sealed record CollectorStatus(string ServiceState, string ConnectionState, string ActiveSource, string? LastScanAt, string? ErrorCode, LocalCounts Counts, List<DirectoryStatus> Directories, List<FileStatus> Files, string UpdatedAt, ServerCounts? ServerCounts = null, string? ServerSyncedAt = null, string AgentVersion = "1.2.0", int PendingPaymentCodes = 0, int PaymentCodeErrors = 0);
public interface IProtector { byte[] Protect(byte[] plain); byte[] Unprotect(byte[] encrypted); }
public sealed class CollectorException(string code, int? retryAfterSeconds = null) : Exception(code) { public string Code { get; } = code; public int? RetryAfterSeconds { get; } = retryAfterSeconds; }
