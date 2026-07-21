/**
 * 开发流水线 Workflow
 *
 * 使用方法：
 * 1. 在 Claude Code 中运行：
 *    Workflow({ scriptPath: '.claude-agents/workflows/dev-pipeline.js', args: { requirement: '需求描述' } })
 *
 * 2. 或者直接告诉 Main Agent：
 *    "使用 dev-pipeline 开发这个需求：添加订单导出功能"
 */

export const meta = {
  name: 'dev-pipeline',
  description: '串行开发流水线：需求澄清 → 需求分析 → 代码实现 → 测试验收',
  phases: [
    { title: '需求澄清', detail: '分析需求，向用户提问了解细节' },
    { title: '需求分析', detail: '整理需求、拆分任务、生成开发计划' },
    { title: '代码实现', detail: '按照计划实现功能' },
    { title: '测试验收', detail: '自动化测试 + 手动验证 + 生成报告' },
    { title: '修复验证', detail: '如果测试失败，修复并重新验证' }
  ]
}

// ============================================================
// JSON Schema 定义（结构化输出）
// ============================================================

const CLARIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    needsClarification: { type: 'boolean', description: '是否需要向用户提问' },
    questions: {
      type: 'array',
      description: '需要向用户提问的问题列表',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '问题内容' },
          reason: { type: 'string', description: '为什么需要问这个问题' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '可选的答案选项（如果适用）'
          }
        },
        required: ['question', 'reason']
      }
    },
    analysis: { type: 'string', description: '初步需求分析' }
  },
  required: ['needsClarification', 'questions', 'analysis']
}

const REQUIREMENT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '需求摘要（一句话概括）' },
    tasks: {
      type: 'array',
      description: '拆分后的开发任务列表',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 ID（如 task-1, task-2）' },
          title: { type: 'string', description: '任务标题' },
          description: { type: 'string', description: '任务详细描述' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '需要修改或新建的文件列表'
          },
          dependencies: {
            type: 'array',
            items: { type: 'string' },
            description: '依赖的任务 ID 列表（必须先完成哪些任务）'
          }
        },
        required: ['id', 'title', 'description', 'files']
      }
    },
    technicalApproach: { type: 'string', description: '技术方案说明' },
    estimatedComplexity: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: '复杂度评估（low/medium/high）'
    },
    cascadeImpact: {
      type: 'object',
      description: '级联影响分析（根据 CLAUDE.md 的级联规则）',
      properties: {
        databaseChange: { type: 'boolean', description: '是否涉及数据库变更' },
        apiChange: { type: 'boolean', description: '是否涉及 API 变更' },
        frontendChange: { type: 'boolean', description: '是否涉及前端变更' },
        affectedDocs: {
          type: 'array',
          items: { type: 'string' },
          description: '需要更新的文档列表'
        }
      }
    }
  },
  required: ['summary', 'tasks', 'technicalApproach', 'estimatedComplexity']
}

const CODE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    completedTasks: {
      type: 'array',
      items: { type: 'string' },
      description: '已完成的任务 ID 列表'
    },
    modifiedFiles: {
      type: 'array',
      items: { type: 'string' },
      description: '修改的文件路径列表'
    },
    newFiles: {
      type: 'array',
      items: { type: 'string' },
      description: '新建的文件路径列表'
    },
    summary: { type: 'string', description: '实现总结' },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: '重要说明或注意事项'
    }
  },
  required: ['completedTasks', 'modifiedFiles', 'newFiles', 'summary']
}

const TEST_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean', description: '整体是否通过（所有检查都通过）' },
    testsPassed: { type: 'number', description: '通过的测试数量' },
    testsFailed: { type: 'number', description: '失败的测试数量' },
    lintPassed: { type: 'boolean', description: '代码规范检查是否通过' },
    projectStarted: { type: 'boolean', description: '项目是否成功启动（无报错）' },
    manualChecks: {
      type: 'object',
      description: '手动验证结果',
      properties: {
        uiVerified: { type: 'boolean', description: '前端 UI 是否验证（如适用）' },
        apiVerified: { type: 'boolean', description: 'API 接口是否验证（如适用）' },
        dbVerified: { type: 'boolean', description: '数据库是否验证（如适用）' },
        functionalTestPassed: { type: 'boolean', description: '端到端功能测试是否通过' }
      }
    },
    screenshots: {
      type: 'array',
      items: { type: 'string' },
      description: '测试截图/证据文件路径列表'
    },
    errors: {
      type: 'array',
      items: { type: 'string' },
      description: '错误信息列表（测试失败或规范错误的详细信息）'
    },
    summary: { type: 'string', description: '测试总结（包含手动验证结果和功能测试结果）' }
  },
  required: ['passed', 'testsPassed', 'testsFailed', 'lintPassed', 'projectStarted', 'summary']
}

