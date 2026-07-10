# Excel 导入功能设计规范

**版本**：v1.0  
**创建时间**：2026-07-08  
**维护人**：Seraph  
**状态**：✅ 设计完成

---

## 📌 概述

本文档定义 Apple Order Manager 系统的 Excel 导入功能，用于批量导入 Apple IDs 和取机人（Recipients）基础数据。

**核心功能**：
- ✅ 支持批量导入 Apple IDs（账号、密码、密保问答）
- ✅ 支持批量导入取机人（姓名、身份证、地址、绑定 Apple ID）
- ✅ 数据校验（邮箱、身份证、手机号格式）
- ✅ 导入预览（显示将要导入的数据）
- ✅ 错误反馈（标记校验失败的行）
- ✅ 批量导入（使用 findOrCreate，避免重复）

---

## 📋 Excel 模板设计

### 1. Apple IDs 导入模板

**文件名**：`apple_ids_import_template.xlsx`

**工作表名称**：`Apple IDs`

**列定义**：

| 列序号 | 列名 | 字段名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|--------|------|------|------|--------|
| A | Apple ID | `apple_id` | String | ✅ | 邮箱格式 | `lajavve036@hotmail.com` |
| B | 密码 | `password` | String | ✅ | 明文密码 | `NdMH5943` |
| C | 备注名称 | `nickname` | String | - | 可选 | `主账号` |
| D | 国家地区 | `country` | String | - | 可选 | `美国` |
| E | 是否已修改 | `is_modified` | Boolean | - | `是` / `否` / 空 | `是` |
| F | 状态 | `status` | String | - | `active` / `inactive` | `active` |
| G | 密保问题1 | `question1` | String | - | 可选 | `朋友` |
| H | 密保答案1 | `answer1` | String | - | 可选 | `Aa64` |
| I | 密保问题2 | `question2` | String | - | 可选 | `工作` |
| J | 密保答案2 | `answer2` | String | - | 可选 | `136` |
| K | 密保问题3 | `question3` | String | - | 可选 | `父母` |
| L | 密保答案3 | `answer3` | String | - | 可选 | `142` |

**示例数据**：

```
Apple ID                    密码        备注名称    国家地区    是否已修改    状态        密保问题1    密保答案1    密保问题2    密保答案2    密保问题3    密保答案3
lajavve036@hotmail.com     NdMH5943    主账号      美国        是           active      朋友         Aa64        工作         136         父母         142
test123@gmail.com          Pass@2024   测试账号    中国        否           active      朋友         john        工作         teacher     父母         mary
```

---

### 2. Recipients 导入模板

**文件名**：`recipients_import_template.xlsx`

**工作表名称**：`Recipients`

**列定义**：

| 列序号 | 列名 | 字段名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|--------|------|------|------|--------|
| A | 姓 | `last_name` | String | ✅ | 1个字符 | `李` |
| B | 名 | `first_name` | String | ✅ | 1-49个字符 | `浩` |
| C | 身份证号 | `id_card_number` | String | ✅ | 18位身份证 | `431225199301151815` |
| D | 手机号 | `phone` | String | - | 11位手机号 | `15111988143` |
| E | 邮箱 | `email` | String | - | 邮箱格式 | `15111988148@ikv.com` |
| F | 省 | `province` | String | - | 可选 | `重庆` |
| G | 市 | `city` | String | - | 可选 | `重庆` |
| H | 区 | `district` | String | - | 可选 | `江北区` |
| I | 街道地址 | `street_address` | String | - | 可选 | `观音桥拓维304` |
| J | 绑定 Apple ID | `apple_id` | String | - | 邮箱格式 | `lajavve036@hotmail.com` |
| K | 标签 | `tag` | String | - | 可选 | `刘天佟 微信` |
| L | 状态 | `status` | String | - | `active` / `inactive` | `active` |
| M | 备注 | `notes` | String | - | 可选 | `转抢17` |

**示例数据**：

```
姓    名    身份证号              手机号          邮箱                   省      市      区        街道地址          绑定 Apple ID              标签           状态      备注
李    浩    431225199301151815   15111988143    15111988148@ikv.com    重庆    重庆    江北区    观音桥拓维304     lajavve036@hotmail.com    刘天佟 微信     active    转抢17
张    三    110101199001011234   13800138000    test@example.com       北京    北京    朝阳区    建国路1号         test123@gmail.com         群华华 微信     active    
```

