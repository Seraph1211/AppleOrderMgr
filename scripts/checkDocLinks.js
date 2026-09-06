#!/usr/bin/env node

/**
 * 只读校验本地文档链接、锚点、导航及维护入口。
 */
const fs = require('fs');
const path = require('path');

/**
 * 枚举指定目录内文件。
 * @param {string} directory - 目录
 * @returns {string[]} 文件路径
 */
function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(filename) : [filename];
  });
}

/**
 * 生成 GitHub 风格标题锚点。
 * @param {string} heading - 标题文本
 * @returns {string} 锚点
 */
function slugify(heading) {
  return heading
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * 读取代码块之外的链接与标题，不解释代码示例。
 * @param {string} content - Markdown 内容
 * @returns {Object} 链接与锚点
 */
function parseMarkdown(content) {
  const anchors = new Set();
  const links = [];
  const slugs = new Map();
  let fence = null;
  for (const [index, line] of content.split('\n').entries()) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
    if (heading) {
      const slug = slugify(heading[1]);
      let anchor = slug;
      let count = slugs.get(slug) || 0;
      while (anchors.has(anchor)) anchor = `${slug}-${++count}`;
      slugs.set(slug, count);
      anchors.add(anchor);
    }
    // 行内代码中的路径是示例，不能当作可点击链接。
    const visible = line.replace(/`+[^`]*`+/g, '');
    for (const match of visible.matchAll(
      /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g
    )) {
      links.push({ target: match[1].replace(/^<|>$/g, ''), line: index + 1 });
    }
  }
  return { anchors, links };
}

/**
 * 校验仓库文档；不执行其中的命令，也不连接外部服务。
 * @param {string} root - 仓库根目录
 * @returns {Object} 错误、文档数和可达数
 */
function checkDocumentation(root) {
  const docsRoot = path.join(root, 'docs');
  const docFiles = listFiles(docsRoot).filter(file => file.endsWith('.md'));
  const entries = ['README.md', 'AGENTS.md', 'frontend/README.md']
    .map(file => path.join(root, file))
    .filter(file => fs.existsSync(file));
  const files = [...docFiles, ...entries];
  const errors = [];
  const documents = new Map(
    files.map(file => [file, parseMarkdown(fs.readFileSync(file, 'utf8'))])
  );
  const graph = new Map();
  const relative = file => path.relative(root, file);

  for (const [file, document] of documents) {
    const targets = new Set();
    for (const link of document.links) {
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(link.target)) continue;
      let target;
      try {
        target = decodeURIComponent(link.target);
      } catch (_error) {
        errors.push(`${relative(file)}:${link.line} 链接编码无效：${link.target}`);
        continue;
      }
      const hashIndex = target.indexOf('#');
      const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : '';
      const filename = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
      const destination = filename ? path.resolve(path.dirname(file), filename) : file;
      if (!fs.existsSync(destination)) {
        errors.push(`${relative(file)}:${link.line} 目标不存在：${link.target}`);
        continue;
      }
      targets.add(destination);
      if (fragment && destination.endsWith('.md')) {
        const targetDocument =
          documents.get(destination) || parseMarkdown(fs.readFileSync(destination, 'utf8'));
        if (!targetDocument.anchors.has(fragment)) {
          errors.push(`${relative(file)}:${link.line} 锚点不存在：${link.target}`);
        }
      }
    }
    graph.set(file, targets);
  }

  const index = path.join(docsRoot, 'README.md');
  const reachable = new Set();
  const queue = [index];
  if (!documents.has(index)) errors.push('缺少 docs/README.md 文档总入口');
  while (queue.length) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const target of graph.get(file) || []) queue.push(target);
  }
  for (const file of docFiles) {
    if (!reachable.has(file)) errors.push(`${relative(file)} 未从文档总入口可达`);
  }
  const rootReadme = path.join(root, 'README.md');
  if (documents.has(rootReadme) && !graph.get(rootReadme)?.has(index)) {
    errors.push('根 README 缺少 docs/README.md 链接');
  }

  const aliasesPath = path.join(root, 'scripts/docPathAliases.json');
  const aliases = fs.existsSync(aliasesPath)
    ? JSON.parse(fs.readFileSync(aliasesPath, 'utf8'))
    : {};
  const activeFiles = files.filter(
    file => !file.startsWith(path.join(docsRoot, 'archive') + path.sep)
  );
  const maintenance = [
    path.join(root, 'scripts/pre-commit-check.sh'),
    ...listFiles(path.join(root, '.github')),
  ].filter(file => fs.existsSync(file));
  for (const file of [...activeFiles, ...maintenance]) {
    if (relative(file) === 'docs/development/文档整理记录.md') continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const [obsolete, replacement] of Object.entries(aliases)) {
      if (content.includes(obsolete))
        errors.push(`${relative(file)} 旧路径 ${obsolete}，应使用 ${replacement}`);
    }
  }

  const readScripts = directory => {
    const filename = path.join(root, directory, 'package.json');
    return fs.existsSync(filename)
      ? JSON.parse(fs.readFileSync(filename, 'utf8')).scripts || {}
      : {};
  };
  const rootScripts = readScripts('.');
  const frontendScripts = readScripts('frontend');
  for (const file of activeFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(/npm\s+(?:--prefix\s+(frontend)\s+)?run\s+([\w:-]+)/g)) {
      const [, prefix, scriptName] = match;
      const scripts =
        prefix || relative(file) === 'frontend/README.md' ? frontendScripts : rootScripts;
      if (!(scriptName in scripts)) errors.push(`${relative(file)} npm 脚本不存在：${match[0]}`);
    }
  }
  return {
    errors,
    documentCount: docFiles.length,
    reachableCount: docFiles.filter(file => reachable.has(file)).length,
  };
}

if (require.main === module) {
  try {
    const result = checkDocumentation(path.resolve(__dirname, '..'));
    if (result.errors.length) {
      process.stderr.write(result.errors.join('\n') + '\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `文档结构检查通过：${result.documentCount} 份文档，${result.reachableCount} 份可达；本地链接、锚点、旧路径与 npm 命令通过。\n`
      );
    }
  } catch (error) {
    process.stderr.write(`文档结构检查失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { checkDocumentation, parseMarkdown };
