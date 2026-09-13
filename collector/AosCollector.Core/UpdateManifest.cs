using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AosCollector.Core;

public sealed record SignedUpdate(string Payload, string Signature);
public sealed record UpdateManifest(string Product, string Version, string Platform, string Sha256, long Size, int QueueSchema)
{
  public static UpdateManifest Verify(SignedUpdate envelope, string publicKey)
  {
    try {
      if (envelope.Payload.Length > 4096 || envelope.Signature.Length > 2048) throw new Exception();
      var payload = Convert.FromBase64String(envelope.Payload);
      using var rsa = RSA.Create(); rsa.ImportFromPem(publicKey);
      if (!rsa.VerifyData(payload, Convert.FromBase64String(envelope.Signature), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) throw new Exception();
      var manifest = JsonSerializer.Deserialize<UpdateManifest>(payload, Protocol.Json) ?? throw new Exception();
      if (manifest.Product != "AppleOrderMgrAosCollector" || manifest.Platform != "win-x64" || !Regex.IsMatch(manifest.Version, @"^\d{1,5}\.\d{1,5}\.\d{1,5}$") || !Regex.IsMatch(manifest.Sha256, "^[a-f0-9]{64}$") || manifest.Size is < 1 or > 314572800 || manifest.QueueSchema != 1) throw new Exception();
      return manifest;
    } catch (Exception) { throw new CollectorException("UPDATE_SIGNATURE_INVALID"); }
  }
  public void VerifyPackage(string path)
  {
    try {
      using var stream = File.OpenRead(path);
      if (stream.Length != Size || !Convert.ToHexString(SHA256.HashData(stream)).Equals(Sha256, StringComparison.OrdinalIgnoreCase)) throw new Exception();
    } catch (Exception) { throw new CollectorException("UPDATE_PACKAGE_INVALID"); }
  }
}
public sealed record UpdateJob(string Id, string ReleaseVersion, string Status);
public sealed record UpdateOffer(UpdateJob? Job, SignedUpdate? Envelope);
