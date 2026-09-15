namespace AosCollector.Core;

public sealed record MonitorConfig(List<DirectoryConfig> Directories, List<string> InterfaceIds);
public sealed record MonitorRule(string Id, int Version, string Name, bool Enabled, string Mode, List<string> Keywords, List<string> Excludes, int WindowMinutes, int Threshold, string Severity, List<string> DeviceIds, List<string> DirectoryIds);
public sealed record MonitorContext(string Revision, List<MonitorRule> Rules);
public sealed record MonitorSample(string At, string File, List<string> Keywords);
public sealed record MonitorResult(string RuleId, int Count, List<MonitorSample> Samples);
public sealed record MonitorObservation(string LocalId, string Label, string State, List<string> Files, List<MonitorResult> Results);
public sealed record TrafficDelta(long ReceivedBytes, long SentBytes, long CollectorReceivedBytes, long CollectorSentBytes, string Quality);
public sealed record MonitorReport(string Id, string Revision, string StartedAt, string EndedAt, TrafficDelta Traffic, List<MonitorObservation> Instances);
public sealed record MonitorReceipt(List<string> Accepted);
public sealed record MonitorStatus(string State, string? LastScanAt, string? LastUploadAt, int Pending, long Expired, List<MonitorObservation> Instances, TrafficDelta? Traffic, string? Revision);
public sealed record InterfaceCounter(string Id, string Name, bool DefaultRoute, long Received, long Sent);
