const mockFindOne = jest.fn();
const mockGetAutoRefreshStatus = jest.fn(() => ({
  enabled: true,
  isRunning: false,
  isPaused: false,
  intervalMs: 300000,
}));
const mockResumeAutoRefresh = jest.fn();

jest.mock('../src/models', () => ({
  CrawlLog: {
    findOne: mockFindOne,
  },
  Order: {},
}));
jest.mock('../src/services/crawlerService', () => ({
  getAutoRefreshStatus: mockGetAutoRefreshStatus,
  resumeAutoRefresh: mockResumeAutoRefresh,
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const systemController = require('../src/controllers/systemController');

describe('独立爬虫 Worker 状态与控制', () => {
  const originalRunWorkersInApi = process.env.RUN_WORKERS_IN_API;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RUN_WORKERS_IN_API = 'false';
  });

  afterAll(() => {
    if (originalRunWorkersInApi === undefined) delete process.env.RUN_WORKERS_IN_API;
    else process.env.RUN_WORKERS_IN_API = originalRunWorkersInApi;
  });

  test('独立 Worker 拓扑只返回持久化观测值，不伪造进程运行状态', async () => {
    mockFindOne
      .mockResolvedValueOnce({
        event: 'auto_refresh_paused',
        errorMessage: '连续触发 Apple 风控',
        createdAt: new Date('2026-09-05T08:00:00Z'),
      })
      .mockResolvedValueOnce({
        event: 'auto_refresh_scan',
        createdAt: new Date('2026-09-05T07:59:00Z'),
      });
    const res = { json: jest.fn() };

    await systemController.getAutoRefreshStatus({}, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.controlMode).toBe('external_worker');
    expect(data.controlAvailable).toBe(false);
    expect(data.isRunning).toBeNull();
    expect(data.isPaused).toBe(true);
    expect(data.statusSource).toBe('crawl_logs');
  });

  test('独立 Worker 拓扑下恢复接口应明确拒绝而不是假成功', async () => {
    await expect(
      systemController.resumeAutoRefresh({ user: { id: 1, username: 'admin' } }, {})
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'WORKER_CONTROL_UNAVAILABLE',
    });
    expect(mockResumeAutoRefresh).not.toHaveBeenCalled();
  });
});
