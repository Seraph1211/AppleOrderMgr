using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace AosCollector.Core;

public sealed class FullLogScanner(QueueStore store, long maxQueueBytes = QueueStore.MAX_LOG_QUEUE_BYTES)
{
  private const int FRAGMENT_BYTES = 8000;
  private const int FILE_READ_BUDGET = 2 * 1024 * 1024;
  private const int LANE_READ_BUDGET = 8 * 1024 * 1024;
  private static readonly Regex FileName = new(@"^Log(\d{8})_[A-Za-z0-9_-]+\.txt$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
  private static readonly Regex Header = new(@"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+\[[^\]\r\n]*\]\[([0-9]{1,64})\]", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
  private static readonly Regex Xml = new(@"^\s*<[/!?A-Za-z_:]", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
  public static string FirstDate(DateTimeOffset now) => Protocol.BusinessDate(now.AddDays(-29));
  private static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value));
  private static string Key(string localId, string path, string encoding) => "full-log:" + localId + ":" + Hash(Encoding.UTF8.GetBytes(Path.GetFullPath(path) + ":" + encoding));
  private static string Checkpoint(FileStream stream, long offset)
  {
    stream.Position = Math.Max(0, offset - 128); var bytes = new byte[(int)(offset - stream.Position)]; stream.ReadExactly(bytes); return Hash(bytes);
  }
  private static string? FileDate(string path)
  {
    var match = FileName.Match(Path.GetFileName(path));
    return match.Success && DateTime.TryParseExact(match.Groups[1].Value, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) ? day.ToString("yyyy-MM-dd") : null;
  }
  public FullLogState Scan(DirectoryConfig directory, string encodingName, DateTimeOffset now, CancellationToken token = default)
  {
    var dates = new HashSet<string>(); long total = 0, scanned = 0; var issues = 0; var count = 0; var state = "ready";
    var expired = store.ExpireFullLogs(FirstDate(now));
    try {
      if (!Directory.Exists(directory.Path)) return new(directory.DirectoryId, directory.Label, "missing", [], 0, 0, 0, store.FullLogCounts(directory.DirectoryId).Pending, 0, expired);
      var today = Protocol.BusinessDate(now); var first = FirstDate(now);
      var paths = Directory.EnumerateFiles(directory.Path, "Log*.txt").Select(path => (Path: path, Day: FileDate(path)))
        .Where(file => file.Day != null && string.CompareOrdinal(file.Day, first) >= 0 && string.CompareOrdinal(file.Day, today) <= 0)
        .OrderByDescending(file => file.Day).ThenBy(file => file.Path, StringComparer.OrdinalIgnoreCase).ToList();
      var liveBudget = LANE_READ_BUDGET; var historyBudget = LANE_READ_BUDGET;
      // 同一天内轮转起点，持续写入的第一个文件不能饿死其余实例文件。
      var rotationKey = "full-log-rotation:" + directory.DirectoryId;
      var rotation = store.GetState<int>(rotationKey);
      var ordered = paths.GroupBy(file => file.Day).SelectMany(group => { var list = group.ToList(); var start = list.Count == 0 ? 0 : rotation % list.Count; return list.Skip(start).Concat(list.Take(start)); }).ToList();
      store.SetState(rotationKey, rotation == int.MaxValue ? 0 : rotation + 1);
      foreach (var file in ordered) {
        token.ThrowIfCancellationRequested(); count++; dates.Add(file.Day!);
        try {
          var info = new FileInfo(file.Path); total += info.Length;
          var key = Key(directory.DirectoryId, file.Path, encodingName);
          var cursor = store.GetState<FullLogCursor>(key);
          var live = file.Day == today; var budget = live ? liveBudget : historyBudget;
          if (budget > 0 && store.FullLogCounts().Bytes < maxQueueBytes - (live ? 0 : Math.Min(maxQueueBytes / 4, 32L * 1024 * 1024))) {
            var before = cursor?.Offset ?? 0;
            cursor = Read(directory, file.Path, file.Day!, encodingName, now, key, cursor, Math.Min(FILE_READ_BUDGET, budget), token);
            var used = (int)Math.Min(FILE_READ_BUDGET, Math.Max(0, cursor.Offset - before));
            if (live) liveBudget -= Math.Max(used, 1); else historyBudget -= Math.Max(used, 1);
          }
          scanned += Math.Min(cursor?.Offset ?? 0, info.Length); issues += cursor?.Issues ?? 0;
        } catch (OperationCanceledException) { throw; }
        catch (UnauthorizedAccessException) { issues++; state = "unreadable"; }
        catch (IOException) { issues++; state = "unreadable"; }
        catch (Exception) { issues++; state = "error"; }
      }
      var pending = store.FullLogCounts(directory.DirectoryId).Pending;
      if (state == "ready") state = paths.Count == 0 ? "missing" : store.FullLogCounts().Bytes >= maxQueueBytes ? "backpressure" : scanned < total || pending > 0 ? "catching_up" : "ready";
      return new(directory.DirectoryId, directory.Label, state, dates.Order().ToList(), count, total, scanned, pending, issues, expired);
    } catch (OperationCanceledException) { throw; }
    catch (UnauthorizedAccessException) { return new(directory.DirectoryId, directory.Label, "unreadable", dates.ToList(), count, total, Math.Min(scanned, total), store.FullLogCounts(directory.DirectoryId).Pending, issues + 1, expired); }
    catch (Exception) { return new(directory.DirectoryId, directory.Label, "error", dates.ToList(), count, total, Math.Min(scanned, total), store.FullLogCounts(directory.DirectoryId).Pending, issues + 1, expired); }
  }
  private FullLogCursor Read(DirectoryConfig directory, string path, string fileDate, string encodingName, DateTimeOffset now, string stateKey, FullLogCursor? saved, int budget, CancellationToken token)
  {
    var info = new FileInfo(path);
    using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    var cursor = saved;
    if (cursor == null || cursor.Created != info.CreationTimeUtc.Ticks || stream.Length < cursor.Offset || Checkpoint(stream, cursor.Offset) != cursor.Checkpoint || (stream.Length == cursor.Length && info.LastWriteTimeUtc.Ticks != cursor.Modified))
      cursor = new(Guid.NewGuid().ToString(), info.CreationTimeUtc.Ticks, 0, Hash([]), 0, 0, 1, 0, null, null, "unparsed", null, null, 0);
    stream.Position = cursor.Offset;
    var bytes = new byte[(int)Math.Min(budget, stream.Length - cursor.Offset)]; stream.ReadExactly(bytes);
    Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    var encoding = encodingName == "gb18030" ? Encoding.GetEncoding("gb18030", EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback) : new UTF8Encoding(false, true);
    var offset = 0; var entries = new List<FullLogEntry>();
    while (offset < bytes.Length) {
      token.ThrowIfCancellationRequested();
      var available = Math.Min(FRAGMENT_BYTES, bytes.Length - offset);
      var newline = Array.IndexOf(bytes, (byte)'\n', offset, available);
      var length = newline >= 0 ? newline - offset + 1 : available;
      var eof = cursor.Offset + offset + length == stream.Length;
      // 活跃文件的短尾行等待稳定，长行允许分片，绝不截断。
      if (newline < 0 && eof && length < FRAGMENT_BYTES && now.UtcDateTime - info.LastWriteTimeUtc < TimeSpan.FromSeconds(5)) break;
      string? message = null; string? raw = null;
      for (var trim = 0; trim <= (newline < 0 ? 3 : 0) && trim < length; trim++) {
        try { message = encoding.GetString(bytes, offset, length - trim); length -= trim; break; }
        catch (DecoderFallbackException) { }
      }
      if (message == null) {
        // 文件末尾尚未写完整的单个编码字符，等待后续追加。
        if (newline < 0 && length <= 3 && now.UtcDateTime - info.LastWriteTimeUtc < TimeSpan.FromMinutes(1)) break;
        raw = Convert.ToBase64String(bytes, offset, length);
        message = Encoding.UTF8.GetString(bytes, offset, length);
      }
      if (raw == null && cursor.PartIndex == 0 && newline < 0 && message.Length < 256) {
        var prefix = message.TrimStart('\uFEFF');
        if (prefix.Length >= 23 && DateTime.TryParseExact(prefix[..23], "yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) {
          var suffix = prefix[23..].TrimStart();
          if (suffix.StartsWith('[')) {
            var close = suffix.IndexOf(']');
            var rest = close < 0 ? "" : suffix[(close + 1)..];
            if (close < 0 || rest.Length == 0 || (rest.StartsWith('[') && !rest.Contains(']'))) break;
          }
        }
      }
      if (message.Contains('\0')) { raw ??= Convert.ToBase64String(bytes, offset, length); message = message.Replace("\0", "\\0"); }
      var at = cursor.At; var account = cursor.Account; var parse = cursor.ParseState;
      var parentAt = cursor.ParentAt; var parentAccount = cursor.ParentAccount;
      if (cursor.PartIndex == 0) {
        at = null; account = null; parse = "unparsed";
        var text = message.TrimStart('\uFEFF');
        if (text.Length >= 23 && DateTime.TryParseExact(text[..23], "yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture, DateTimeStyles.None, out var local)) {
          var parsed = new DateTimeOffset(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), TimeSpan.FromHours(8));
          if (parsed <= now.AddMinutes(1)) {
            at = parsed.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); parse = "parsed";
            var match = Header.Match(text); account = match.Success ? match.Groups[1].Value : null;
          }
          parentAt = at; parentAccount = account;
        } else if (parentAt != null && Xml.IsMatch(text)) { at = parentAt; account = parentAccount; parse = "continuation"; }
        else { parentAt = null; parentAccount = null; }
      }
      if (raw != null) { at = null; account = null; parentAt = null; parentAccount = null; parse = "encoding_error"; }
      var day = at == null ? fileDate : Protocol.BusinessDate(DateTimeOffset.Parse(at, CultureInfo.InvariantCulture));
      var sortAt = at ?? cursor.LastSortAt;
      if (sortAt != null && Protocol.BusinessDate(DateTimeOffset.Parse(sortAt, CultureInfo.InvariantCulture)) != day) sortAt = null;
      entries.Add(new(Guid.NewGuid().ToString(), directory.DirectoryId, cursor.FileId, Path.GetFileName(path), day, at, account, cursor.LineNumber, cursor.PartIndex, cursor.Offset + offset, message, raw, parse, sortAt));
      offset += length;
      var ended = bytes[offset - 1] == '\n';
      cursor = cursor with { LineNumber = ended ? cursor.LineNumber + 1 : cursor.LineNumber, PartIndex = ended ? 0 : cursor.PartIndex + 1, At = at, Account = account, ParseState = parse, ParentAt = parentAt, ParentAccount = parentAccount, LastSortAt = at ?? cursor.LastSortAt, Issues = cursor.Issues + (raw != null || (parse == "unparsed" && cursor.PartIndex == 0) ? 1 : 0) };
    }
    var newOffset = cursor.Offset + offset;
    cursor = cursor with { Offset = newOffset, Checkpoint = Checkpoint(stream, newOffset), Length = stream.Length, Modified = info.LastWriteTimeUtc.Ticks };
    store.CommitFullLogs(stateKey, cursor, entries, fileDate); return cursor;
  }
}
