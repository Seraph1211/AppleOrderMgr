import client from './client';

export const applePurchaseInventoryApi = {
  observations: params => client.get('/apple-purchase-inventory/v1/observations', { params }),
  monitorChanges: params => client.get('/apple-purchase-inventory/v1/monitor-changes', { params }),
  status: () => client.get('/apple-purchase-inventory/v1/status'),
  availabilityOptions: (_query, signal) =>
    client.get('/apple-purchase-inventory/v1/availability/options', { signal }),
  availabilityRecords: (query, signal) =>
    client.get('/apple-purchase-inventory/v1/availability/records', {
      params: new URLSearchParams(query),
      signal,
    }),
  availabilityTrend: (query, signal) =>
    client.get('/apple-purchase-inventory/v1/availability/trend', {
      params: new URLSearchParams(query),
      signal,
    }),
  terminals: () => client.get('/admin/apple-purchase-sync/v1/terminals'),
  createTerminal: data => client.post('/admin/apple-purchase-sync/v1/terminals', data),
  updateTerminal: (terminalId, data) =>
    client.patch(`/admin/apple-purchase-sync/v1/terminals/${terminalId}`, data),
  rotateTerminalToken: terminalId =>
    client.post(`/admin/apple-purchase-sync/v1/terminals/${terminalId}/rotate-token`, {}),
};

function authToken() {
  return localStorage.getItem('token') || sessionStorage.getItem('token');
}

function parseEventBlock(block) {
  const event = block
    .split('\n')
    .find(line => line.startsWith('event:'))
    ?.slice(6)
    .trim();
  const data = block
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n');
  if (event !== 'inventory-version' || !data) return null;
  try {
    return JSON.parse(data);
  } catch (_error) {
    return null;
  }
}

/** 使用 Authorization Header 读取 SSE，避免把网页 JWT 放进 URL。 */
export function subscribeApplePurchaseInventory(onVersion, onState) {
  const controller = new AbortController();
  let reconnectTimer;
  const connect = async () => {
    try {
      onState?.('connecting');
      const response = await fetch('/api/apple-purchase-inventory/v1/events', {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${authToken() || ''}`,
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('实时通知连接失败');
      onState?.('connected');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const version = parseEventBlock(block);
          if (version) onVersion(version);
          boundary = buffer.indexOf('\n\n');
        }
      }
      if (!controller.signal.aborted) throw new Error('实时通知连接已断开');
    } catch (_error) {
      if (controller.signal.aborted) return;
      onState?.('disconnected');
      reconnectTimer = window.setTimeout(connect, 3000);
    }
  };
  connect();
  return () => {
    window.clearTimeout(reconnectTimer);
    controller.abort();
  };
}