// ============================================================
// 主流程
// ============================================================

// 获取需求（从 args 传入）
const requirement = args.requirement || '未提供需求'
const taskId = args.taskId || 'task-auto-generated'
const clarificationAnswers = args.clarificationAnswers || null // 用户对澄清问题的回答

log(`🚀 启动开发流水线 [${taskId}]`)
log(`📋 需求: ${requirement}`)

// ============================================================
// Phase 0: 需求澄清（如果还没有澄清过）
// ============================================================
let clarification = null
let finalRequirement = requirement

if (!clarificationAnswers) {
  phase('需求澄清')

  const clarificationPrompt = `
你是一个需求分析专家。用户提出了一个需求，请分析这个需求是否清晰，是否需要向用户提问以了解细节。

**用户需求**:
${requirement}

**项目上下文**:
- 项目名称: Apple 订单管理系统
- 项目类型: 自动化监控邮件并同步 Apple 产品订单
- 技术栈: Node.js + Express + PostgreSQL + Sequelize + React + Ant Design

**你的任务**:
1. 分析需求是否明确（是否缺少关键信息）
2. 如果需要澄清，生成 2-5 个问题（不要太多，只问最关键的）
3. 提供初步的需求分析

**需要提问的情况**:
- 需求描述过于简略（如"加个按钮"，但不知道按钮放哪里、做什么）
- 涉及多个可能的实现方式，需要用户选择
- 缺少关键的业务规则或边界条件
- 需要确认 UI/UX 细节

**不需要提问的情况**:
- 需求已经很清晰，包含了足够的上下文
- 技术实现细节可以根据项目规范自行决定
- 可以参考现有代码推断用户意图

**提问原则**:
- 问题要具体、有针对性
- 提供选项（如果适用），方便用户快速回答
- 每个问题都要说明为什么需要问

**输出要求**:
返回结构化的 JSON 对象，包含: needsClarification（布尔值）, questions（问题数组）, analysis（初步分析）
`

  clarification = await agent(clarificationPrompt, {
    label: '需求澄清 Sub Agent',
    schema: CLARIFICATION_SCHEMA
  })

  if (!clarification) {
    throw new Error('❌ 需求澄清失败：Sub Agent 未返回结果')
  }

  // 如果需要澄清，暂停流程，返回问题列表
  if (clarification.needsClarification && clarification.questions.length > 0) {
    log(`⚠️ 需求需要澄清，共 ${clarification.questions.length} 个问题`)

    return {
      needsClarification: true,
      taskId,
      questions: clarification.questions,
      analysis: clarification.analysis,
      message: '请回答以下问题后重新运行 Workflow，传入 clarificationAnswers 参数'
    }
  }

  log('✅ 需求已明确，继续流程')
} else {
  log('✅ 已收到用户的澄清回答，继续流程')
  // 将用户回答附加到需求描述中
  finalRequirement = `${requirement}

**用户补充说明**:
${clarificationAnswers}`
}

// ============================================================
// Phase 1: 需求分析
// ============================================================
phase('需求分析')

