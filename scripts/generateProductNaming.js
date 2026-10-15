/** 从后端纯规则生成浏览器 ESM；--check 用于验证制品一致。 */
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/utils/productNaming.js'), 'utf8');
const embedded = source.replace(
  "require('../data/productNamingV20261015.json')",
  JSON.stringify(require('../src/data/productNamingV20261015.json'))
);
const generated =
  '// 自动生成，请修改 src/utils/productNaming.js 后运行 node scripts/generateProductNaming.js。\n' +
  embedded.replace(/module\.exports = (\{[\s\S]*\});\s*$/, 'export $1;\n');
const target = path.join(__dirname, '../frontend/src/utils/productNaming.js');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== generated) throw new Error('商品命名浏览器规则未同步');
} else fs.writeFileSync(target, generated);
