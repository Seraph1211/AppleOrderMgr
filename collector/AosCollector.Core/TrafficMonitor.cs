using System.Net.NetworkInformation;

namespace AosCollector.Core;

public sealed class TrafficMonitor
{
  private Dictionary<string, InterfaceCounter>? previous;
  private DateTimeOffset? sampledAt;
  private (long Received, long Sent)? transport;
  public static List<InterfaceCounter> ReadInterfaces()
  {
    var result = new List<InterfaceCounter>();
    foreach (var network in NetworkInterface.GetAllNetworkInterfaces()) {
      if (network.OperationalStatus != OperationalStatus.Up || network.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
      var stats = network.GetIPStatistics();
      result.Add(new(network.Id, network.Name, network.GetIPProperties().GatewayAddresses.Any(g => !g.Address.Equals(System.Net.IPAddress.Any) && !g.Address.Equals(System.Net.IPAddress.IPv6Any)), stats.BytesReceived, stats.BytesSent));
    }
    return result;
  }
  public TrafficDelta Sample(List<InterfaceCounter> interfaces, List<string> selectedIds, (long Received, long Sent) totals, DateTimeOffset now)
  {
    var selected = interfaces.Where(i => selectedIds.Count == 0 ? i.DefaultRoute : selectedIds.Contains(i.Id)).ToDictionary(i => i.Id);
    var complete = previous != null && sampledAt != null && now > sampledAt && now - sampledAt <= TimeSpan.FromSeconds(90) && selected.Count > 0 && previous.Keys.Order().SequenceEqual(selected.Keys.Order()) && (selectedIds.Count == 0 || selected.Count == selectedIds.Count);
    long received = 0, sent = 0;
    if (complete) {
      foreach (var (id, current) in selected) {
        var old = previous![id];
        if (current.Received < old.Received || current.Sent < old.Sent) { complete = false; break; }
        received += current.Received - old.Received; sent += current.Sent - old.Sent;
      }
    }
    var cr = transport.HasValue ? Math.Max(0, totals.Received - transport.Value.Received) : 0;
    var cs = transport.HasValue ? Math.Max(0, totals.Sent - transport.Value.Sent) : 0;
    previous = selected; sampledAt = now; transport = totals;
    return new(complete ? received : 0, complete ? sent : 0, cr, cs, selected.Count == 0 ? "unavailable" : complete ? "complete" : "gap");
  }
  public void Reset() { previous = null; sampledAt = null; }
}
