#!/bin/bash
# 初始化 Claude Agents 协作系统

echo "🚀 初始化 Claude Agents 协作系统..."

# 创建目录结构
mkdir -p .claude-agents/workflows
mkdir -p .claude-agents/tasks
mkdir -p .claude-agents/schemas

echo "✅ 目录结构创建完成"

# 添加到 .gitignore
if ! grep -q ".claude-agents/tasks/" .gitignore; then
  echo "" >> .gitignore
  echo "# Claude Agents 任务状态（临时文件）" >> .gitignore
  echo ".claude-agents/tasks/" >> .gitignore
  echo "✅ 已添加到 .gitignore"
else
  echo "ℹ️  .gitignore 已包含 .claude-agents/tasks/"
fi

# 创建 README
cat > .claude-agents/README.md << 'EOF'
# Claude Agents 协作系统

## 概述

基于 Claude Code Workflow 的 Multi-Agent 协作系统，实现串行开发流水线：

**需求分析 → 代码实现 → 测试验收 → 修复验证**

## 使用方法

### 1. 启动开发流水线

**方式 1: 自然语言（推荐）**

在 Claude Code 中直接告诉 Main Agent：

```
使用 dev-pipeline 开发这个需求：
添加订单批量导出功能，支持导出为 Excel，包含订单号、商品、状态、取机人等信息。
```

**方式 2: 直接调用 Workflow**

```javascript
Workflow({
  scriptPath: '.claude-agents/workflows/dev-pipeline.js',
  args: {
    requirement: '添加订单批量导出功能，支持导出为 Excel',
    taskId: 'task-order-export-001'  // 可选：自定义任务 ID
  }
})
```

### 2. 查看任务状态

```bash
# 查看最新任务
ls -lt .claude-agents/tasks/ | head -n 1

# 查看任务详情
cat .claude-agents/tasks/task-1721280000000.json

# 查看所有任务
ls -lh .claude-agents/tasks/
```

### 3. 实时进度

Workflow 会自动显示进度条，包含：
- 当前 Phase（需求分析 / 代码实现 / 测试验收 / 修复验证）
- Sub Agent 执行状态
- 日志输出

## 目录结构

```
.claude-agents/
├── workflows/               # Workflow 脚本
│   └── dev-pipeline.js      # 主开发流水线
├── tasks/                   # 任务状态文件（Git 忽略）
│   ├── task-001.json        # 任务 1 的状态
│   └── task-002.json        # 任务 2 的状态
├── schemas/                 # JSON Schema 定义（可选）
├── init.sh                  # 初始化脚本
└── README.md                # 本文档
```

## Workflow 说明

### dev-pipeline.js

串行开发流水线，包含 4 个阶段：

#### Phase 1: 需求分析
- 整理需求、拆分任务、生成开发计划
- 分析级联影响（数据库/API/前端变更）
- 输出结构化的任务列表

#### Phase 2: 代码实现
- 按照计划实现功能
- 遵循编码规范和级联规则
- 修改/新建文件

#### Phase 3: 测试验收
- 运行 `npm test` 和 `npm run lint`
- 验证代码质量
- 生成测试报告

#### Phase 4: 修复验证（如果测试失败）
- 根据测试报告修复问题
- 重新运行测试
- 直到测试通过或需要人工介入

## 任务状态文件格式

```json
{
  "taskId": "task-1721280000000",
  "requirement": "添加订单批量导出功能",
  "timestamp": "2026-07-18T12:00:00.000Z",
  "phase": "completed",
  "requirements": {
    "summary": "...",
    "tasks": [...],
    "technicalApproach": "...",
    "estimatedComplexity": "medium"
  },
  "codeResult": {
    "completedTasks": [...],
    "modifiedFiles": [...],
    "newFiles": [...]
  },
  "testResult": {
    "passed": true,
    "testsPassed": 15,
    "testsFailed": 0
  }
}
```

## 多项目复用

### 步骤 1: 复制目录

```bash
cp -r /path/to/old-project/.claude-agents /path/to/new-project/
```

### 步骤 2: 初始化

```bash
cd /path/to/new-project
bash .claude-agents/init.sh
```

### 步骤 3: 调整 Workflow（如有需要）

编辑 `.claude-agents/workflows/dev-pipeline.js`，修改项目相关的提示词：

```javascript
**项目上下文**:
- 项目类型: [新项目类型]
- 技术栈: [新技术栈]
- 必须遵循: [新项目的编码规范文档]
```

## 注意事项

1. **任务状态文件**: `.claude-agents/tasks/` 目录已添加到 `.gitignore`，不会提交到版本库
2. **编码规范**: Sub Agents 会严格遵循项目的编码规范（docs/development/编码规范.md）
3. **级联规则**: 涉及数据库/API 变更时，会自动更新相关文档
4. **测试要求**: 所有代码必须通过 `npm test` 和 `npm run lint`

## 故障排除

### Q: Workflow 调用失败
A: 检查 `.claude-agents/workflows/dev-pipeline.js` 是否存在，路径是否正确

### Q: Sub Agent 未返回结果
A: 可能是 Agent 超时或出错，查看 Workflow 日志了解详情

### Q: 测试一直失败
A: 修复 Sub Agent 会尝试自动修复，如果仍然失败，需要人工介入检查代码

## 相关文档

- [MULTI_AGENT_COLLABORATION.md](../../MULTI_AGENT_COLLABORATION.md) - 完整设计文档
- [CLAUDE.md](../../CLAUDE.md) - 项目开发指南
- [docs/development/编码规范.md](../../docs/development/编码规范.md) - 编码规范

---

**初始化完成！可以开始使用 Multi-Agent 协作系统了** 🚀
EOF

echo "✅ README.md 创建完成"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 初始化完成！"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📖 使用说明: cat .claude-agents/README.md"
echo "🚀 开始使用: 在 Claude Code 中说 '使用 dev-pipeline 开发这个需求：...'"
echo ""
