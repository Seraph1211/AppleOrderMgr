const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkDocumentation, parseMarkdown } = require('../scripts/checkDocLinks');

describe('文档结构检查', () => {
  let root;

  function write(filename, content) {
    const target = path.join(root, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-doc-links-'));
    write('README.md', '[文档](docs/README.md)');
    write('docs/README.md', '# 导航\n[指南](指南.md#中文标题)');
    write('docs/指南.md', '# 中文标题\n\n```bash\nnpm run test\n```');
    write('package.json', JSON.stringify({ scripts: { test: 'jest' } }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('中文链接、锚点及现有命令通过', () => {
    expect(checkDocumentation(root).errors).toEqual([]);
  });

  test('拒绝失效文件和标题锚点', () => {
    write('docs/指南.md', '# 中文标题\n[坏文件](丢失.md)\n[坏锚点](#不存在)');
    const result = checkDocumentation(root);
    expect(result.errors.some(error => error.includes('目标不存在'))).toBe(true);
    expect(result.errors.some(error => error.includes('锚点不存在'))).toBe(true);
  });

  test('拒绝孤立文件，即使两份孤立文档互相链接', () => {
    write('docs/孤立甲.md', '[乙](孤立乙.md)');
    write('docs/孤立乙.md', '[甲](孤立甲.md)');
    expect(
      checkDocumentation(root).errors.filter(error => error.includes('未从文档总入口可达'))
    ).toHaveLength(['孤立甲', '孤立乙'].length);
  });

  test('归档旧路径和命令不阻断，活动文档旧路径会失败', () => {
    write('scripts/docPathAliases.json', JSON.stringify({ '旧指南.md': '指南.md' }));
    write('docs/README.md', '# 导航\n[指南](指南.md#中文标题)\n[历史](archive/历史.md)');
    write('docs/archive/历史.md', '# 历史\n旧指南.md\nnpm run obsolete');
    expect(checkDocumentation(root).errors).toEqual([]);
    write('docs/指南.md', '# 中文标题\n旧指南.md');
    expect(checkDocumentation(root).errors.some(error => error.includes('旧路径'))).toBe(true);
  });

  test('按 frontend 上下文验证命令，拒绝无效脚本', () => {
    write('frontend/package.json', JSON.stringify({ scripts: { build: 'vite build' } }));
    write('frontend/README.md', '# 前端\nnpm run build');
    write('docs/指南.md', '# 中文标题\nnpm --prefix frontend run build');
    expect(checkDocumentation(root).errors).toEqual([]);
    write('docs/指南.md', '# 中文标题\nnpm run missing');
    expect(checkDocumentation(root).errors.some(error => error.includes('npm 脚本不存在'))).toBe(
      true
    );
  });

  test('忽略代码示例中的假链接，支持重复标题锚点', () => {
    const result = parseMarkdown(
      '# 标题\n# 标题\n```md\n[示例](不存在.md)\n```\n`[示例](不存在.md)`'
    );
    expect(result.links).toEqual([]);
    expect(result.anchors.has('标题-1')).toBe(true);
  });

  test('模型字段检查同时覆盖四空格与六空格声明，缺失字段返回失败', () => {
    const source = path.join(__dirname, '../scripts/check-doc-consistency.js');
    write('scripts/check-doc-consistency.js', fs.readFileSync(source, 'utf8'));
    write(
      'src/models/First.js',
      "tableName: 'first'\n    missingFirst: {\n      type: DataTypes.TEXT,\n    },"
    );
    write(
      'src/models/Second.js',
      "tableName: 'second'\n      missingSecond: {\n        type: DataTypes.TEXT,\n      },"
    );
    write('docs/database/数据库架构.md', '`first` `second`');
    const run = () =>
      spawnSync(process.execPath, [path.join(root, 'scripts/check-doc-consistency.js')], {
        encoding: 'utf8',
      });
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('missing_first');
    expect(failed.stderr).toContain('missing_second');
    write('docs/database/数据库架构.md', '`first` `second` `missing_first` `missing_second`');
    expect(run().status).toBe(0);
  });
});
