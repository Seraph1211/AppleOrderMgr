# Claude Agents 协作系统

## 概述

基于 Claude Code Workflow 的 Multi-Agent 协作系统，实现串行开发流水线：

**需求澄清 → 需求分析 → 代码实现 → 测试验收 → 修复验证**

## 核心特性

✨ **需求澄清机制** - Agent 会主动提问了解需求细节  
🔍 **全面测试验收** - 自动化测试 + 手动验证 + 截图证据  
🔄 **自动修复机制** - 测试失败时自动定位问题并修复  
📊 **结构化输出** - JSON Schema 强制结构化，避免解析错误  
🎯 **职责分离** - 每个阶段由专门的 Sub Agent 负责

---

## 使用方法

### 1. 启动开发流水线

**方式 1: 自然语言（推荐）**

在 Claude Code 中直接告诉 Main Agent：

```
使用 dev-pipeline 开发这个需求：
添加订单批量导出功能，支持导出为 Excel
```

**如果需求不够明确**，Agent 会先向你提问：
```
⚠️ 需求需要澄清，共 3 个问题

1. 导出按钮放在哪里？
   - 订单列表页面右上角
   - 订单详情页面
   - 其他位置

2. 导出包含哪些字段？
   - 所有字段
   - 只包含基本信息（订单号、商品、状态）
   - 自定义选择字段

3. 导出前是否需要筛选？
   - 导出全部订单
   - 导出当前筛选结果
   - 导出选中的订单
```

回答问题后，Agent 会自动继续开发流程。

**方式 2: 直接调用 Workflow（高级）**

```javascript
// 第一次调用（可能需要澄清）
const result = await Workflow({
  scriptPath: '.claude-agents/workflows/dev-pipeline.js',
  args: {
    requirement: '添加订单批量导出功能',
    taskId: 'task-order-export-001'  // 可选：自定义任务 ID
  }
})

// 如果返回 needsClarification: true
if (result.needsClarification) {
  // 收集用户回答
  const answers = `
1. 放在订单列表页面右上角
2. 导出所有字段
3. 导出当前筛选结果
`
  
  // 第二次调用（带回答）
  await Workflow({
    scriptPath: '.claude-agents/workflows/dev-pipeline.js',
    args: {
      requirement: '添加订单批量导出功能',
      taskId: 'task-order-export-001',
      clarificationAnswers: answers  // 传入用户回答
    }
  })
}
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

串行开发流水线，包含 5 个阶段：

#### Phase 0: 需求澄清（新增 ✨）
- 分析需求是否清晰
- 如果需要，生成 2-5 个问题向用户提问
- 用户回答后，将完整需求传递给后续阶段

**提问场景**：
- 需求描述过于简略
- 涉及多个可能的实现方式
- 缺少关键的业务规则或边界条件

#### Phase 1: 需求分析
- 整理需求、拆分任务、生成开发计划
- 分析级联影响（数据库/API/前端变更）
- 输出结构化的任务列表

#### Phase 2: 代码实现
- 按照计划实现功能
- 遵循编码规范和级联规则
- 修改/新建文件

#### Phase 3: 测试验收（增强版 ✨）
- **自动化测试**：运行 `npm test` 和 `npm run lint`
- **项目启动验证**：检查启动无报错
- **手动功能验证**：
  - 前端改动：访问页面、验证 UI、生成截图
  - API 改动：curl 测试接口、验证响应
  - 数据库改动：验证 migration、测试数据操作
- **生成测试报告**：包含截图/日志等证据

#### Phase 4: 修复验证（如果测试失败）
- 根据测试报告修复问题
- 重新运行测试
- 直到测试通过或需要人工介入

## 任务状态文件格式

```json
{
  "taskId": "task-1721280000000",
  "requirement": "添加订单批量导出功能",
  "timestamp": "2026-07-19T12:00:00.000Z",
  "phase": "completed",
  "clarification": {
    "needsClarification": false,
    "questions": [],
    "analysis": "需求明确，无需提问"
  },
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
    "testsFailed": 0,
    "lintPassed": true,
    "projectStarted": true,
    "manualChecks": {
      "uiVerified": true,
      "apiVerified": true,
      "dbVerified": false
    },
    "screenshots": ["/tmp/test-ui-screenshot.png"]
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
4. **测试要求**: 所有代码必须通过 `npm test`、`npm run lint` 和手动验证
5. **需求澄清**: 如果需求不明确，会先提问再开发，避免理解偏差
6. **测试证据**: 测试 Agent 会生成截图或日志作为验证证据

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
