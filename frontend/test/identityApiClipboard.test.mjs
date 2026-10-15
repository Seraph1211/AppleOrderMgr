import test from 'node:test';
import assert from 'node:assert/strict';
import { copyIdentityText } from '../src/utils/copyIdentityText.js';
import { buildIdentityApiGuide } from '../src/utils/identityApiGuide.js';

const setClipboard = clipboard =>
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard },
  });

test('说明强制HTTPS、三个占位参数和未知语义', () => {
  const guide = buildIdentityApiGuide('http://synthetic.example:5196');
  assert.match(
    guide,
    /HTTPS GET https:\/\/synthetic.example:5196\/api\/internal\/v1\/identity\/verify\?name=<URL编码后的姓名>&idCardNumber=<18位身份证号>&token=<本人API令牌>/
  );
  for (const value of [
    '50',
    '100',
    '600',
    '90',
    'matched=false',
    'matched=null',
    '禁止自动重试',
    'RESULT_UNKNOWN',
    'UNRESOLVED_RESULT',
  ])
    assert.ok(guide.includes(value));
  assert.ok(!guide.includes('http://'));
});

test('支持异步ClipboardItem且仅获取一次文本', async () => {
  let calls = 0;
  let copied;
  globalThis.ClipboardItem = class {
    constructor(value) {
      this.value = value;
    }
  };
  setClipboard({
    write: async items => {
      copied = await (await items[0].value['text/plain']).text();
    },
  });
  await copyIdentityText(async () => {
    calls++;
    return 'synthetic-token-only';
  });
  assert.equal(copied, 'synthetic-token-only');
  assert.equal(calls, 1);
  delete globalThis.ClipboardItem;
});

test('异步剪贴板拒绝时回退，清理隐藏输入并恢复焦点', async () => {
  let calls = 0;
  let removed = false;
  let focusRestored = false;
  let selected = false;
  let input;
  setClipboard({
    writeText: async () => {
      throw new Error('denied');
    },
  });
  globalThis.document = {
    activeElement: {
      focus: () => {
        focusRestored = true;
      },
    },
    createElement: () =>
      (input = {
        style: {},
        setAttribute() {},
        select() {
          selected = true;
        },
        setSelectionRange() {},
        remove() {
          removed = true;
        },
      }),
    body: { appendChild() {} },
    execCommand: command =>
      command === 'copy' && selected && input.value === 'synthetic-token-only',
  };
  await copyIdentityText(async () => {
    calls++;
    return 'synthetic-token-only';
  });
  assert.equal(calls, 1);
  assert.equal(input.value, '');
  assert.ok(removed && focusRestored);
  delete globalThis.document;
});

test('所有复制途径失败时不得报告成功，且错误不含敏感内容', async () => {
  setClipboard({
    writeText: async () => {
      throw new Error('synthetic-token-only');
    },
  });
  globalThis.document = {
    activeElement: null,
    body: { appendChild() {} },
    createElement: () => ({
      style: {},
      setAttribute() {},
      select() {},
      setSelectionRange() {},
      remove() {},
    }),
    execCommand: () => false,
  };
  await assert.rejects(
    copyIdentityText(() => 'synthetic-token-only'),
    error => error.message.includes('复制失败') && !error.message.includes('synthetic-token-only')
  );
  delete globalThis.document;
});

test('reveal失败不会复制错误文本或泄露服务端错误', async () => {
  let wrote = false;
  setClipboard({
    writeText: async () => {
      wrote = true;
    },
  });
  await assert.rejects(
    copyIdentityText(async () => {
      throw new Error('synthetic-secret-error');
    }),
    error => !error.message.includes('synthetic-secret-error')
  );
  assert.equal(wrote, false);
});
