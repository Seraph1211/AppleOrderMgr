using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace AosCollector.Core;

public sealed class LogMonitor(QueueStore store)
{
  private const int READ_BUDGET = 64 * 1024 * 1024;
  private const int MAX_EVENTS = 100000;
  private static readonly Regex FileName = new(@"^Log[0-9]{8}_[A-Za-z0-9_-]+\.txt$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
  public sealed record Hit(string Key, DateTimeOffset At, string File, List<string> Rules, Dictionary<string, List<string>> Keywords);
  public sealed record Cursor(string Identity, long Offset, string Checkpoint, long Length, long Modified, bool Invalid);
  public sealed record ScanState(string Revision, Dictionary<string, Cursor> Cursors, List<Hit> Hits);
  public static bool Matches(MonitorRule rule, string line) => !rule.Excludes.Any(k => line.Contains(k, StringComparison.Ordinal)) && (rule.Mode == "all" ? rule.Keywords.All(k => line.Contains(k, StringComparison.Ordinal)) : rule.Keywords.Any(k => line.Contains(k, StringComparison.Ordinal)));
  public static bool Applies(MonitorRule rule, string deviceId, string localId) => rule.Enabled && (rule.DeviceIds.Count == 0 || rule.DeviceIds.Contains(deviceId)) && (rule.DirectoryIds.Count == 0 || rule.DirectoryIds.Contains(localId));
  private static string Digest(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
  private static string Checkpoint(FileStream stream, long offset)
  {
    stream.Position = Math.Max(0, offset - 128); var bytes = new byte[(int)(offset - stream.Position)]; stream.ReadExactly(bytes); return Digest(bytes);
  }
  public MonitorObservation Scan(DirectoryConfig directory, string encodingName, string deviceId, MonitorContext context, DateTimeOffset now)
  {
    var files = new List<string>(); var results = new List<MonitorResult>();
    try {
      if (!Directory.Exists(directory.Path)) return new(directory.DirectoryId, directory.Label, "missing", files, results);
      var rules = context.Rules.Where(r => Applies(r, deviceId, directory.DirectoryId)).ToList();
      var stateKey = "monitor-log:" + directory.DirectoryId;
      var revision = context.Revision + ":" + directory.Path + ":" + encodingName;
      var saved = store.GetState<ScanState>(stateKey);
      var state = saved?.Revision == revision ? saved : new ScanState(revision, [], []);
      var cutoff = now.AddMinutes(-60);
      var hits = state.Hits.Where(h => h.At >= cutoff && h.At <= now).ToDictionary(h => h.Key);
      var dates = new[] { Protocol.BusinessDate(now).Replace("-", ""), Protocol.BusinessDate(now.AddDays(-1)).Replace("-", "") };
      var paths = dates.SelectMany(day => Directory.EnumerateFiles(directory.Path, $"Log{day}_*.txt")).Where(path => FileName.IsMatch(Path.GetFileName(path))).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).Take(201).ToList();
      if (paths.Count > 200) return new(directory.DirectoryId, directory.Label, "catching_up", [], []);
      var current = paths.ToHashSet(StringComparer.OrdinalIgnoreCase);
      foreach (var old in state.Cursors.Keys.Where(k => !current.Contains(k)).ToList()) state.Cursors.Remove(old);
      Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
      var encoding = encodingName == "gb18030" ? Encoding.GetEncoding("gb18030", EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback) : new UTF8Encoding(false, true);
      var remaining = READ_BUDGET; var catchingUp = false; var unreadable = false;
      foreach (var path in paths) {
        var name = Path.GetFileName(path); files.Add(name);
        try {
          var info = new FileInfo(path); var identity = info.CreationTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture);
          using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
          state.Cursors.TryGetValue(path, out var cursor);
          if (cursor == null || cursor.Identity != identity || stream.Length < cursor.Offset || Checkpoint(stream, cursor.Offset) != cursor.Checkpoint || (stream.Length == cursor.Length && info.LastWriteTimeUtc.Ticks != cursor.Modified)) cursor = new(identity, 0, Digest([]), 0, 0, false);
          stream.Position = cursor.Offset;
          var bytes = new byte[(int)Math.Min(Math.Min(stream.Length - cursor.Offset, remaining), READ_BUDGET)];
          stream.ReadExactly(bytes); remaining -= bytes.Length;
          var lastNewline = Array.LastIndexOf(bytes, (byte)'\n'); var offset = 0; var invalid = cursor.Invalid;
          // 未写完整尾行保留在下一次读取，最多64KiB；不解码半个字符。
          if (lastNewline < 0 && bytes.Length > 65536) { invalid = true; lastNewline = bytes.Length - 1; }
          if (lastNewline >= 0) {
            while (offset <= lastNewline) {
              var end = Array.IndexOf(bytes, (byte)'\n', offset, lastNewline - offset + 1);
              if (end < 0) { invalid = true; offset = lastNewline + 1; break; }
              if (end - offset > 65536) { invalid = true; offset = end + 1; continue; }
              string line;
              try { line = encoding.GetString(bytes, offset, end - offset).TrimEnd('\r').TrimStart('\uFEFF'); }
              catch (DecoderFallbackException) { invalid = true; offset = end + 1; continue; }
              offset = end + 1;
              if (string.IsNullOrWhiteSpace(line)) continue;
              if (line.Length < 23 || !DateTime.TryParseExact(line[..23], "yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture, DateTimeStyles.None, out var local)) { invalid = true; continue; }
              var at = new DateTimeOffset(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), TimeSpan.FromHours(8));
              if (at > now.AddMinutes(1)) { invalid = true; continue; }
              if (at < cutoff || at > now) continue;
              var matched = rules.Where(r => Matches(r, line)).ToList(); if (matched.Count == 0) continue;
              var key = Digest(Encoding.UTF8.GetBytes(line));
              if (hits.Count >= MAX_EVENTS && !hits.ContainsKey(key)) { catchingUp = true; invalid = true; continue; }
              hits.TryAdd(key, new Hit(key, at, name, matched.Select(r => r.Id).ToList(), matched.ToDictionary(r => r.Id, r => r.Keywords.Where(k => line.Contains(k, StringComparison.Ordinal)).ToList())));
            }
          }
          var newOffset = cursor.Offset + offset;
          catchingUp |= stream.Length > newOffset;
          state.Cursors[path] = new(identity, newOffset, Checkpoint(stream, newOffset), stream.Length, info.LastWriteTimeUtc.Ticks, invalid);
        } catch (IOException) { unreadable = true; }
        catch (UnauthorizedAccessException) { unreadable = true; }
      }
      var observationState = unreadable ? "unreadable" : state.Cursors.Values.Any(c => c.Invalid) ? "invalid" : catchingUp ? "catching_up" : paths.Count == 0 ? "missing" : "ready";
      foreach (var rule in rules) {
        var found = hits.Values.Where(h => h.At >= now.AddMinutes(-rule.WindowMinutes) && h.Rules.Contains(rule.Id)).OrderByDescending(h => h.At).ToList();
        results.Add(new(rule.Id, found.Count, found.Where(h => files.Contains(h.File)).Take(1).Select(h => new MonitorSample(h.At.ToString("O"), h.File, h.Keywords[rule.Id].Take(1).ToList())).ToList()));
      }
      store.SetState(stateKey, state with { Hits = hits.Values.ToList() });
      return new(directory.DirectoryId, directory.Label, observationState, files, results);
    } catch (UnauthorizedAccessException) { return new(directory.DirectoryId, directory.Label, "unreadable", files, []); }
    catch (Exception) { return new(directory.DirectoryId, directory.Label, "invalid", files, []); }
  }
}
