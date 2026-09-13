using AosCollector.Core;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

internal static class PaymentCodeTests
{
  public static void Run(Action<bool, string> check, string root)
  {
    var image = "data:image/png;base64," + Convert.ToBase64String(new byte[] {137,80,78,71,13,10,26,10}.Concat(new byte[45]).ToArray());
    var order = new[] {"W9900000071", "contact@example.com", "apple@example.com", "synthetic-password", "测", "试", "R001", "", "ignored", "13800000000", "TEST/A-测试商品 x 1", "微信", "TAG", "https://www.apple.com.cn/xc/cn/vieworder/W9900000071/contact@example.com", "2026-09-13 23:59:59.123", "1234"};
    var fields = Enumerable.Repeat("", 30).ToArray();
    fields[0]="00:00:00.123 [1]apple@example.com";fields[4]="R001";fields[6]=order[1];fields[7]=order[5];fields[8]=order[4];fields[9]=order[15];fields[10]=order[9];fields[19]="微信";fields[20]=order[2];fields[26]="/"+order[0];fields[27]="TAG";fields[3]=order[10];fields[29]=image;
    var raw = string.Join(',', fields);
    var candidate = PaymentCodeParser.Parse(raw)!;
    var item = PaymentCodeParser.Match(candidate, order);
    check(DateTimeOffset.Parse(item.SourceTime).ToOffset(TimeSpan.FromHours(8)).Day == 14, "成功时间跨午夜关联下一天而非按上传时间覆盖");
    check(item.ImageDataUrl == image && item.AppleId == order[2], "Data URL 逗号保留并只提取必要字段");
    check(FileParser.Parse(Encoding.UTF8.GetBytes(string.Join('\t', order)), "utf-8", true) is [{PendingTail:false,BusinessDate:not null}], "16 列完整尾行与业务日期识别");
    check(FileParser.Parse(Encoding.UTF8.GetBytes(raw), "utf-8", false)[0].PendingTail, "成功记录未稳定尾行等待");
    check(!FileParser.Parse(Encoding.UTF8.GetBytes(raw), "utf-8", true, true)[0].PendingTail, "完整成功记录稳定尾行可解析");
    var mismatch = false;
    try { PaymentCodeParser.Match(candidate, order.Select((v, i) => i == 2 ? "wrong@example.com" : v).ToArray()); } catch (CollectorException) { mismatch = true; }
    check(mismatch, "同号不同账号禁止挂码");
    fields[19]="支付宝";fields[29]=order[13];
    check(PaymentCodeParser.Parse(string.Join(',',fields)) == null, "支付宝订单链接不当作付款码上传");
    var path = Path.Combine(root, "payment-queue.sqlite");
    using (var queue = new QueueStore(path, new TestProtector())) {
      check(queue.EnqueueCode(item), "独立付款码事件可靠持久化");
      check(!queue.EnqueueCode(item with { EventId = Guid.NewGuid().ToString() }), "重复扫描付款码保持首个事件身份");
      check(queue.HasEvents(), "仅有码队列也阻止迁移设备身份");
    }
    using (var queue = new QueueStore(path, new TestProtector())) {
      check(queue.PendingCodes().Single().EventId == item.EventId, "重启恢复付款码待上传记录");
      queue.ApplyCode(new(item.EventId,"rejected",null,null,null,"ORDER_NOT_READY",true));
      check(queue.PendingCodes().Count == 0 && queue.CodeCounts().Pending == 1, "订单未到时延迟重试并持续保留付款码");
      var next = item with { EventId = Guid.NewGuid().ToString(), OrderNumber = "W9900000072" }; queue.EnqueueCode(next);
      check(queue.PendingCodes().Single().EventId == next.EventId, "缺失旧订单的待传码不阻塞新码");
      queue.ApplyCode(new(next.EventId,"accepted",null,null,null,null,false));
      queue.ApplyCode(new(item.EventId,"accepted",null,null,null,null,false));
      check(queue.PendingCodes().Count == 0, "可靠回执后停止付款码重传");
    }
    using var rsa = RSA.Create(2048);
    var payload = JsonSerializer.SerializeToUtf8Bytes(new UpdateManifest("AppleOrderMgrAosCollector", "1.1.0", "win-x64", new string('a',64),100,1),Protocol.Json);
    var envelope = new SignedUpdate(Convert.ToBase64String(payload),Convert.ToBase64String(rsa.SignData(payload,HashAlgorithmName.SHA256,RSASignaturePadding.Pkcs1)));
    check(UpdateManifest.Verify(envelope,rsa.ExportSubjectPublicKeyInfoPem()).Version == "1.1.0", "更新清单通过固定公钥验签");
    var rejected = false; try { UpdateManifest.Verify(envelope with { Signature=Convert.ToBase64String(new byte[256]) },rsa.ExportSubjectPublicKeyInfoPem()); } catch (CollectorException) { rejected=true; }
    check(rejected,"签名篡改拒绝安装");
    var fake = Path.Combine(root,"fake.exe");File.WriteAllText(fake,"not an update");
    rejected=false;try { UpdateManifest.Verify(envelope,rsa.ExportSubjectPublicKeyInfoPem()).VerifyPackage(fake); } catch (CollectorException) { rejected=true; }
    check(rejected,"制品摘要或大小不一致拒绝安装");
  }
  private sealed class TestProtector : IProtector
  {
    private static readonly byte[] Key = SHA256.HashData(Encoding.UTF8.GetBytes("synthetic-code-test"));
    public byte[] Protect(byte[] plain) { var nonce=RandomNumberGenerator.GetBytes(12);var cipher=new byte[plain.Length];var tag=new byte[16];using var aes=new AesGcm(Key,16);aes.Encrypt(nonce,plain,cipher,tag);return nonce.Concat(tag).Concat(cipher).ToArray(); }
    public byte[] Unprotect(byte[] bytes) { var plain=new byte[bytes.Length-28];using var aes=new AesGcm(Key,16);aes.Decrypt(bytes.AsSpan(0,12),bytes.AsSpan(28),bytes.AsSpan(12,16),plain);return plain; }
  }
}
