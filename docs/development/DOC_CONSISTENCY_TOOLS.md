# 文档一致性管理工具

## 📚 概述

本项目提供了一套工具来确保代码与文档的一致性，特别是数据库 Model 与 `docs/database/SCHEMA.md` 的同步。

## 🔧 工具列表

### 1. 文档一致性检查脚本

**文件**: `scripts/check-doc-consistency.js`

**功能**:
- 检查 SCHEMA.md 中定义的表是否都有对应的 Model 文件
- 检查 Model 文件是否在 SCHEMA.md 中有文档
- 检查字段一致性（字段名是否匹配）

**使用方法**:
```bash
node scripts/check-doc-consistency.js
```

**输出示例**:
```
═══════════════════════════════════════════
  📚 文档一致性检查工具
═══════════════════════════════════════════

发现 5 个表定义
发现 5 个 Model 文件

📋 检查 1: SCHEMA.md 中定义的表是否有对应的 Model
  ✅ 表 "apple_ids" 有对应的 Model
  ✅ 表 "recipients" 有对应的 Model
  ✅ 表 "orders" 有对应的 Model
  ✅ 表 "email_logs" 有对应的 Model
  ✅ 表 "crawl_logs" 有对应的 Model
  🎉 所有表都有对应的 Model 文件

📋 检查 2: Model 文件是否在 SCHEMA.md 中有文档
  ✅ Model "AppleId" 有文档
  ✅ Model "Recipient" 有文档
  ✅ Model "Order" 有文档
  ✅ Model "EmailLog" 有文档
  ✅ Model "CrawlLog" 有文档
  🎉 所有 Model 都有文档

📋 检查 3: 字段一致性检查
  ✅ 检查完成

═══════════════════════════════════════════
  ✅ 检查完成，未发现严重错误
═══════════════════════════════════════════
```

---

### 2. Git Pre-commit Hook

**文件**: `scripts/pre-commit-check.sh`

**功能**:
- 检测 Model 文件变更时是否更新了 SCHEMA.md
- 检测 Controller 变更时是否更新了 API 文档
- 提醒更新开发进度文档
- 运行文档一致性检查
- 运行代码规范检查（lint）

**安装方法**:

#### 方法 1: 手动安装
```bash
# 赋予执行权限
chmod +x scripts/pre-commit-check.sh

# 创建软链接到 .git/hooks
ln -sf ../../scripts/pre-commit-check.sh .git/hooks/pre-commit
```

#### 方法 2: 使用 husky（推荐）
```bash
# 安装 husky
npm install husky --save-dev

# 初始化 husky
npx husky install

# 添加 pre-commit hook
npx husky add .git/hooks/pre-commit "bash scripts/pre-commit-check.sh"
```

**验证安装**:
```bash
# 尝试提交一个修改了 Model 但未更新 SCHEMA.md 的变更
git add src/models/Order.js
git commit -m "test"

# 应该会看到错误提示
```

---

## 📋 文件变更检查清单

### 当你修改数据库表结构时

**必须按顺序完成**:

```bash
# 1. 先更新权威文档
vim docs/database/SCHEMA.md

# 2. 更新 Model 定义
vim src/models/Order.js

# 3. 创建 Migration
npx sequelize-cli migration:generate --name add-priority-to-orders
vim migrations/XXXXXX-add-priority-to-orders.js

# 4. 如果接口涉及此字段，更新 API 文档
vim docs/design/api-design.md

# 5. 更新 Controller（如需要）
vim src/controllers/orderController.js

# 6. 添加测试
vim test/models/order.test.js

# 7. 运行检查
npm test
npm run lint
node scripts/check-doc-consistency.js

# 8. 更新进度文档
vim docs/development/DEVELOPMENT_PROGRESS.md

# 9. 提交变更
git add .
git commit -m "feat: 为订单添加优先级字段"
```

---

## 🚨 常见错误和解决方法

### 错误 1: 修改了 Model 但未更新 SCHEMA.md

**错误信息**:
```
❌ 错误: 修改了 Model 文件但未更新 docs/database/SCHEMA.md
```

**解决方法**:
1. 先更新 `docs/database/SCHEMA.md`，添加新字段的定义
2. 然后再提交代码

---

### 错误 2: SCHEMA.md 中有表定义，但没有对应的 Model

**错误信息**:
```
❌ 表 "orders" 在 SCHEMA.md 中定义，但没有对应的 Model 文件
```

**解决方法**:
1. 创建对应的 Model 文件 `src/models/Order.js`
2. 或者从 SCHEMA.md 中删除该表定义（如果不再需要）

---

### 错误 3: Model 中有字段，但 SCHEMA.md 中未找到文档

**错误信息**:
```
⚠️  字段 "priority" 在 Model 中定义，但 SCHEMA.md 中未找到文档
```

**解决方法**:
1. 在 `docs/database/SCHEMA.md` 中添加该字段的文档
2. 包括字段名、类型、约束、说明

---

## 🔄 CI/CD 集成

### GitHub Actions 示例

创建 `.github/workflows/doc-consistency.yml`:

```yaml
name: 文档一致性检查

on:
  pull_request:
    paths:
      - 'src/models/**'
      - 'docs/database/SCHEMA.md'

jobs:
  check-consistency:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: 设置 Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: 安装依赖
        run: npm ci

      - name: 运行文档一致性检查
        run: node scripts/check-doc-consistency.js

      - name: 运行代码规范检查
        run: npm run lint
```

---

## 💡 最佳实践

### 1. 开发流程

```
1. 阅读 CLAUDE.md 中的"文件变更级联规则"
   ↓
2. 先更新文档（SCHEMA.md/api-design.md）
   ↓
3. 实现代码（Model/Controller/Service）
   ↓
4. 创建 Migration（如果是数据库变更）
   ↓
5. 编写测试
   ↓
6. 运行检查工具
   ↓
7. 更新 DEVELOPMENT_PROGRESS.md
   ↓
8. 提交代码
```

### 2. 使用 npm scripts

在 `package.json` 中添加：

```json
{
  "scripts": {
    "check:docs": "node scripts/check-doc-consistency.js",
    "precommit": "bash scripts/pre-commit-check.sh"
  }
}
```

然后可以使用：

```bash
npm run check:docs
npm run precommit
```

### 3. 定期审查

建议每周运行一次完整检查：

```bash
# 完整检查清单
npm run check:docs    # 文档一致性
npm run lint          # 代码规范
npm test              # 测试
```

---

## 📞 获取帮助

- 查看 `CLAUDE.md` 中的"文件变更级联规则"章节
- 查看 `docs/database/SCHEMA.md` 了解数据库设计规范
- 查看 `docs/development/CODING_STANDARDS.md` 了解编码规范

---

## 🔧 故障排查

### 脚本执行失败

如果脚本无法执行，检查：

```bash
# 1. 检查执行权限
ls -la scripts/check-doc-consistency.js
ls -la scripts/pre-commit-check.sh

# 2. 赋予执行权限
chmod +x scripts/check-doc-consistency.js
chmod +x scripts/pre-commit-check.sh

# 3. 检查 Node.js 版本
node --version  # 需要 Node.js 14+
```

### Pre-commit Hook 不生效

```bash
# 1. 检查 hook 是否安装
ls -la .git/hooks/pre-commit

# 2. 检查 hook 文件内容
cat .git/hooks/pre-commit

# 3. 重新安装
rm .git/hooks/pre-commit
ln -sf ../../scripts/pre-commit-check.sh .git/hooks/pre-commit
```

---

**最后更新**: 2026-07-08  
**维护者**: Kiro
