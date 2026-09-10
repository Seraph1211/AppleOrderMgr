using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace AosCollector.Core;

public sealed record ParsedFileLine(int LineNumber, string RawLine, string? BusinessDate, bool PendingTail);
public static partial class FileParser
{
  [GeneratedRegex(@"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$")]
  private static partial Regex DatePattern();

  public static List<ParsedFileLine> Parse(byte[] bytes, string encodingName, bool stable)
  {
    Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    Encoding encoding = encodingName switch {
      "utf-8" => new UTF8Encoding(false, true),
      "gb18030" => Encoding.GetEncoding("GB18030", EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback),
      _ => throw new CollectorException("ENCODING_UNSUPPORTED")
    };
    string text;
    try { text = encoding.GetString(bytes); }
    catch (DecoderFallbackException error) {
      var boundary = Array.LastIndexOf(bytes, (byte)'\n') + 1;
      // UTF-8 字符可能跨两次写入；已完成的前置行仍可独立处理。
      if (encodingName == "utf-8" && boundary > 0 && boundary < bytes.Length && error.Index >= boundary) {
        var completed = Parse(bytes[..boundary], encodingName, stable);
        completed.Add(new(bytes[..boundary].Count(b => b == (byte)'\n') + 1, "", null, true));
        return completed;
      }
      throw new CollectorException("ENCODING_INVALID");
    }
    if (text.StartsWith('\uFEFF')) text = text[1..];
    var lines = text.Split('\n');
    var result = new List<ParsedFileLine>();
    for (var index = 0; index < lines.Length; index++) {
      var line = lines[index].EndsWith('\r') ? lines[index][..^1] : lines[index];
      if (line.Length == 0) continue;
      var fields = line.Split('\t');
      var date = fields.Length == 15 && DatePattern().IsMatch(fields[14]) &&
        DateTime.TryParseExact(fields[14], ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm:ss.FFF"], CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsedDate)
        ? parsedDate.ToString("yyyy-MM-dd") : null;
      var tail = index == lines.Length - 1 && !text.EndsWith('\n');
      // 非换行尾行必须有完整字段与严格日期；不完整尾行一直等待，不当作可上传坏行。
      var complete = fields.Length == 15 && date != null && fields.Where((_, i) => i is not 7 and not 8 and not 12).All(f => f.Length > 0);
      result.Add(new(index + 1, line, date, tail && (!complete || !stable)));
    }
    return result;
  }
}
