const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 同步后端白名单到浏览器制品，确保两端使用相同字段投影。 */
function packageBrowserCollector() {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'src/services/crawler/browserOrderPayload.js');
  const destination = path.join(root, 'frontend/public/browser-collector/orderPayload.js');
  fs.copyFileSync(source, destination);
  const publicRoot = path.join(root, 'frontend/public');
  const archive = path.join(publicRoot, 'browser-collector.zip');
  if (fs.existsSync(archive)) fs.unlinkSync(archive);
  execFileSync(
    'zip',
    [
      '-q',
      archive,
      ...['manifest.json', 'background.js', 'orderPayload.js', 'README.txt'].map(
        name => `browser-collector/${name}`
      ),
    ],
    { cwd: publicRoot }
  );
}

if (require.main === module) packageBrowserCollector();
module.exports = { packageBrowserCollector };
