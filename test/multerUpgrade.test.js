const express = require('express');
const multer = require('multer');

describe('multer 升级的 multipart 安全回归（无数据库）', () => {
  let server;
  let url;

  beforeAll(async () => {
    const app = express();
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 16, fieldArrayIndexLimit: 0 },
      fileFilter: (_req, _file, callback) => setTimeout(() => callback(null, true), 20),
    });
    app.post('/upload', upload.single('file'), (req, res) => {
      res.json({ size: req.file?.size || 0 });
    });
    app.use((error, _req, res, _next) => res.status(400).json({ code: error.code }));
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    url = `http://127.0.0.1:${server.address().port}/upload`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  test('使用已审计的精确修复版本', () => {
    expect(require('multer/package.json').version).toBe('2.3.0');
  });

  test.each([8, 16, 17])('异步 fileFilter 仍执行大小上限：%i 字节', async size => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(size)]), 'synthetic.xlsx');
    const response = await fetch(url, { method: 'POST', body: form });
    expect(response.status).toBe(size > 16 ? 400 : 200);
    expect(await response.json()).toEqual(size > 16 ? { code: 'LIMIT_FILE_SIZE' } : { size });
  });

  test('超大数组下标字段应被拒绝而不是阻塞进程', async () => {
    const form = new FormData();
    form.append('items[4294967294]', 'synthetic');
    const response = await fetch(url, { method: 'POST', body: form });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('LIMIT_FIELD_ARRAY_INDEX');
    const healthy = await fetch(url, { method: 'POST', body: new FormData() });
    expect(healthy.status).toBe(200);
  });
});