const analysisPrompt = `
你是一个需求分析专家。请分析以下需求，并拆分成具体的开发任务。

**需求描述**:
${finalRequirement}

**项目上下文**:
- 项目名称: Apple 订单管理系统
- 项目类型: 自动化监控邮件并同步 Apple 产品订单
- 技术栈: Node.js + Express + PostgreSQL + Sequelize + React + Ant Design
- 关键文档:
  * docs/development/编码规范.md - 编码规范（强制遵守）
  * docs/database/数据库架构.md - 数据库设计规范（权威文档）
  * docs/design/API设计.md - API 接口设计
  * CLAUDE.md - 项目开发指南和级联规则

**重要提示**:
1. **级联规则**: 如果涉及数据库变更，必须先更新 docs/database/数据库架构.md，然后再修改 Model、创建 Migration
2. **级联规则**: 如果涉及 API 变更，必须先更新 docs/design/API设计.md，然后再修改 Controller/Router
3. **编码规范**: 所有代码必须遵循 camelCase 命名、使用 logger、添加 try-catch、编写 JSDoc 注释

**你的任务**:
1. 理解需求的核心目标
2. 拆分成可执行的子任务（每个任务应该是独立的、可测试的，工作量 < 2 小时）
3. 识别需要修改/新建的文件（包括文档）
4. 提出技术方案
5. 评估复杂度（low/medium/high）
6. 分析级联影响（数据库/API/前端变更，需要更新哪些文档）

**任务拆分原则**:
- 每个任务应该有明确的输入输出
- 任务之间的依赖关系要清晰
- 优先级: 数据库 → API → 前端
- 如果涉及级联影响，第一个任务应该是"更新文档"

**输出要求**:
返回结构化的 JSON 对象，包含: summary, tasks, technicalApproach, estimatedComplexity, cascadeImpact
`

const requirements = await agent(analysisPrompt, {
  label: '需求分析 Sub Agent',
  schema: REQUIREMENT_SCHEMA
})

if (!requirements) {
  throw new Error('❌ 需求分析失败：Sub Agent 未返回结果')
}

log(`✅ 需求分析完成: ${requirements.tasks.length} 个任务`)
log(`📊 复杂度: ${requirements.estimatedComplexity}`)
if (requirements.cascadeImpact) {
  log(`🔄 级联影响: DB=${requirements.cascadeImpact.databaseChange ? '是' : '否'} / API=${requirements.cascadeImpact.apiChange ? '是' : '否'} / 前端=${requirements.cascadeImpact.frontendChange ? '是' : '否'}`)
}

// 保存任务状态
const taskState = {
  taskId,
  requirement,
  timestamp: args.timestamp || 'timestamp-unavailable',
  phase: 'requirements',
  requirements
}

// ============================================================
// Phase 2: 代码实现
// ============================================================
phase('代码实现')

const implementationPrompt = `
你是一个代码实现专家。请根据以下开发计划实现功能。

**需求摘要**: ${requirements.summary}

**开发任务**:
${requirements.tasks.map((t, i) => `${i + 1}. [${t.id}] ${t.title}
   描述: ${t.description}
   文件: ${t.files.join(', ')}
   依赖: ${t.dependencies && t.dependencies.length > 0 ? t.dependencies.join(', ') : '无'}`).join('\n\n')}

**技术方案**:
${requirements.technicalApproach}

**级联影响提醒**:
${requirements.cascadeImpact ? `
- 数据库变更: ${requirements.cascadeImpact.databaseChange ? '是（必须先更新 docs/database/数据库架构.md）' : '否'}
- API 变更: ${requirements.cascadeImpact.apiChange ? '是（必须先更新 docs/design/API设计.md）' : '否'}
- 前端变更: ${requirements.cascadeImpact.frontendChange ? '是（遵循 docs/development/前端设计规范.md）' : '否'}
- 需要更新的文档: ${requirements.cascadeImpact.affectedDocs ? requirements.cascadeImpact.affectedDocs.join(', ') : '无'}
` : '无级联影响'}

**编码要求（强制遵守）**:
1. ✅ **命名规范**: 变量/函数使用 camelCase，类/模型使用 PascalCase，常量使用 UPPER_SNAKE_CASE
2. ✅ **日志记录**: 使用 \`logger\` 而不是 \`console.log\`，格式: \`logger.info('message', { context })\`
3. ✅ **错误处理**: 所有 async 函数必须有 try-catch，记录错误时带上下文
4. ✅ **数据库操作**: 多表操作使用事务，避免 N+1 查询
5. ✅ **JSDoc 注释**: 为所有导出的函数添加 JSDoc（@param, @returns, @throws）
6. ✅ **单元测试**: 为关键业务逻辑编写单元测试（放在 test/ 目录）

**级联规则（必须遵守）**:
1. 如果修改数据库表，**必须先更新** docs/database/数据库架构.md，然后再修改 Model 和创建 Migration
2. 如果修改 API 接口，**必须先更新** docs/design/API设计.md，然后再修改 Controller/Router
3. 如果修改前端，**必须遵循** docs/development/前端设计规范.md（浅色主题、表格列表、蓝色配色）

**任务执行顺序**:
按照任务依赖关系顺序执行（dependencies 中列出的任务必须先完成）

**注意事项**:
- 不要运行 \`npm test\` 和 \`npm run lint\`，这些会由测试验收 Sub Agent 执行
- 如果遇到不确定的技术细节，优先查阅项目文档（Read 工具）
- 完成每个任务后，简要说明实现内容

**输出要求**:
返回结构化的 JSON 对象，包含: completedTasks, modifiedFiles, newFiles, summary, notes
`

