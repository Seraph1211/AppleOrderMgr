const fs = require('fs/promises');
const nativeFs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getRelease } = require('../src/services/collectorReleaseService');

describe('采集器制品流式校验', () => {
  let root;
  let executable;
  let previous;
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  beforeEach(async () => {
    previous = [process.env.COLLECTOR_RELEASE_DIR, process.env.COLLECTOR_UPDATE_PUBLIC_KEY_FILE];
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'collector-release-test-'));
    process.env.COLLECTOR_RELEASE_DIR = root;
    process.env.COLLECTOR_UPDATE_PUBLIC_KEY_FILE = path.join(root, 'public.pem');
    await fs.writeFile(
      process.env.COLLECTOR_UPDATE_PUBLIC_KEY_FILE,
      keys.publicKey.export({ type: 'spki', format: 'pem' })
    );
    await fs.mkdir(path.join(root, '1.2.1'));
    executable = path.join(root, '1.2.1', 'AosCollector.exe');
    const bytes = Buffer.alloc(16 * 1024 * 1024, 17);
    await fs.writeFile(executable, bytes);
    const manifest = {
      product: 'AppleOrderMgrAosCollector',
      platform: 'win-x64',
      version: '1.2.1',
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      queueSchema: 1,
    };
    const payload = Buffer.from(JSON.stringify(manifest));
    await fs.writeFile(
      path.join(root, '1.2.1', 'manifest.json'),
      JSON.stringify({
        payload: payload.toString('base64'),
        signature: crypto.sign('RSA-SHA256', payload, keys.privateKey).toString('base64'),
      })
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const [index, key] of [
      'COLLECTOR_RELEASE_DIR',
      'COLLECTOR_UPDATE_PUBLIC_KEY_FILE',
    ].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  test('20个并发校验不通过readFile读入整个EXE', async () => {
    const read = fs.readFile.bind(fs);
    jest.spyOn(fs, 'readFile').mockImplementation((file, ...args) => {
      if (String(file).endsWith('.exe')) throw new Error('禁止整体读取安装包');
      return read(file, ...args);
    });
    const rows = await Promise.all(Array.from({ length: 20 }, () => getRelease('1.2.1')));
    expect(rows).toHaveLength(20);
    expect(rows.every(row => row.manifest.size === 16 * 1024 * 1024)).toBe(true);
  });
  test('校验成功后同长度内容被篡改仍拒绝，不复用成功缓存', async () => {
    await getRelease('1.2.1');
    const handle = await fs.open(executable, 'r+');
    try {
      await handle.write(Buffer.from([3]), 0, 1, 42);
    } finally {
      await handle.close();
    }
    await expect(getRelease('1.2.1')).rejects.toThrow('发布制品摘要不一致');
  });
  test('读取失败后重新发布正确文件能够恢复，不保留拒绝的在途缓存', async () => {
    const original = await fs.readFile(executable);
    await fs.writeFile(executable, Buffer.alloc(original.length, 0));
    await expect(getRelease('1.2.1')).rejects.toThrow();
    await fs.writeFile(executable, original);
    await expect(getRelease('1.2.1')).resolves.toHaveProperty('manifest.version', '1.2.1');
  });
  test('拒绝软链接、截断文件和不存在版本', async () => {
    await fs.rename(executable, executable + '.real');
    await fs.symlink(executable + '.real', executable);
    await expect(getRelease('1.2.1')).rejects.toThrow('发布文件不合法');
    await fs.unlink(executable);
    await fs.writeFile(executable, 'MZ');
    await expect(getRelease('1.2.1')).rejects.toThrow('发布制品与清单不一致');
    await expect(getRelease('9.9.9')).rejects.toThrow('采集器发布制品不可用');
    expect(nativeFs.existsSync(executable)).toBe(true);
  });
});