---

## 🔍 数据校验规则

### Apple IDs 校验

| 字段 | 校验规则 | 错误提示 |
|------|---------|---------|
| `apple_id` | 必填，邮箱格式 | "Apple ID 必须是有效的邮箱格式" |
| `password` | 必填，非空 | "密码不能为空" |
| `country` | 可选 | - |
| `is_modified` | 可选，值为 `是` / `否` / 空 | "是否已修改必须是'是'或'否'" |
| `status` | 可选，值为 `active` / `inactive` / 空 | "状态必须是'active'或'inactive'" |
| 密保问答 | 6个字段要么全填，要么全不填 | "密保问答必须填写完整（3个问题+3个答案）" |

### Recipients 校验

| 字段 | 校验规则 | 错误提示 |
|------|---------|---------|
| `last_name` | 必填，1个字符 | "姓氏必须是1个字符" |
| `first_name` | 必填，1-49个字符 | "名字必须是1-49个字符" |
| `id_card_number` | 必填，18位数字或最后一位X | "身份证号必须是18位有效格式" |
| `phone` | 可选，11位数字 | "手机号必须是11位数字" |
| `email` | 可选，邮箱格式 | "邮箱格式不正确" |
| `apple_id` | 可选，邮箱格式 | "绑定的 Apple ID 必须是有效邮箱格式" |
| `status` | 可选，值为 `active` / `inactive` / 空 | "状态必须是'active'或'inactive'" |

---

## 📊 导入流程设计

### 流程图

```
用户选择文件
    ↓
前端上传文件到后端
    ↓
后端解析 Excel（xlsx 库）
    ↓
数据校验（格式、必填、唯一性）
    ↓
返回预览数据给前端
    ↓
用户确认导入
    ↓
后端批量导入（findOrCreate）
    ↓
返回导入结果（成功数、失败数、错误详情）
```

### 1. 前端上传

**UI 组件**：
- 文件选择按钮（只接受 `.xlsx` 格式）
- 下载模板按钮（下载标准模板）
- 上传进度条

**接口**：`POST /api/import/preview`

**请求**：`multipart/form-data`
- `file`: Excel 文件
- `type`: `apple_ids` 或 `recipients`

**响应**：
```json
{
  "success": true,
  "data": {
    "preview": [
      {
        "rowNumber": 2,
        "data": { "apple_id": "test@example.com", "password": "Pass@123" },
        "errors": []
      },
      {
        "rowNumber": 3,
        "data": { "apple_id": "invalid-email", "password": "" },
        "errors": [
          { "field": "apple_id", "message": "Apple ID 必须是有效的邮箱格式" },
          { "field": "password", "message": "密码不能为空" }
        ]
      }
    ],
    "summary": {
      "total": 100,
      "valid": 95,
      "invalid": 5
    }
  }
}
```

### 2. 数据预览

**UI 显示**：
- 表格显示前 50 行数据
- 错误行高亮显示（红色背景）
- 错误信息显示在对应单元格下方
- 显示统计信息：总行数、有效行数、无效行数

**交互**：
- 用户可以选择"仅导入有效数据"或"取消导入"

### 3. 确认导入

**接口**：`POST /api/import/execute`

**请求**：
```json
{
  "type": "apple_ids",
  "data": [
    { "apple_id": "test@example.com", "password": "Pass@123" },
    { "apple_id": "test2@example.com", "password": "Pass@456" }
  ]
}
```

**响应**：
```json
{
  "success": true,
  "data": {
    "imported": 95,
    "skipped": 5,
    "errors": [
      {
        "rowNumber": 10,
        "data": { "apple_id": "duplicate@example.com" },
        "error": "Apple ID 已存在"
      }
    ]
  }
}
```

---

## 💾 后端实现要点

### 1. Excel 解析（使用 xlsx 库）

