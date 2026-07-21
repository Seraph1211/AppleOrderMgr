# Multi-Agent 协作系统设计文档

> **项目**: Apple 订单管理系统  
> **文档版本**: v1.0  
> **创建日期**: 2026-07-18  
> **作者**: Main Agent 规划

---

## 📋 目录

- [1. 项目背景](#1-项目背景)
- [2. 设计目标](#2-设计目标)
- [3. 技术选型](#3-技术选型)
- [4. 架构设计](#4-架构设计)
- [5. 实现方案](#5-实现方案)
- [6. 使用指南](#6-使用指南)
- [7. 下一步计划](#7-下一步计划)

---

## 1. 项目背景

### 1.1 需求来源

随着项目复杂度增加，单个 Agent 处理开发任务存在以下问题：

- **上下文混乱**: 需求分析、代码实现、测试验收混在一起
- **职责不清**: 没有明确的分工和检查机制
- **质量不稳定**: 容易遗漏测试或代码规范检查
- **难以复用**: 开发流程无法标准化和跨项目复用

### 1.2 解决方案

采用 **Main Agent + Sub Agent** 协作模式：

- **Main Agent**: 负责任务调度、进度协调、结果汇总
- **Sub Agent**: 专注于特定职责（需求分析、代码实现、测试验收）

---

## 2. 设计目标

### 2.1 核心目标

1. **职责分离**: 每个 Sub Agent 专注一个领域，提高专业性
2. **流程标准化**: 统一的开发流水线，确保质量一致性
3. **可复用性**: 协作系统独立于项目，可在多个项目中使用
4. **自动化**: 减少人工介入，自动完成测试和验证

### 2.2 设计约束

- ✅ **串行执行**: 需求分析 → 代码实现 → 测试验收（不考虑并发）
- ✅ **回退修复**: 测试失败时，自动进入修复流程
- ✅ **独立运行**: 与项目代码解耦，不修改项目结构
- ✅ **文件存储**: 状态存储在文件系统，不依赖数据库

---

## 3. 技术选型

### 3.1 Agent 工具 vs Workflow 工具

#### Agent 工具（单个子会话）

```bash
# 用法示例
Agent(
  description: "分析需求",
  prompt: "请分析这个需求并拆分成开发任务：...",
  subagent_type: "general-purpose"
)
```

**特点**：
- ✅ 启动一个新的 Claude 子会话
- ✅ 子会话有独立上下文和工具访问权限
- ✅ 适合单个复杂任务，Agent 可以自主决策
- ❌ 多个 Agent 之间需要**手动协调**（你要自己管理状态传递）
- ❌ 没有内置的串行/并行编排能力

**适用场景**: 启动 1-2 个独立的子任务

---

#### Workflow 工具（编排脚本）

```javascript
// 用法示例：workflow.js
export const meta = {
  name: 'dev-pipeline',
  description: '需求分析 → 代码实现 → 测试验收',
  phases: [
    { title: '需求分析', detail: '整理和拆分需求' },
    { title: '代码实现', detail: '开发功能' },
    { title: '测试验收', detail: '自动化测试+规范检查' }
  ]
}

// 串行执行三个 Sub Agents
phase('需求分析')
const requirements = await agent('分析需求并拆分任务', {
  schema: REQUIREMENT_SCHEMA  // 结构化输出
})

phase('代码实现')
const codeResult = await agent('实现这些任务: ' + JSON.stringify(requirements))

phase('测试验收')
const testResult = await agent('运行测试和代码规范检查')
```

**特点**：
- ✅ JavaScript 脚本，支持 `agent()` 调用多个 Sub Agents
- ✅ **内置编排**: `phase()` 分阶段、`pipeline()` 流水线、`parallel()` 并行
- ✅ **结构化输出**: 用 JSON Schema 强制 Agent 返回结构化数据
- ✅ **进度展示**: 自动显示每个阶段的进度条
- ✅ **可复用**: 保存为 `.js` 文件，跨项目使用
- ❌ 需要学习 Workflow 脚本语法（但很简单）

**适用场景**: 需要协调 3+ 个 Agent，或有串行/并行需求

---

### 3.2 最终选型：**Workflow**

**决策理由**：

| 需求 | Agent 工具 | Workflow 工具 | 结论 |
|-----|-----------|--------------|------|
| 串行执行 | ❌ 需要手动协调 | ✅ 内置 phase() | ✅ Workflow |
| 回退修复 | ⚠️ 需要复杂逻辑 | ✅ 简单 if/else | ✅ Workflow |
| 多项目复用 | ❌ 难以标准化 | ✅ 保存为 .js 文件 | ✅ Workflow |
| 结构化输出 | ❌ 需要手动解析 | ✅ 内置 schema 支持 | ✅ Workflow |
| 进度展示 | ❌ 无 | ✅ 自动显示 | ✅ Workflow |

**结论**: 使用 **Workflow 工具** 作为主框架。

---

## 4. 架构设计

### 4.1 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                     用户（Main Agent）                    │
│  告诉需求 → 启动 Workflow → 查看进度 → 获取结果           │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Workflow: dev-pipeline.js                   │
│  orchestrates 三个 Sub Agents 串行执行                    │
└────────────────────┬────────────────────────────────────┘
                     │
         ┌───────────┴───────────┬───────────────┐
         ▼                       ▼               ▼
   ┌──────────┐          ┌──────────┐     ┌──────────┐
   │ Sub Agent│          │ Sub Agent│     │ Sub Agent│
   │  需求分析 │  →       │  代码实现 │  →  │  测试验收 │
   └──────────┘          └──────────┘     └──────────┘
         │                       │               │
         └───────────┬───────────┴───────────────┘
                     ▼
         ┌────────────────────────┐
         │  状态文件（文件系统）    │
         │  .claude-agents/       │
         │    └─ task-{id}.json   │
         └────────────────────────┘
```

### 4.2 工作流示意图

```
用户输入需求
    ↓
Main Agent 接收
    ↓
调用 Workflow({ 
  scriptPath: '.claude-agents/workflows/dev-pipeline.js',
  args: { requirement: '...' } 
})
    ↓
┌─────────────────────────────────────────┐
│ Workflow: dev-pipeline.js                │
├─────────────────────────────────────────┤
│ Phase 1: 需求分析                         │
│   └─ agent('分析需求', { schema })       │
│        ↓ 返回结构化数据                   │
│   └─ 保存到 .claude-agents/tasks/xxx.json│
├─────────────────────────────────────────┤
│ Phase 2: 代码实现                         │
│   └─ agent('实现任务', { schema })       │
│        ↓ 修改文件、创建文件               │
│   └─ 更新任务状态                        │
├─────────────────────────────────────────┤
│ Phase 3: 测试验收                         │
│   └─ agent('运行测试', { schema })       │
│        ↓ npm test + npm run lint        │
│   └─ 如果失败 → Phase 4                  │
├─────────────────────────────────────────┤
│ Phase 4: 修复验证（如需要）               │
│   └─ agent('修复问题', { schema })       │
│        ↓ 修复代码                        │
│   └─ 重新运行测试                        │
└─────────────────────────────────────────┘
    ↓
返回最终结果给 Main Agent
    ↓
Main Agent 向用户展示结果
```

### 4.3 数据流

```
[用户需求]
    ↓
[需求分析 Sub Agent]
    ↓ 输出: requirements.json (结构化)
    └─ { summary, tasks[], technicalApproach, complexity }
    ↓
[代码实现 Sub Agent]
    ↓ 输出: codeResult.json (结构化)
    └─ { completedTasks[], modifiedFiles[], newFiles[], summary }
    ↓
[测试验收 Sub Agent]
    ↓ 输出: testResult.json (结构化)
    └─ { passed, testsPassed, testsFailed, lintPassed, errors[], summary }
    ↓
[如果 testResult.passed === false]
    ↓
[修复 Sub Agent]
    ↓ 输出: fixResult.json
    └─ { modifiedFiles[], summary }
    ↓
[重新测试]
    ↓
[最终结果]
    └─ 保存到 .claude-agents/tasks/task-{id}.json
```

---

## 5. 实现方案

### 5.1 目录结构

```
项目根目录/
├── .claude-agents/              # Agent 协作系统（Git 忽略）
│   ├── workflows/               # Workflow 脚本
│   │   └── dev-pipeline.js      # 主开发流水线
│   ├── tasks/                   # 任务状态文件（Git 忽略）
│   │   ├── task-001.json        # 任务 1 的状态
│   │   └── task-002.json        # 任务 2 的状态
│   ├── schemas/                 # JSON Schema 定义
│   │   ├── requirement.schema.js
│   │   ├── code-result.schema.js
│   │   └── test-result.schema.js
│   ├── init.sh                  # 初始化脚本
│   └── README.md                # 使用说明
│
├── .gitignore                   # 添加 .claude-agents/tasks/
└── MULTI_AGENT_COLLABORATION.md # 本文档
```

### 5.2 核心组件

#### 5.2.1 Workflow 脚本结构

**文件**: `.claude-agents/workflows/dev-pipeline.js`

```javascript
// 1. 元数据定义（必需）
export const meta = {
  name: 'dev-pipeline',
  description: '串行开发流水线：需求分析 → 代码实现 → 测试验收',
  phases: [
    { title: '需求分析', detail: '整理需求、拆分任务、生成开发计划' },
    { title: '代码实现', detail: '按照计划实现功能' },
    { title: '测试验收', detail: '自动化测试 + 代码规范检查' },
    { title: '修复验证', detail: '如果测试失败，修复并重新验证' }
  ]
}

// 2. JSON Schema 定义（结构化输出）
const REQUIREMENT_SCHEMA = { /* ... */ }
const CODE_RESULT_SCHEMA = { /* ... */ }
const TEST_RESULT_SCHEMA = { /* ... */ }

// 3. 主流程
const requirement = args.requirement || '未提供需求'
const taskId = args.taskId || `task-${Date.now()}`

// 4. Phase 1: 需求分析
phase('需求分析')
const requirements = await agent(analysisPrompt, {
  label: '需求分析 Sub Agent',
  schema: REQUIREMENT_SCHEMA
})

// 5. Phase 2: 代码实现
phase('代码实现')
const codeResult = await agent(implementationPrompt, {
  label: '代码实现 Sub Agent',
  schema: CODE_RESULT_SCHEMA
})

// 6. Phase 3: 测试验收
phase('测试验收')
let testResult = await agent(testPrompt, {
  label: '测试验收 Sub Agent',
  schema: TEST_RESULT_SCHEMA
})

// 7. Phase 4: 修复验证（如果测试失败）
if (!testResult.passed) {
  phase('修复验证')
  const fixResult = await agent(fixPrompt, {
    label: '修复 Sub Agent',
    schema: CODE_RESULT_SCHEMA
  })
  // 重新测试
  testResult = await agent(testPrompt, { schema: TEST_RESULT_SCHEMA })
}

// 8. 返回最终结果
return {
  success: testResult.passed,
  taskId,
  requirements,
  codeResult,
  testResult
}
```

#### 5.2.2 任务状态文件格式

**文件**: `.claude-agents/tasks/task-{timestamp}.json`

```json
{
  "taskId": "task-1721280000000",
  "requirement": "添加订单批量导出功能",
  "timestamp": "2026-07-18T12:00:00.000Z",
  "phase": "completed",
  "requirements": {
    "summary": "添加订单批量导出功能，支持导出为 Excel",
    "tasks": [
      {
        "id": "task-1",
        "title": "创建导出 API 接口",
        "description": "在 src/controllers/orderController.js 中添加导出接口",
        "files": ["src/controllers/orderController.js", "src/routes/orderRoutes.js"],
        "dependencies": []
      },
      {
        "id": "task-2",
        "title": "实现 Excel 生成逻辑",
        "description": "使用 exceljs 库生成 Excel 文件",
        "files": ["src/services/exportService.js"],
        "dependencies": ["task-1"]
      }
    ],
    "technicalApproach": "使用 exceljs 库生成 Excel，API 返回文件流",
    "estimatedComplexity": "medium"
  },
  "codeResult": {
    "completedTasks": ["task-1", "task-2"],
    "modifiedFiles": ["src/controllers/orderController.js", "src/routes/orderRoutes.js"],
    "newFiles": ["src/services/exportService.js", "test/services/exportService.test.js"],
    "summary": "已实现订单导出功能，包括 API 接口和 Excel 生成逻辑"
  },
  "testResult": {
    "passed": true,
    "testsPassed": 15,
    "testsFailed": 0,
    "lintPassed": true,
    "errors": [],
    "summary": "所有测试通过，代码规范检查通过"
  }
}
```

#### 5.2.3 初始化脚本

**文件**: `.claude-agents/init.sh`

```bash
#!/bin/bash
# 初始化 Agent 协作系统

echo "🚀 初始化 Claude Agents 协作系统..."

# 创建目录结构
mkdir -p .claude-agents/workflows
mkdir -p .claude-agents/tasks
mkdir -p .claude-agents/schemas

# 添加到 .gitignore
if ! grep -q ".claude-agents/tasks/" .gitignore; then
  echo "" >> .gitignore
  echo "# Claude Agents 任务状态（临时文件）" >> .gitignore
  echo ".claude-agents/tasks/" >> .gitignore
  echo "✅ 已添加到 .gitignore"
fi

# 创建 README
cat > .claude-agents/README.md << 'EOF'
# Claude Agents 协作系统

## 使用方法

### 1. 启动开发流水线

在 Claude Code 中运行：

\`\`\`
使用 dev-pipeline 开发这个需求：添加订单批量导出功能
\`\`\`

### 2. 查看任务状态

\`\`\`bash
cat .claude-agents/tasks/task-<timestamp>.json
\`\`\`
EOF

echo "✅ 初始化完成！"
```

---

## 6. 使用指南

### 6.1 首次使用：初始化系统

```bash
# 在项目根目录运行
bash .claude-agents/init.sh
```

### 6.2 启动开发任务

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

### 6.3 查看进度和结果

**实时进度**：Workflow 会自动显示进度条，包含：
- 当前 Phase（需求分析 / 代码实现 / 测试验收 / 修复验证）
- Sub Agent 执行状态
- 日志输出

**查看任务状态**：

```bash
# 查看最新任务
ls -lt .claude-agents/tasks/ | head -n 1

# 查看任务详情
cat .claude-agents/tasks/task-1721280000000.json

# 查看所有任务
ls -lh .claude-agents/tasks/
```

### 6.4 处理测试失败

如果测试失败，Workflow 会自动：

1. **Phase 4: 修复验证** 自动启动
2. 修复 Sub Agent 读取错误信息并修复代码
3. 重新运行测试验证
4. 更新任务状态文件

如果修复后仍然失败，Main Agent 会暂停并请求用户介入。

### 6.5 多项目复用

**步骤 1**: 复制 `.claude-agents/` 目录到新项目

```bash
cp -r /path/to/old-project/.claude-agents /path/to/new-project/
```

**步骤 2**: 在新项目中初始化

```bash
cd /path/to/new-project
bash .claude-agents/init.sh
```

**步骤 3**: 根据新项目调整 Workflow（如有需要）

编辑 `.claude-agents/workflows/dev-pipeline.js`，修改项目相关的提示词：

```javascript
**项目上下文**:
- 项目类型: [新项目类型]
- 技术栈: [新技术栈]
- 必须遵循: [新项目的编码规范文档]
```

---

## 7. 下一步计划

### 7.1 立即执行（Phase 1）

- [x] 设计架构和方案（已完成）
- [ ] 创建目录结构
  ```bash
  mkdir -p .claude-agents/{workflows,tasks,schemas}
  ```
- [ ] 编写完整的 `dev-pipeline.js` Workflow 脚本
- [ ] 创建初始化脚本 `init.sh`
- [ ] 更新 `.gitignore`
- [ ] 编写使用文档 `.claude-agents/README.md`

### 7.2 测试验证（Phase 2）

- [ ] 使用简单需求测试流程
  - 示例需求: "修改 README 添加使用说明"
- [ ] 验证 Sub Agent 串行执行
- [ ] 验证测试失败回退修复机制
- [ ] 验证任务状态文件正确保存

### 7.3 优化迭代（Phase 3）

- [ ] 优化 Sub Agent 提示词，提高输出质量
- [ ] 添加更多 JSON Schema 验证规则
- [ ] 支持多次修复重试（目前只重试 1 次）
- [ ] 添加任务历史记录和统计功能
- [ ] 创建其他 Workflow（如 `bug-fix-pipeline.js`、`refactor-pipeline.js`）

### 7.4 多项目推广（Phase 4）

- [ ] 在其他项目中测试复用性
- [ ] 收集反馈并优化
- [ ] 编写最佳实践文档
- [ ] 创建 Workflow 模板库

---

## 8. 关键决策记录

### 8.1 需求输入方式

**决策**: 灵活支持多种方式（A/B/C 都支持）

- 方式 A: 直接在 Claude Code 中输入自然语言需求
- 方式 B: 从外部系统读取（如腾讯文档、GitHub Issues）
- 方式 C: 从项目文件读取（如 `tasks.md`）

**原因**: 不同场景有不同需求，灵活支持提高适用性。

### 8.2 技术选型

**决策**: 使用 Workflow 工具

**原因**:
1. 天然支持串行编排（满足用户需求）
2. 内置结构化输出（避免手动解析）
3. 可保存为独立脚本（多项目复用）
4. 内置进度追踪（用户体验好）

### 8.3 任务拆分职责

**决策**: 由需求分析 Sub Agent 负责

**原因**: 需求分析是独立的专业领域，应该由专门的 Agent 处理，而不是 Main Agent。

### 8.4 执行方式

**决策**: 串行执行，不考虑并发

**原因**: 简化实现，避免复杂的依赖管理和冲突处理。未来可扩展。

### 8.5 验收标准

**决策**: 自动化测试通过 + 代码规范检查通过

**原因**: 这些是可自动验证的客观标准，不需要人工介入。

### 8.6 失败处理策略

**决策**: 回退修复（测试反馈问题 → 代码 Agent 修复）

**原因**: 自动修复比人工介入更高效，且测试报告提供了明确的修复方向。

### 8.7 状态存储

**决策**: 文件系统（`.claude-agents/tasks/`）

**原因**: 
1. 独立于项目数据库（解耦）
2. 易于查看和调试（JSON 格式）
3. 支持 Git 忽略（临时文件）

### 8.8 系统定位

**决策**: 独立运行，与项目解耦

**原因**: 
1. 多项目复用性
2. 不污染项目代码
3. 易于维护和升级

---

## 9. 附录

### 9.1 相关文档

- `CLAUDE.md`: 项目编码规范和开发指南
- `docs/development/编码规范.md`: 详细编码规范
- `docs/database/数据库架构.md`: 数据库设计规范
- `docs/development/开发进度.md`: 开发进度跟踪

### 9.2 参考资源

- [Claude Code 官方文档](https://claude.ai/code)
- [Workflow 工具使用指南](https://docs.anthropic.com/claude/workflows)
- [Agent 工具使用指南](https://docs.anthropic.com/claude/agents)

### 9.3 术语表

- **Main Agent**: 主 Agent，负责任务调度和协调
- **Sub Agent**: 子 Agent，专注于特定职责（需求分析、代码实现、测试验收）
- **Workflow**: Claude Code 的编排工具，用 JavaScript 编写
- **Phase**: Workflow 中的阶段，用于组织进度展示
- **Schema**: JSON Schema，用于定义结构化输出格式
- **Task State**: 任务状态文件，记录任务执行过程和结果

---

## 10. 更新日志

| 版本 | 日期 | 变更内容 | 作者 |
|-----|------|---------|------|
| v1.0 | 2026-07-18 | 初始版本：架构设计和实现方案 | Main Agent |

---

**文档结束** 🎉