const codeResult = await agent(implementationPrompt, {
  label: '代码实现 Sub Agent',
  schema: CODE_RESULT_SCHEMA
})

if (!codeResult) {
  throw new Error('❌ 代码实现失败：Sub Agent 未返回结果')
}

log(`✅ 代码实现完成: ${codeResult.completedTasks.length}/${requirements.tasks.length} 个任务`)
log(`📝 修改文件: ${codeResult.modifiedFiles.length} 个`)
log(`📄 新建文件: ${codeResult.newFiles.length} 个`)

// 更新任务状态
taskState.phase = 'implementation'
taskState.codeResult = codeResult

// ============================================================
// Phase 3: 测试验收
// ============================================================
phase('测试验收')

const testPrompt = `
你是一个测试验收专家。请全面验证刚才实现的代码。

**已完成的任务**:
${codeResult.completedTasks.join('\n')}

**修改的文件**:
${codeResult.modifiedFiles.join('\n')}

**新建的文件**:
${codeResult.newFiles.join('\n')}

**实现总结**:
${codeResult.summary}

**级联影响**:
${requirements.cascadeImpact ? `
- 数据库变更: ${requirements.cascadeImpact.databaseChange ? '是' : '否'}
- API 变更: ${requirements.cascadeImpact.apiChange ? '是' : '否'}
- 前端变更: ${requirements.cascadeImpact.frontendChange ? '是' : '否'}
` : '无级联影响'}

**你的任务**:

### 1. 自动化测试
- 运行 \`npm test\` 检查单元测试（使用 Bash 工具）
- 运行 \`npm run lint\` 检查代码规范（使用 Bash 工具）
- 如果有数据库迁移文件，验证迁移可以正常执行

### 2. 项目启动验证
- 尝试启动项目（\`npm run dev\` 或检查前后端启动脚本）
- 检查启动过程中是否有报错
- 记录启动日志（前 20 行和后 20 行）

### 3. 功能级别验证（重要！）

**如果实现了认证/登录功能**:
- 使用 curl 测试登录 API，验证：
  - 正确的用户名密码能返回 Token
  - Token 格式正确（JWT 格式）
  - 错误的密码返回正确的错误信息
- 使用返回的 Token 测试受保护的 API
- 验证 Token 验证中间件正常工作

**如果涉及前端改动**:
- 访问相关页面，验证 UI 是否正常显示
- 检查关键元素（按钮、表单、弹窗等）是否存在
- 验证基本交互（按钮能点击、表单能提交）
- 使用 Bash 工具生成截图（如 \`screencapture -x /tmp/test-screenshot.png\`）或描述验证过程

**如果涉及 API 改动**:
- 使用 curl 测试新增/修改的 API 接口
- 验证请求参数和响应格式
- 测试边界情况（空参数、错误参数）
- 记录 API 测试结果

**如果涉及数据库改动**:
- 验证 migration 文件能成功运行
- 检查表结构、字段、索引是否正确创建
- 尝试插入/查询测试数据
- 记录数据库操作结果

### 4. 端到端功能测试（关键！）

对于完整的功能（如登录系统），必须验证完整流程：
1. 创建测试数据（如创建测试用户）
2. 测试正常流程（如登录成功 → 获取 Token → 使用 Token 访问 API）
3. 测试异常流程（如密码错误、Token 过期、权限不足）
4. 清理测试数据

**重要**: 不要只测试接口能返回 200，必须验证返回的内容是否正确、功能是否真正可用。

### 5. 生成测试报告

**验收标准**:
- ✅ 所有单元测试通过（testsFailed = 0）
- ✅ 代码规范检查通过（lintPassed = true，允许有 warning 但不能有 error）
- ✅ 项目能成功启动（projectStarted = true）
- ✅ 功能验证通过（manualChecks 中的相关项为 true）
- ✅ 端到端流程测试通过
- ✅ 无明显的语法错误或运行时错误

**错误信息收集要求**:
如果任何检查失败，你必须：
1. 收集完整的错误信息（包括文件名、行号、错误原因）
2. 将每个错误作为独立的字符串放入 errors 数组
3. 格式示例: "登录 API 测试失败: 返回 {success: false}，未返回 Token"

**输出要求**:
返回结构化的 JSON 对象，包含:
- passed（布尔值，所有检查都通过才为 true）
- testsPassed, testsFailed（数字）
- lintPassed（布尔值）
- projectStarted（布尔值）
- manualChecks（对象，包含 uiVerified, apiVerified, dbVerified, functionalTestPassed）
- screenshots（数组，截图或证据文件路径）
- errors（数组，错误信息列表）
- summary（字符串，详细的测试总结，包含所有验证结果和功能测试结果）
`