```javascript
const XLSX = require('xlsx');

function parseExcelFile(filePath, type) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = type === 'apple_ids' ? 'Apple IDs' : 'Recipients';
  const worksheet = workbook.Sheets[sheetName];
  
  if (!worksheet) {
    throw new Error(`工作表 "${sheetName}" 不存在`);
  }
  
  const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  const headers = data[0]; // 第一行是列名
  const rows = data.slice(1); // 从第二行开始是数据
  
  return rows.map((row, index) => {
    const rowData = {};
    headers.forEach((header, colIndex) => {
      rowData[getFieldName(header)] = row[colIndex];
    });
    return {
      rowNumber: index + 2, // Excel 行号从2开始（第1行是表头）
      data: rowData
    };
  });
}
```

### 2. 数据校验

```javascript
function validateAppleId(data) {
  const errors = [];
  
  // 必填校验
  if (!data.apple_id) {
    errors.push({ field: 'apple_id', message: 'Apple ID 不能为空' });
  } else if (!isValidEmail(data.apple_id)) {
    errors.push({ field: 'apple_id', message: 'Apple ID 必须是有效的邮箱格式' });
  }
  
  if (!data.password) {
    errors.push({ field: 'password', message: '密码不能为空' });
  }
  
  // 密保完整性校验
  const hasAnySecurityQA = data.question1 || data.answer1 || 
                          data.question2 || data.answer2 || 
                          data.question3 || data.answer3;
  const hasAllSecurityQA = data.question1 && data.answer1 && 
                          data.question2 && data.answer2 && 
                          data.question3 && data.answer3;
  
  if (hasAnySecurityQA && !hasAllSecurityQA) {
    errors.push({ 
      field: 'security_qa', 
      message: '密保问答必须填写完整（3个问题+3个答案）' 
    });
  }
  
  // 枚举值校验
  if (data.status && !['active', 'inactive'].includes(data.status)) {
    errors.push({ 
      field: 'status', 
      message: '状态必须是 active 或 inactive' 
    });
  }
  
  return errors;
}

function validateRecipient(data) {
  const errors = [];
  
  // 必填校验
  if (!data.last_name) {
    errors.push({ field: 'last_name', message: '姓氏不能为空' });
  } else if (data.last_name.length !== 1) {
    errors.push({ field: 'last_name', message: '姓氏必须是1个字符' });
  }
  
  if (!data.first_name) {
    errors.push({ field: 'first_name', message: '名字不能为空' });
  } else if (data.first_name.length > 49) {
    errors.push({ field: 'first_name', message: '名字不能超过49个字符' });
  }
  
  // 身份证校验
  if (!data.id_card_number) {
    errors.push({ field: 'id_card_number', message: '身份证号不能为空' });
  } else if (!isValidIdCard(data.id_card_number)) {
    errors.push({ 
      field: 'id_card_number', 
      message: '身份证号必须是18位有效格式' 
    });
  }
  
  // 手机号校验
  if (data.phone && !isValidPhone(data.phone)) {
    errors.push({ field: 'phone', message: '手机号必须是11位数字' });
  }
  
  // 邮箱校验
  if (data.email && !isValidEmail(data.email)) {
    errors.push({ field: 'email', message: '邮箱格式不正确' });
  }
  
  if (data.apple_id && !isValidEmail(data.apple_id)) {
    errors.push({ 
      field: 'apple_id', 
      message: '绑定的 Apple ID 必须是有效邮箱格式' 
    });
  }
  
  return errors;
}
```

### 3. 批量导入（使用 findOrCreate）

```javascript
async function batchImportAppleIds(dataList) {
  const results = {
    imported: 0,
    skipped: 0,
    errors: []
  };
  
  const transaction = await sequelize.transaction();
  
  try {
    for (const item of dataList) {
      try {
        // 构建密保 JSONB 对象
        const securityQa = (item.question1 && item.answer1) ? {
          question1: item.question1,
          answer1: item.answer1,
          question2: item.question2,
          answer2: item.answer2,
          question3: item.question3,
          answer3: item.answer3
        } : null;
        
        const [record, created] = await AppleId.findOrCreate({
          where: { appleId: item.apple_id },
          defaults: {
            password: item.password,
            nickname: item.nickname || null,
            country: item.country || null,
            isModified: item.is_modified === '是',
            status: item.status || 'active',
            securityQa: securityQa
          },
          transaction
        });
        
        if (created) {
          results.imported++;
        } else {
          results.skipped++;
          results.errors.push({
            rowNumber: item.rowNumber,
            data: item,
            error: 'Apple ID 已存在'
          });
        }
      } catch (error) {
        results.errors.push({
          rowNumber: item.rowNumber,
          data: item,
          error: error.message
        });
      }
    }
    
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  
  return results;
}
```

