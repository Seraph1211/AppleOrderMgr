/* eslint-env node */
/* eslint-disable no-magic-numbers -- 发布制品摘要长度与 AST 字段是格式约定 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const parser = require('@babel/parser');
const esbuild = require('../../../frontend/node_modules/esbuild');
const postcss = require('../../../frontend/node_modules/postcss');
const repo = path.resolve(__dirname, '../../..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

/** 从已发布公开树构造限定制品，保留其他路由的函数及既有资源。失败时不产生可发布清单。 */
async function main() {
  try {
    const [baseline, output, beforeCssFile, afterCssFile] = process.argv
      .slice(2)
      .map(value => path.resolve(value));
    assert(baseline !== output && !output.startsWith(`${baseline}/`), '输出不能覆盖基线');
    assert(!fs.existsSync(output), '输出目录必须不存在');
    const html = fs.readFileSync(path.join(baseline, 'index.html'), 'utf8');
    const entry = html.match(/<script[^>]+src="(\/assets\/[^"?]+\.js)"/)[1];
    const original = fs.readFileSync(path.join(baseline, entry), 'utf8');
    const ast = parser.parse(original, { sourceType: 'module' });
    const functions = ast.program.body.filter(node => node.type === 'FunctionDeclaration');
    const source = node => original.slice(node.start, node.end);
    const one = (items, description) => {
      assert.equal(items.length, 1, `${description}必须唯一，实际${items.length}`);
      return items[0];
    };
    const orders = one(
      functions.filter(
        node => source(node).includes('全选本页') && source(node).includes('订单管理')
      ),
      '订单路由组件'
    );
    const layout = one(
      functions.filter(node => source(node).includes('navigation-groups:v1:')),
      '共享导航组件'
    );
    const auth = one(
      functions.filter(node => source(node).includes('useAuth must be used within')),
      '现有认证上下文'
    );
    const react = source(auth).match(/(\w+)\.useContext\(/)[1];
    const location = one(
      functions.filter(node => source(node).includes('useLocation() may be used only')),
      '路由位置'
    );
    const navigation = one(
      functions.filter(node => /function \w+\(\)\{let\{isDataRoute:/.test(source(node))),
      '路由跳转'
    );
    const linkRenderer = one(
      functions.filter(
        node =>
          source(node).includes('"aria-current"') &&
          source(node).includes('.href') &&
          source(node).includes('pathname:')
      ),
      '导航链接'
    );
    const link = source(linkRenderer).match(/\.jsxs\((\w+),/)[1];
    const portal = original.match(/(\w+)\.createPortal\(/)[1];
    const navigationConfig = fs.readFileSync(
      path.join(repo, 'frontend/src/constants/navigation.js'),
      'utf8'
    );
    // 配置直接沿用当前生产定义，避免本次发布改变菜单权限或名称。
    const navGroups = source(layout).match(/filter\(\w+=>(\w+)\.some\(/)[1];
    const visible = one(
      functions.filter(
        node =>
          source(node).includes('adminOnly') &&
          source(node).includes('children:') &&
          source(node).includes('.filter(')
      ),
      '原菜单权限过滤'
    );
    const active = one(
      functions.filter(node => /return \w+===\w+\.href\|\|!\w+\.exact/.test(source(node))),
      '原路由选中判定'
    );
    const dashboard = original.match(/(?:const|,)\s*(\w+)=\{name:"仪表板",href:"\/"/)[1];
    const profile = original.match(/(?:const|,)\s*(\w+)=\{name:"个人设置",href:"\/profile"/)[1];
    const permissions = original.match(/(\w+)\.ORDERS_READ/)[1];
    const facade = {
      react: `const React=${react}; export default React; ${['Children', 'Component', 'Fragment', 'PureComponent', 'cloneElement', 'createContext', 'createElement', 'forwardRef', 'isValidElement', 'memo', 'useCallback', 'useContext', 'useEffect', 'useId', 'useImperativeHandle', 'useLayoutEffect', 'useMemo', 'useReducer', 'useRef', 'useState', 'useSyncExternalStore'].map(name => `export const ${name}=React.${name};`).join('')}`,
      'react-dom': `export const createPortal=${portal}.createPortal;`,
      'react/jsx-runtime': `export const jsx=${original.match(/\.render\((\w+)\.jsx/)[1]}.jsx,jsxs=${original.match(/\.render\((\w+)\.jsx/)[1]}.jsxs,Fragment=${react}.Fragment;`,
      'react-router-dom': `export const Link=${link},useLocation=${location.id.name},useNavigate=${navigation.id.name};`,
      auth: `export const useAuth=${auth.id.name};`,
      permissions: `export const PERMISSIONS=${permissions};`,
      navigation: `export const DASHBOARD_NAVIGATION=${dashboard},PROFILE_NAVIGATION=${profile},NAVIGATION_GROUPS=${navGroups},getVisibleNavigationGroups=${visible.id.name},isNavigationItemActive=${active.id.name};`,
    };
    const build = await esbuild.build({
      stdin: {
        contents:
          "export { default as Orders } from './frontend/src/pages/Orders.jsx'; export { default as Layout } from './frontend/src/components/Layout.jsx';",
        resolveDir: repo,
        loader: 'js',
      },
      bundle: true,
      write: false,
      minify: true,
      format: 'iife',
      globalName: 'OrdersUiV1',
      metafile: true,
      platform: 'browser',
      target: 'es2022',
      jsx: 'transform',
      jsxFactory: '__ordersReact.createElement',
      jsxFragment: '__ordersReact.Fragment',
      banner: { js: `var __ordersReact=${react};` },
      define: {
        'import.meta.env': JSON.stringify({
          MODE: 'production',
          DEV: false,
          PROD: true,
          VITE_API_BASE_URL: '/api',
        }),
        'process.env.NODE_ENV': '"production"',
      },
      plugins: [
        {
          name: 'reuse-production-context',
          setup(buildApi) {
            buildApi.onResolve(
              { filter: /^(react|react-dom|react-router-dom|react\/jsx-runtime)$/ },
              args => ({ path: args.path, namespace: 'production' })
            );
            buildApi.onResolve({ filter: /contexts\/AuthContext$/ }, () => ({
              path: 'auth',
              namespace: 'production',
            }));
            buildApi.onResolve({ filter: /constants\/permissions$/ }, () => ({
              path: 'permissions',
              namespace: 'production',
            }));
            buildApi.onResolve({ filter: /constants\/navigation$/ }, () => ({
              path: 'navigation',
              namespace: 'production',
            }));
            buildApi.onLoad({ filter: /.*/, namespace: 'production' }, args => ({
              contents: facade[args.path],
              loader: 'js',
            }));
            buildApi.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
          },
        },
      ],
    });
    const overlay = build.outputFiles[0].text;
    const root = one(
      ast.program.body.filter(
        node =>
          node.type === 'ExpressionStatement' &&
          source(node).includes('createRoot(document.getElementById("root"))')
      ),
      '原页面挂载'
    );
    const replacements = [
      {
        start: orders.start,
        end: orders.end,
        text: `function ${orders.id.name}(props){return OrdersUiV1.Orders(props)}`,
      },
      {
        start: layout.start,
        end: layout.end,
        text: `function ${layout.id.name}(props){return OrdersUiV1.Layout(props)}`,
      },
      { start: root.start, end: root.start, text: overlay },
    ].sort((a, b) => b.start - a.start);
    let next = original;
    for (const item of replacements)
      next = next.slice(0, item.start) + item.text + next.slice(item.end);
    parser.parse(next, { sourceType: 'module' });
    // 校验除两个目标函数和新增模块外，其余 AST 顶层语句逐字节保持。
    const kept = ast.program.body.filter(node => node !== orders && node !== layout).map(source);
    assert(
      kept.every(statement => next.includes(statement)),
      '范围外顶层语句必须逐字节保留'
    );
    const beforeCss = postcss.parse(fs.readFileSync(beforeCssFile, 'utf8'));
    const afterCss = postcss.parse(fs.readFileSync(afterCssFile, 'utf8'));
    const known = new Set();
    beforeCss.walkRules(rule => known.add(rule.toString()));
    const extras = postcss.root();
    afterCss.walkRules(rule => {
      if (
        known.has(rule.toString()) ||
        /order-|orders-|app-sidebar|data-orders-ui/.test(rule.selector)
      )
        return;
      if (rule.parent.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;
      const clone = rule.clone();
      clone.selector = rule.selectors
        .flatMap(selector =>
          ['.orders-workspace', '[data-orders-ui]', '.app-sidebar'].flatMap(scope => [
            `${scope} ${selector}`,
            `${scope}${selector}`,
          ])
        )
        .join(',');
      let wrapped = clone;
      for (let parent = rule.parent; parent.type !== 'root'; parent = parent.parent)
        wrapped = postcss.atRule({ name: parent.name, params: parent.params }).append(wrapped);
      extras.append(wrapped);
    });
    const css =
      extras.toString() +
      '\n' +
      [
        'frontend/src/components/appSidebar.css',
        'frontend/src/components/orderOverlay.css',
        'frontend/src/pages/ordersWorkspace.css',
      ]
        .map(file => fs.readFileSync(path.join(repo, file), 'utf8'))
        .join('\n');
    fs.cpSync(baseline, output, { recursive: true });
    const jsName = `orders-ui-${digest(next).slice(0, 12)}.js`,
      cssName = `orders-ui-${digest(css).slice(0, 12)}.css`;
    fs.writeFileSync(path.join(output, 'assets', jsName), next);
    fs.writeFileSync(path.join(output, 'assets', cssName), css);
    // 懒加载库存模块回引入口的共享导出，必须指向同一个模块实例，避免再次挂载应用。
    const importRewrites = [];
    for (const file of fs
      .readdirSync(path.join(output, 'assets'))
      .filter(name => name.endsWith('.js') && name !== jsName)) {
      const target = path.join(output, 'assets', file);
      const content = fs.readFileSync(target, 'utf8');
      const updated = content.replaceAll(path.basename(entry), jsName);
      if (content !== updated) {
        fs.writeFileSync(target, updated);
        importRewrites.push({
          file,
          beforeSha256: digest(content),
          afterSha256: digest(updated),
          kind: '仅入口引用路径',
        });
      }
    }

    fs.copyFileSync(
      path.join(repo, 'frontend/public/order-mark-blue.png'),
      path.join(output, 'order-mark-blue.png')
    );
    fs.writeFileSync(
      path.join(output, 'index.html'),
      html
        .replace(entry, `/assets/${jsName}`)
        .replace('</head>', `<link rel="stylesheet" href="/assets/${cssName}"></head>`)
    );
    const manifest = {
      baselineEntry: entry,
      baselineSha256: digest(original),
      entry: `/assets/${jsName}`,
      css: `/assets/${cssName}`,
      onlyReplacedFunctions: [orders.id.name, layout.id.name],
      importRewrites,
      preservedTopLevelStatements: kept.length,
      sourceHashes: Object.fromEntries(
        Object.keys(build.metafile.inputs)
          .filter(file => !file.startsWith('production:') && !file.startsWith('<'))
          .map(file => [file, digest(fs.readFileSync(path.resolve(repo, file)))])
      ),
      navigationSourceSha256: digest(navigationConfig),
      sourceCommit: require('node:child_process')
        .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })
        .trim(),
    };
    fs.writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2));
    process.stdout.write(
      JSON.stringify({
        entry: manifest.entry,
        css: manifest.css,
        preservedTopLevelStatements: kept.length,
      }) + '\n'
    );
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  }
}
main();
