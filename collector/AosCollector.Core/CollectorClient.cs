using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace AosCollector.Core;

public sealed class CollectorClient : IDisposable
{
  private readonly HttpClient client;
  public CollectorClient(CollectorConfig config, HttpMessageHandler? handler = null)
  {
    if (!Uri.TryCreate(config.ServerUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https" ||
      !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != "/") throw new CollectorException("SERVER_URL_INVALID");
    // 不跟随重定向向另一个主机发送设备凭据，保留默认 TLS 证书校验。
    client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = uri, Timeout = TimeSpan.FromSeconds(20) };
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config.Credential);
  }
  private async Task<T> Request<T>(string path, object? body, CancellationToken token)
  {
    try {
      using var request = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, "api/aos-collector/v1/" + path);
      if (body != null) request.Content = JsonContent.Create(body, options: Protocol.Json);
      using var response = await client.SendAsync(request, token);
      if (!response.IsSuccessStatusCode) {
        var retryAfter = response.Headers.RetryAfter;
        var delay = retryAfter?.Delta?.TotalSeconds ?? (retryAfter?.Date - DateTimeOffset.UtcNow)?.TotalSeconds;
        throw new CollectorException(response.StatusCode switch { HttpStatusCode.Unauthorized => "DEVICE_UNAUTHORIZED", HttpStatusCode.Forbidden => "DEVICE_DISABLED", HttpStatusCode.TooManyRequests => "RATE_LIMITED", HttpStatusCode.RequestEntityTooLarge => "PAYLOAD_TOO_LARGE", _ => "SERVER_UNAVAILABLE" }, delay.HasValue ? (int)Math.Clamp(Math.Ceiling(delay.Value), 1, 86400) : null);
      }
      using var json = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(token));
      if (!json.RootElement.GetProperty("success").GetBoolean()) throw new CollectorException("SERVER_RESPONSE_INVALID");
      return json.RootElement.GetProperty("data").Deserialize<T>(Protocol.Json) ?? throw new CollectorException("SERVER_RESPONSE_INVALID");
    } catch (CollectorException) { throw; }
    catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
    catch (Exception) { throw new CollectorException("CONNECTION_FAILED"); }
  }
  public Task<CollectorContext> Context(CancellationToken token) => Request<CollectorContext>("context", null, token);
  public Task<CollectorContext> Heartbeat(HeartbeatRequest body, CancellationToken token) => Request<CollectorContext>("heartbeat", body, token);
  public async Task<List<Receipt>> Send(List<UploadEvent> events, CancellationToken token)
  {
    try { return (await Request<BatchResult>("records", new { schemaVersion = 1, records = events }, token)).Results; }
    catch (Exception) { throw; }
  }
  public async Task ConfirmScan(string scanId, List<string> eventIds, CancellationToken token)
  {
    try { await Request<JsonElement>("records/status", new { scanRequestId = scanId, eventIds }, token); }
    catch (Exception) { throw; }
  }
  private sealed record BatchResult(List<Receipt> Results);
  public void Dispose() => client.Dispose();
}
