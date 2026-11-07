const express = require('express');
const { createRouter } = require('../src/routes/publicApplePurchaseAvailability');

const terminalId = '00000000-0000-4000-8000-000000000001';
const privateMarker = 'fixture-private-value';

test('公开查询免登录，配置历史只返回业务摘要，保留快照和游标', async () => {
  const service = {
    availabilityOptions: jest.fn(async () => ({
      snapshot: '20',
      firstDetectedAt: null,
      lastDetectedAt: null,
      lastSyncAt: null,
      cities: [],
      families: [],
      colors: [],
      capacities: [],
      stores: [],
      terminals: [{ id: terminalId, name: privateMarker, token: privateMarker }],
    })),
    availabilityRecords: jest.fn(async () => ({
      total: 1,
      nextCursor: 'records-cursor',
      items: [
        { sequence: '20', id: privateMarker, terminalId, store: '合成门店', secret: privateMarker },
      ],
    })),
    availabilityTrend: jest.fn(async () => ({ points: [] })),
    listMonitorChanges: jest.fn(async () => ({
      page: { highWaterSequence: '2', nextCursor: 'changes-cursor' },
      items: [
        {
          sequence: '2',
          changedAt: '2026-11-06T16:00:00.000Z',
          changeType: 'configuration_updated',
          previousRevision: 1,
          revision: 2,
          terminalId,
          monitorName: privateMarker,
          before: { partNumbers: ['fixture-before'], controlState: 'stopped' },
          after: {
            partNumbers: [privateMarker],
            taskDemands: { [privateMarker]: { contact: privateMarker } },
            controlState: 'running',
            proxy: privateMarker,
          },
          changes: [{ secret: privateMarker }],
        },
      ],
    })),
  };
  const app = express();
  app.use(createRouter(service, { subscribe: (_req, res) => res.end() }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const root = `http://127.0.0.1:${server.address().port}`;
    const options = await fetch(`${root}/options`);
    expect(options.status).toBe(200);
    expect(options.headers.get('cache-control')).toBe('no-store');
    const catalog = await options.json();
    expect(catalog.terminals[0]).toEqual({ id: terminalId, name: expect.stringMatching(/^终端 /) });
    expect(JSON.stringify(catalog)).not.toContain(privateMarker);
    const records = await (
      await fetch(`${root}/records?snapshot=20&color=white&color=black`)
    ).json();
    expect(service.availabilityRecords).toHaveBeenCalledWith({
      snapshot: '20',
      color: ['white', 'black'],
    });
    expect(records).toMatchObject({ total: 1, nextCursor: 'records-cursor' });
    expect(JSON.stringify(records)).not.toContain(privateMarker);
    const changes = await (await fetch(`${root}/changes?cursor=existing`)).json();
    expect(service.listMonitorChanges).toHaveBeenCalledWith({
      cursor: 'existing',
      direction: 'desc',
      limit: 20,
    });
    expect(changes).toMatchObject({
      snapshot: '2',
      nextCursor: 'changes-cursor',
      items: [
        {
          terminal: catalog.terminals[0].name,
          changes: [
            { kind: 'products', before: 1, after: 1, added: 1, removed: 1 },
            { kind: 'tasks', before: 0, after: 1, added: 1, removed: 0 },
            { kind: 'state', before: 'stopped', after: 'running' },
          ],
        },
      ],
    });
    expect(JSON.stringify(changes)).not.toContain(privateMarker);
    expect(changes.items[0]).not.toHaveProperty('after');
    expect(await (await fetch(`${root}/trend?snapshot=20&interval=day`)).json()).toEqual({
      points: [],
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