let testResult = await agent(testPrompt, {
  label: '测试验收 Sub Agent',
  schema: TEST_RESULT_SCHEMA
})

if (!testResult) {
  throw new Error('❌ 测试验收失败：Sub Agent 未返回结果')
}

log(`📊 测试结果: ${testResult.testsPassed} 通过 / ${testResult.testsFailed} 失败`)
log(`📊 代码规范: ${testResult.lintPassed ? '✅ 通过' : '❌ 失败'}`)
log(`📊 项目启动: ${testResult.projectStarted ? '✅ 成功' : '❌ 失败'}`)
if (testResult.manualChecks) {
  if (testResult.manualChecks.uiVerified !== undefined) {
    log(`📊 UI 验证: ${testResult.manualChecks.uiVerified ? '✅ 通过' : '❌ 失败'}`)
  }
  if (testResult.manualChecks.apiVerified !== undefined) {
    log(`📊 API 验证: ${testResult.manualChecks.apiVerified ? '✅ 通过' : '❌ 失败'}`)
  }
  if (testResult.manualChecks.dbVerified !== undefined) {
    log(`📊 数据库验证: ${testResult.manualChecks.dbVerified ? '✅ 通过' : '❌ 失败'}`)
  }
}
if (testResult.screenshots && testResult.screenshots.length > 0) {
  log(`📸 测试证据: ${testResult.screenshots.length} 个文件`)
}

// 更新任务状态
taskState.phase = 'testing'
taskState.testResult = testResult

