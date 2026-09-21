using System.Text;

namespace AosCollector.Core;

/** 普通微信与分期方式分别处理，未知方式交服务器人工核对。 */
public static class PaymentMethods
{
  private static readonly HashSet<string> NonWechat = new(StringComparer.OrdinalIgnoreCase) {
    "支付宝", "alipay", "花呗12期", "招行12期", "招行24期", "建行12期", "建行24期",
    "工行12期", "工行24期", "微信分付12期", "微信分付24期", "支付宝银行12期", "支付宝银行24期",
    "VISA", "MASTERCARD"
  };

  public static bool IsWechat(string value) => Normalize(value).ToLowerInvariant() is "微信" or "微信支付" or "wechat" or "wechat pay";
  public static bool IsKnownNonWechat(string value) => NonWechat.Contains(Normalize(value));
  private static string Normalize(string value) => value.Normalize(NormalizationForm.FormKC).Trim();
}