---

## 🎨 前端 UI 设计

### 导入页面结构

```
┌─────────────────────────────────────────┐
│  Excel 数据导入                          │
├─────────────────────────────────────────┤
│                                         │
│  [导入类型选择]                          │
│    ○ Apple IDs    ○ 取机人              │
│                                         │
│  [下载模板]  [选择文件]                  │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │ 拖拽文件到此处或点击选择             │ │
│  │ 仅支持 .xlsx 格式                   │ │
│  └───────────────────────────────────┘ │
│                                         │
│  [上传并预览]                            │
│                                         │
└─────────────────────────────────────────┘

预览表格（上传后显示）：
┌─────────────────────────────────────────┐
│  数据预览                                │
│  总计: 100 行 | 有效: 95 行 | 无效: 5 行 │
├─────────────────────────────────────────┤
│  ┌─────────────────────────────────┐   │
│  │ 表格显示前 50 行                 │   │
│  │ 错误行红色高亮                   │   │
│  └─────────────────────────────────┘   │
│                                         │
│  [取消]  [仅导入有效数据]                │
└─────────────────────────────────────────┘
```

### 路由设计

- `/import` - Excel 导入主页面
- `/import/apple-ids` - Apple IDs 导入（可选，复用主页面）
- `/import/recipients` - 取机人导入（可选，复用主页面）

---

## ✅ 验收标准

### 功能验收
- [ ] 用户可以下载标准 Excel 模板
- [ ] 用户可以上传 Excel 文件
- [ ] 系统能正确解析 Excel 文件
- [ ] 系统能校验数据格式（邮箱、身份证、手机号）
- [ ] 系统能显示预览数据和错误信息
- [ ] 错误行高亮显示，错误信息清晰
- [ ] 用户可以选择"仅导入有效数据"
- [ ] 系统能批量导入数据（使用 findOrCreate）
- [ ] 导入完成后显示统计信息（成功数、跳过数、错误详情）
- [ ] 重复数据不会覆盖，只会跳过

### 兼容性验收
- [ ] 支持 Microsoft Excel 生成的 .xlsx 文件
- [ ] 支持 WPS 生成的 .xlsx 文件
- [ ] 支持 Google Sheets 导出的 .xlsx 文件
- [ ] 空行自动忽略
- [ ] 列顺序不敏感（根据列名匹配）

---

## 📝 开发清单

### Phase 1: 后端接口
- [ ] 安装 xlsx 库：`npm install xlsx`
- [ ] 创建 `importController.js`
  - `previewImport()` - 解析 Excel 并返回预览数据
  - `executeImport()` - 执行批量导入
- [ ] 创建 `importService.js`
  - `parseExcelFile()` - 解析 Excel
  - `validateAppleId()` - 校验 Apple ID 数据
  - `validateRecipient()` - 校验取机人数据
  - `batchImportAppleIds()` - 批量导入 Apple IDs
  - `batchImportRecipients()` - 批量导入取机人
- [ ] 创建路由 `importRoutes.js`
  - `POST /api/import/preview` - 预览接口
  - `POST /api/import/execute` - 导入接口
  - `GET /api/import/template/:type` - 下载模板接口

### Phase 2: 前端页面
- [ ] 创建 `Import.jsx` - 导入主页面
- [ ] 创建 `ImportPreview.jsx` - 预览组件
- [ ] 创建 `importApi.js` - API 调用
- [ ] 实现文件上传组件
- [ ] 实现数据预览表格
- [ ] 实现错误提示 UI

### Phase 3: 测试
- [ ] 准备测试数据（正常数据 + 异常数据）
- [ ] 测试 Apple IDs 导入
- [ ] 测试取机人导入
- [ ] 测试重复数据处理
- [ ] 测试错误数据校验

---

**参考文档**：
- 数据库设计：`docs/database/SCHEMA.md`
- 编码规范：`docs/development/CODING_STANDARDS.md`