// ============================================================
// Phase 4: 修复验证（如果测试失败，最多重试3次）
// ============================================================
if (!testResult.passed) {
  phase('修复验证')

  log('⚠️ 测试未通过，进入修复流程')

  const MAX_FIX_ATTEMPTS = 3
  let fixAttempt = 0
  let finalTestResult = testResult

  while (fixAttempt < MAX_FIX_ATTEMPTS && !finalTestResult.passed) {
    fixAttempt++
    log(`🔧 第 ${fixAttempt}/${MAX_FIX_ATTEMPTS} 次修复尝试...`)

    const fixPrompt = `
你是一个代码修复专家。测试验收发现了问题，请修复。

**这是第 ${fixAttempt} 次修复尝试**（最多 ${MAX_FIX_ATTEMPTS} 次）

**测试报告**:
- 测试通过: ${finalTestResult.testsPassed}
- 测试失败: ${finalTestResult.testsFailed}
- 代码规范: ${finalTestResult.lintPassed ? '通过' : '失败'}
- 项目启动: ${finalTestResult.projectStarted ? '成功' : '失败'}
- 功能测试: ${finalTestResult.manualChecks?.functionalTestPassed ? '通过' : '失败'}

**错误详情**:
${finalTestResult.errors.join('\n')}

**测试总结**:
${finalTestResult.summary}

**你的任务**:
1. 仔细阅读错误信息，定位问题根因
2. 修复代码（只修复测试报告中提到的问题，不要引入新功能）
3. 确保修复后的代码能通过测试

**修复原则**:
- 最小化修改：只改必须改的地方
- 保持一致性：遵循项目的编码规范
- 避免副作用：不要影响其他功能
- 关注根本原因：不要只修复表面症状

**常见问题修复指南**:
- 如果是字段 undefined/null 导致的错误，检查数据库默认值和模型定义
- 如果是密码验证失败，检查 bcrypt 比较逻辑和密码哈希生成
- 如果是 Token 问题，检查 JWT 签名和验证逻辑
- 如果是 API 返回错误，检查控制器的错误处理和响应格式

**输出要求**:
返回结构化的 JSON 对象，包含: completedTasks, modifiedFiles, newFiles, summary, notes
`

    const fixResult = await agent(fixPrompt, {
      label: `修复 Sub Agent (尝试 ${fixAttempt})`,
      schema: CODE_RESULT_SCHEMA
    })

    if (fixResult) {
      log(`✅ 第 ${fixAttempt} 次修复完成，重新验证...`)

      // 重新运行测试
      finalTestResult = await agent(testPrompt, {
        label: `重新测试验证 (尝试 ${fixAttempt})`,
        schema: TEST_RESULT_SCHEMA
      })

      log(`📊 重新测试结果: ${finalTestResult.testsPassed} 通过 / ${finalTestResult.testsFailed} 失败`)
      log(`📊 代码规范: ${finalTestResult.lintPassed ? '✅ 通过' : '❌ 失败'}`)
      log(`📊 项目启动: ${finalTestResult.projectStarted ? '✅ 成功' : '❌ 失败'}`)
      log(`📊 功能测试: ${finalTestResult.manualChecks?.functionalTestPassed ? '✅ 通过' : '❌ 失败'}`)

      if (finalTestResult.passed) {
        log(`🎉 第 ${fixAttempt} 次修复成功，测试通过！`)
        taskState.phase = 'fixed'
        taskState.fixAttempts = fixAttempt
        taskState.fixResult = fixResult
        taskState.finalTestResult = finalTestResult
        testResult = finalTestResult
        break
      } else {
        log(`⚠️ 第 ${fixAttempt} 次修复后测试仍未通过，继续尝试...`)
      }
    } else {
      log(`❌ 第 ${fixAttempt} 次修复失败：Sub Agent 未返回结果`)
      break
    }
  }

  if (!finalTestResult.passed) {
    log(`❌ 经过 ${fixAttempt} 次修复尝试，测试仍未通过`)
    log('📝 建议人工介入检查代码')
    taskState.phase = 'failed'
    taskState.fixAttempts = fixAttempt
    testResult = finalTestResult
  }
}

// ============================================================
// 保存最终状态
// ============================================================
taskState.completed = true
taskState.completedAt = args.timestamp || 'timestamp-unavailable'
taskState.success = testResult.passed

// 注意：这里不能直接调用 Write，因为 Workflow 脚本中没有直接访问工具的能力
// 状态保存由 Main Agent 在接收到 Workflow 结果后完成

// ============================================================
// 最终报告
// ============================================================
log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
log('🎉 开发流水线完成！')
log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
log(`📋 任务 ID: ${taskId}`)
log(`✅ 完成任务: ${codeResult.completedTasks.length}/${requirements.tasks.length}`)
log(`📊 最终测试: ${testResult.passed ? '✅ 通过' : '❌ 失败'}`)
log(`📁 任务状态将保存到: .claude-agents/tasks/${taskId}.json`)
log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

// 返回最终结果（供 Main Agent 使用）
return {
  success: testResult.passed,
  taskId,
  requirements,
  codeResult,
  testResult,
  taskState,
  statusFile: `.claude-agents/tasks/${taskId}.json`
}
