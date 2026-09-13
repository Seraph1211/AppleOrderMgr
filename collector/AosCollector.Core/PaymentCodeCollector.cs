using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace AosCollector.Core;

public sealed record PaymentCodeEvent(string EventId, string OrderNumber, string OrderDate, string SourceTime, string ContactEmail, string AppleId, string PaymentMethod, string ImageDataUrl);
public sealed record SuccessCandidate(string OrderNumber, string Clock, string AppleId, string ContactEmail, string LastName, string FirstName, string Phone, string Store, string Products, string Tag, string IdLast4, string ImageDataUrl);

public static class PaymentCodeParser
{
  public static SuccessCandidate? Parse(string line)
  {
    // 仅分割固定前 29 项，保留 Data URL 自身的逗号。
    var f = line.Split(',', 30);
    if (f.Length != 30 || !Regex.IsMatch(f[26], @"^/W\d{10}$")) throw new CollectorException("SUCCESS_RECORD_INVALID");
    if (f[19] == "支付宝") return null;
    if (f[19] != "微信" || !f[29].StartsWith("data:image/png;base64,")) throw new CollectorException("PAYMENT_IMAGE_MISSING");
    var clock = Regex.Match(f[0], @"^\d{2}:\d{2}:\d{2}\.\d{3}");
    if (!clock.Success || f[29].Length > 180000) throw new CollectorException("SUCCESS_RECORD_INVALID");
    try {
      var image = Convert.FromBase64String(f[29][22..]);
      if (image.Length < 45 || image.Length > 131072 || !image.AsSpan(0, 8).SequenceEqual(new byte[] {137,80,78,71,13,10,26,10})) throw new Exception();
    } catch (Exception) { throw new CollectorException("PAYMENT_IMAGE_INVALID"); }
    return new(f[26][1..], clock.Value, f[20], f[6], f[8], f[7], f[10], f[4], f[3], f[27], f[9], f[29]);
  }
  public static PaymentCodeEvent Match(SuccessCandidate s, string[] o)
  {
    if (o.Length < 15 || o[0] != s.OrderNumber || o[1] != s.ContactEmail || o[2] != s.AppleId || o[4] != s.LastName || o[5] != s.FirstName || o[6] != s.Store || o[9] != s.Phone || o[10] != s.Products || o[11] != "微信" || o[12] != s.Tag || (o.Length > 15 && o[15] != s.IdLast4)) throw new CollectorException("PAYMENT_CODE_IDENTITY_MISMATCH");
    if (!DateTime.TryParseExact(o[14], ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm:ss.FFF"], CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) ||
      !TimeSpan.TryParseExact(s.Clock, @"hh\:mm\:ss\.fff", CultureInfo.InvariantCulture, out var clock)) throw new CollectorException("PAYMENT_CODE_TIME_INVALID");
    var source = date.Date.Add(clock);
    if (source < date.AddHours(-12)) source = source.AddDays(1);
    if (source < date.AddMinutes(-5) || source > date.AddDays(1)) throw new CollectorException("PAYMENT_CODE_TIME_INVALID");
    return new(Guid.NewGuid().ToString(), s.OrderNumber, new DateTimeOffset(date, TimeSpan.FromHours(8)).ToString("O"), new DateTimeOffset(source, TimeSpan.FromHours(8)).ToString("O"), s.ContactEmail, s.AppleId, "微信", s.ImageDataUrl);
  }
}

internal static class PaymentCodeCollector
{
  public static void Scan(DirectoryConfig dir, CollectorConfig config, QueueStore store, CancellationToken token)
  {
    var key = "payment-candidates:" + dir.DirectoryId;
    var candidates = store.GetState<Dictionary<string, SuccessCandidate>>(key) ?? [];
    var orders = new Dictionary<string, string[]>();
    foreach (var path in Directory.GetFiles(dir.Path, "AOS订单记录-*.txt")) {
      token.ThrowIfCancellationRequested();
      foreach (var line in Read(path, config.Encoding)) {
        if (line.PendingTail) continue;
        var fields = line.RawLine.Split('\t');
        if (fields.Length >= 15 && Regex.IsMatch(fields[0], @"^W\d{10}$")) {
          if (orders.TryGetValue(fields[0], out var previous) && !previous.SequenceEqual(fields)) throw new CollectorException("PAYMENT_ORDER_CONFLICT");
          orders[fields[0]] = fields;
        }
      }
    }
    string? error = null; var changed = false;
    foreach (var path in Directory.GetFiles(dir.Path, "AOS成功记录-*.txt")) {
      token.ThrowIfCancellationRequested();
      foreach (var line in Read(path, config.Encoding, true)) {
        if (line.PendingTail) continue;
        try {
          var candidate = PaymentCodeParser.Parse(line.RawLine);
          if (candidate == null) continue;
          var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(line.RawLine)));
          if (!candidates.ContainsKey(hash)) {
            if (candidates.Count >= 20000) throw new CollectorException("PAYMENT_CANDIDATE_LIMIT");
            candidates[hash] = candidate; changed = true;
          }
        } catch (CollectorException e) { error = e.Code; }
      }
    }
    // 先可靠保存孤立的成功记录；源文件被替换后仍能在订单到达时补齐。
    if (changed) store.SetState(key, candidates);
    foreach (var candidate in candidates.Values) {
      if (!orders.TryGetValue(candidate.OrderNumber, out var order)) continue;
      try { store.EnqueueCode(PaymentCodeParser.Match(candidate, order)); }
      catch (CollectorException e) { error = e.Code; }
    }
    if (error != null) throw new CollectorException(error);
  }
  private static List<ParsedFileLine> Read(string path, string encoding, bool success = false)
  {
    using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    if (stream.Length > 64 * 1024 * 1024) throw new CollectorException("FILE_TOO_LARGE");
    using var buffer = new MemoryStream(); stream.CopyTo(buffer);
    // 不消费没有换行的写入中尾行；下次事件或周期扫描继续。
    return FileParser.Parse(buffer.ToArray(), encoding, DateTime.UtcNow - File.GetLastWriteTimeUtc(path) > TimeSpan.FromSeconds(3), success);
  }
}
