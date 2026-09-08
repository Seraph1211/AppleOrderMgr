# 第三方依赖制品

> 状态：当前有效；核对日期：2026-09-09；范围：构建所需的公开第三方依赖，不包含业务数据或凭据。

## SheetJS Community Edition

- 文件：`xlsx-0.20.3.tgz`，通过 `file:vendor/xlsx-0.20.3.tgz` 安装为 `xlsx`。
- 官方来源：[0.20.3 制品](https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz)，依据[官方安装说明](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)。
- SHA-256：`8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`；npm 锁文件另记录 SHA-512 integrity。
- 许可：Apache-2.0，原始许可包含在压缩包 `package/LICENSE` 中；不修改第三方代码。
- npm registry 停留在旧版本，固定官方制品避免安装时再次依赖 CDN 可用性。更新时必须重新核对来源、许可、校验值、审计和导入导出回归，不直接覆盖文件或篡改版本号规避审计。

校验入口：`npm run security:verify-vendor`。生产、迁移和开发 Docker 安装阶段均复制该包并验证 SHA-256；运行阶段仅携带安装后的依赖。
