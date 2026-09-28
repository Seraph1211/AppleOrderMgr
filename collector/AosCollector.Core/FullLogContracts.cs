namespace AosCollector.Core;

public sealed record FullLogContext(bool Enabled, int RetentionDays);
public sealed record FullLogEntry(string Id, string LocalId, string FileId, string FileName, string BusinessDate, string? LoggedAt, string? AccountNumber, long LineNumber, int PartIndex, long ByteOffset, string Message, string? RawBase64, string ParseState, string? ContextAt = null);
public sealed record FullLogReceipt(List<string> Accepted, List<string> Expired);
public sealed record FullLogState(string LocalId, string Label, string State, List<string> Dates, int FileCount, long TotalBytes, long ScannedBytes, int Pending, int Issues, long Expired);
public sealed record FullLogStates(string ObservedAt, List<FullLogState> Instances);
public sealed record FullLogCursor(string FileId, long Created, long Offset, string Checkpoint, long Length, long Modified, long LineNumber, int PartIndex, string? At, string? Account, string ParseState, string? ParentAt, string? ParentAccount, int Issues, string? LastSortAt = null);
