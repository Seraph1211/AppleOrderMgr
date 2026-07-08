# Apple Order Manager 编码规范 v1.0

## 1. 概述

### 1.1 适用范围
本规范适用于 Apple Order Manager 项目的所有 JavaScript/Node.js 代码，包括：
- 邮件解析服务（`services/emailParser.js`）
- 爬虫模块（`crawler/order_parser.js`）
- RESTful API（`src/` 目录）
- 数据库模型（Sequelize ORM）
- 工具函数和测试代码

### 1.2 规范层级说明
- **[必须]**：强制执行，违反将导致 CI 失败
- **[推荐]**：建议遵守，提升代码质量
- **[可选]**：团队可自行决定

### 1.3 严重程度定义
- **error**：必须修复，阻断代码合并
- **warning**：建议修复，不阻断流程
- **info**：提示信息，供参考

### 1.4 技术栈
- **运行时**：Node.js 14+
- **框架**：Express.js
- **数据库**：PostgreSQL 14+ + Sequelize ORM
- **核心依赖**：axios, cheerio, imap, nodemailer
- **开发工具**：ESLint, Prettier, Jest

---

## 2. 命名规范

### [NC-001] 变量命名 [必须] [error]

**说明**：使用小驼峰命名法（camelCase），变量名应具有描述性，体现其用途。

**原因**：统一的命名风格提升代码可读性，避免理解歧义。

**正确示例**：
```javascript
const appleOrderNumber = 'W123456789';
const recipientIdLast4 = '5904';
const productList = [];
const isEmailParsed = true;
```

**错误示例**：
```javascript
const apple_order_number = 'W123456789';  // 不使用下划线
const RecipientId = '5904';  // 变量不使用大驼峰
const plist = [];  // 过于简略
const flag = true;  // 名称不明确
```

**工具检查**：ESLint `camelcase`

### [NC-002] 函数命名 [必须] [error]

**说明**：函数使用小驼峰命名法，以动词开头，清晰表达功能。常用动词：`get/set/parse/fetch/save/update/delete/validate/format`。

**原因**：函数名应体现"做什么"，提升代码自解释性。

**正确示例**：
```javascript
async function parseEmailContent(emailBody) { }
function extractOrderNumber(htmlContent) { }
async function saveOrderToDatabase(orderData) { }
function validateRecipientInfo(recipient) { }
```

**错误示例**：
```javascript
function email(body) { }  // 不清晰
function order_parser() { }  // 使用下划线
function Data() { }  // 应为动词开头
```

**工具检查**：ESLint `camelcase`

### [NC-003] 类命名 [必须] [error]

**说明**：类名使用大驼峰命名法（PascalCase），名词形式。Sequelize 模型类名使用单数形式。

**原因**：类代表实体或概念，使用名词和大驼峰是业界标准。

**正确示例**：
```javascript
class EmailParser { }
class OrderCrawler { }
class AppleId extends Model { }  // Sequelize 模型
class Recipient extends Model { }
```

**错误示例**：
```javascript
class emailParser { }  // 应使用大驼峰
class parse_email { }  // 使用下划线
class AppleIds extends Model { }  // 模型应为单数
```

**工具检查**：ESLint `new-cap`

### [NC-004] 常量命名 [必须] [error]

**说明**：常量使用全大写字母，单词间用下划线分隔（UPPER_SNAKE_CASE）。配置项、枚举值、魔法数字都应定义为常量。

**原因**：明确标识不可变值，便于统一管理和修改。

**正确示例**：
```javascript
const MAX_RETRY_TIMES = 3;
const DEFAULT_REQUEST_DELAY = 5000;
const ORDER_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed'
};
```

**错误示例**：
```javascript
const maxRetryTimes = 3;  // 常量应全大写
const default_delay = 5000;  // 小写不合规
if (retryCount > 3) { }  // 魔法数字应定义为常量
```

**工具检查**：ESLint `no-magic-numbers`

### [NC-005] 文件命名 [必须] [error]

**说明**：文件名使用小驼峰命名法或短横线命名法（kebab-case）。模型文件、服务文件、工具文件应有明确的命名模式。

**原因**：统一的文件命名便于快速定位代码位置。

**正确示例**：
```
services/emailParser.js
crawler/order_parser.js  // 历史遗留，新文件应使用 orderParser.js
models/AppleId.js
utils/proxyManager.js
test/emailParser.test.js
```

**说明**：`crawler/order_parser.js` 使用下划线是历史遗留命名，新创建的文件应统一使用小驼峰命名（如 `orderParser.js`）。

**错误示例**：
```
services/Email_Parser.js  // 混用命名风格
crawler/OrderParser.js  // 非模型文件不应大驼峰
models/apple-id.js  // 模型应用大驼峰
```

**工具检查**：手动审查 + 项目约定

---

## 3. 代码格式

### [CF-001] 缩进规则 [必须] [error]

**说明**：使用 2 个空格缩进，禁止使用 Tab。所有代码块、对象、数组均需缩进。

**原因**：统一缩进风格，避免不同编辑器显示差异。Node.js 社区标准为 2 空格。

**正确示例**：
```javascript
function parseOrder(data) {
  if (data) {
    const result = {
      orderId: data.id,
      status: data.status
    };
    return result;
  }
}
```

**错误示例**：
```javascript
function parseOrder(data) {
    if (data) {  // 4 个空格不符合项目规范
const result = {};  // 未缩进
    }
}
```

**工具检查**：Prettier `tabWidth: 2`, ESLint `indent`

### [CF-002] 行长度限制 [推荐] [warning]

**说明**：每行代码不超过 100 字符。超长行应拆分为多行，保持可读性。

**原因**：避免横向滚动，提升代码审查体验。现代显示器可轻松容纳 100 字符。

**正确示例**：
```javascript
const orderLink = `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/${email}`;

// 超长链式调用应换行
const result = await axios.get(url)
  .then(response => response.data)
  .catch(error => handleError(error));
```

**错误示例**：
```javascript
const orderLink = `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/${email}?timestamp=${Date.now()}&source=email&campaign=auto`;
```

**工具检查**：Prettier `printWidth: 100`, ESLint `max-len`

### [CF-003] 引号使用 [必须] [error]

**说明**：字符串统一使用单引号 `'`，模板字符串使用反引号 `` ` ``。避免混用双引号。

**原因**：统一风格，减少转义需求。单引号是 Node.js 社区主流选择。

**正确示例**：
```javascript
const email = 'user@example.com';
const greeting = `Hello, ${name}!`;
const html = '<div class="container"></div>';
```

**错误示例**：
```javascript
const email = "user@example.com";  // 应使用单引号
const name = 'John' + " Doe";  // 混用引号
const message = 'Hello, ' + name;  // 应使用模板字符串
```

**工具检查**：Prettier `singleQuote: true`, ESLint `quotes`

### [CF-004] 分号使用 [必须] [error]

**说明**：所有语句结尾必须使用分号 `;`。不依赖 JavaScript 的自动分号插入（ASI）机制。

**原因**：避免 ASI 导致的潜在错误，提升代码明确性和安全性。

**正确示例**：
```javascript
const appleId = 'user@apple.com';
await saveOrder(orderData);
return { success: true };
```

**错误示例**：
```javascript
const appleId = 'user@apple.com'  // 缺少分号
await saveOrder(orderData)
return { success: true }
```

**工具检查**：Prettier `semi: true`, ESLint `semi`

### [CF-005] 空行使用 [推荐] [warning]

**说明**：使用空行分隔逻辑块，提升代码可读性。函数之间、逻辑段落之间应有空行。

**原因**：适当的空行让代码结构更清晰，便于快速理解逻辑分组。

**正确示例**：
```javascript
const { email, orderNumber } = parseEmailContent(body);

const orderData = await fetchOrderDetails(orderNumber);

await saveToDatabase(orderData);
return { success: true };
```

**错误示例**：
```javascript
const { email, orderNumber } = parseEmailContent(body);
const orderData = await fetchOrderDetails(orderNumber);
await saveToDatabase(orderData);
return { success: true };
```

**工具检查**：ESLint `padding-line-between-statements`

---

## 4. 注释规范

### [CM-001] 函数注释 [必须] [error]

**说明**：所有导出的函数必须有 JSDoc 注释，说明功能、参数、返回值。复杂的内部函数也应添加注释。

**原因**：函数注释是代码文档的核心，便于 IDE 智能提示和团队协作。

**正确示例**：
```javascript
/**
 * 解析邮件内容，提取订单信息
 * @param {string} emailBody - 邮件正文内容（可能包含 Base64 编码）
 * @returns {Object} 订单信息对象
 * @returns {string} returns.appleId - Apple ID
 * @returns {string} returns.orderNumber - W 订单号
 * @throws {Error} 当邮件格式无法解析时抛出异常
 */
async function parseEmailContent(emailBody) {
  // 实现代码
}
```

**工具检查**：ESLint `require-jsdoc`, `valid-jsdoc`

### [CM-002] 文件头注释 [推荐] [warning]

**说明**：每个文件开头应有简短注释，说明文件用途、主要功能、作者信息。

**原因**：文件头注释帮助新成员快速理解代码组织结构。

**正确示例**：
```javascript
/**
 * 邮件解析服务
 * 功能：监听 IMAP 邮件，解析 NULL AOS Helper 订单通知
 * 作者：Seraph
 * 更新：2026-07-06
 */

const Imap = require('imap');
// ... 其他代码
```

**错误示例**：
```javascript
// emailParser.js
const Imap = require('imap');  // 注释过于简单
```

**工具检查**：手动审查

### [CM-003] 行内注释 [推荐] [info]

**说明**：复杂逻辑、关键算法、业务规则应添加行内注释。注释应解释"为什么"而非"是什么"。

**原因**：代码本身说明"做什么"，注释应说明"为什么这样做"。

**正确示例**：
```javascript
// 邮件内容为 Base64 编码的 UTF-8 文本，需先解码
const decodedContent = Buffer.from(emailBody, 'base64').toString('utf-8');

// 产品以 @ 分隔，最后一段包含收件人信息
const segments = orderText.split('@');
const recipientInfo = segments[segments.length - 1];
```

**错误示例**：
```javascript
const decoded = Buffer.from(body, 'base64').toString('utf-8'); // 解码
const arr = text.split('@'); // 分割数组
```

**工具检查**：手动审查

### [CM-004] TODO/FIXME 标记 [推荐] [warning]

**说明**：使用标准标记记录待办事项和问题。格式：`// TODO(作者): 描述` 或 `// FIXME(作者): 描述`。

**原因**：统一的标记便于搜索和跟踪未完成工作。

**正确示例**：
```javascript
// TODO(seraph): 实现代理池轮换机制，避免风控
async function fetchOrderWithProxy(url) {
  // FIXME(seraph): 当前未处理 HTTP 541 错误，需添加重试逻辑
  return await axios.get(url);
}
```

**错误示例**：
```javascript
// 以后再实现代理
// bug：541 错误
```

**工具检查**：ESLint `no-warning-comments`

---

## 5. 代码组织

### [CO-001] 模块导入顺序 [推荐] [warning]

**说明**：按以下顺序组织导入：1) Node.js 内置模块 2) 第三方依赖 3) 项目内部模块。每组之间用空行分隔。

**原因**：统一的导入顺序提升代码可读性，便于快速识别依赖关系。

**正确示例**：
```javascript
const fs = require('fs');
const path = require('path');

const axios = require('axios');
const cheerio = require('cheerio');
const Imap = require('imap');

const { AppleId, Order } = require('../models');
const proxyManager = require('../utils/proxyManager');
```

**错误示例**：
```javascript
const axios = require('axios');
const { Order } = require('../models');
const fs = require('fs');
```

**工具检查**：ESLint `import/order`

### [CO-002] 文件结构 [推荐] [info]

**说明**：文件内容按以下顺序组织：1) 文件头注释 2) 依赖导入 3) 常量定义 4) 辅助函数 5) 主要函数 6) 导出语句。

**原因**：标准化的文件结构让代码更易维护和理解。

**正确示例**：
```javascript
/**
 * 订单爬虫模块
 */

// 依赖导入
const axios = require('axios');

// 常量定义
const MAX_RETRY = 3;
const REQUEST_DELAY = 5000;

// 辅助函数
function extractJSON(html) { }

// 主要功能
async function fetchOrderDetails(url) { }

// 导出
module.exports = { fetchOrderDetails };
```

**工具检查**：手动审查

---

## 6. 错误处理

### [EH-001] 异步错误处理 [必须] [error]

**说明**：所有异步操作必须使用 try-catch 包裹或 .catch() 处理错误。避免未捕获的 Promise rejection。

**原因**：未处理的异步错误会导致进程崩溃或数据不一致。

**正确示例**：
```javascript
async function parseEmail(emailId) {
  try {
    const content = await fetchEmailContent(emailId);
    const orderData = parseOrderInfo(content);
    await saveToDatabase(orderData);
    return { success: true };
  } catch (error) {
    logger.error('邮件解析失败', { emailId, error: error.message });
    throw new Error(`邮件解析失败: ${error.message}`);
  }
}
```

**错误示例**：
```javascript
async function parseEmail(emailId) {
  const content = await fetchEmailContent(emailId);  // 未处理错误
  return parseOrderInfo(content);
}
```

**工具检查**：ESLint `no-async-promise-executor`, `require-await`

### [EH-002] 错误日志记录 [必须] [error]

**说明**：捕获错误时必须记录日志，包含上下文信息（如订单号、邮件 ID）。使用结构化日志格式。

**原因**：详细的错误日志是排查问题的关键，上下文信息帮助快速定位根因。

**正确示例**：
```javascript
catch (error) {
  logger.error('爬虫请求失败', {
    orderNumber,
    url,
    statusCode: error.response?.status,
    message: error.message,
    stack: error.stack
  });
}
```

**错误示例**：
```javascript
catch (error) {
  console.log(error);  // 信息不足
}
```

**工具检查**：ESLint `no-console`（禁用 console）

### [EH-003] 边界条件检查 [必须] [error]

**说明**：对外部输入、API 响应、数据库查询结果进行边界检查。避免 null/undefined 引发的运行时错误。

**原因**：外部数据不可信，必须验证后再使用。

**正确示例**：
```javascript
function parseProducts(orderText) {
  if (!orderText || typeof orderText !== 'string') {
    throw new Error('订单文本无效');
  }
  
  const segments = orderText.split('@');
  if (segments.length === 0) {
    throw new Error('订单格式错误：无产品信息');
  }
  
  return segments.map(seg => parseProductSegment(seg));
}
```

**错误示例**：
```javascript
function parseProducts(orderText) {
  return orderText.split('@').map(seg => parse(seg));  // 未检查 null
}
```

**工具检查**：ESLint `no-unsafe-optional-chaining`

---

## 7. 安全规范

### [SEC-001] 敏感信息保护 [必须] [error]

**说明**：禁止在代码中硬编码密码、密钥、Token。所有敏感信息必须通过环境变量或配置文件管理。

**原因**：硬编码的敏感信息会被提交到版本控制系统，造成安全风险。

**正确示例**：
```javascript
const imapConfig = {
  user: process.env.IMAP_USER,
  password: process.env.IMAP_PASSWORD,
  host: process.env.IMAP_HOST,
  port: process.env.IMAP_PORT || 993
};

// .env 文件（不提交到 Git）
IMAP_USER=user@example.com
IMAP_PASSWORD=your_password_here
```

**错误示例**：
```javascript
const imapConfig = {
  user: 'user@qq.com',
  password: 'mypassword123'  // 硬编码密码
};
```

**工具检查**：ESLint `no-secrets`, Git pre-commit hook

### [SEC-002] 输入验证 [必须] [error]

**说明**：对所有外部输入（邮件内容、API 请求、爬虫响应）进行严格验证和清理，防止注入攻击。

**原因**：不可信的输入可能导致 SQL 注入、XSS、命令注入等安全问题。

**正确示例**：
```javascript
function validateOrderNumber(orderNumber) {
  // W 订单号格式：W + 9 位数字
  const pattern = /^W\d{9}$/;
  if (!pattern.test(orderNumber)) {
    throw new Error('订单号格式无效');
  }
  return orderNumber;
}

// Sequelize 自动防止 SQL 注入
const order = await Order.findOne({
  where: { orderNumber: validatedOrderNumber }
});
```

**错误示例**：
```javascript
const query = `SELECT * FROM orders WHERE order_number = '${orderNumber}'`;
// SQL 注入风险
```

**工具检查**：ESLint `security/detect-sql-injection`

### [SEC-003] 依赖安全 [推荐] [warning]

**说明**：定期检查依赖包的安全漏洞，及时更新有风险的依赖。使用 npm audit 或 Snyk 等工具扫描。

**原因**：第三方依赖的漏洞可能成为攻击入口。

**正确示例**：
```bash
# 定期运行安全审计
npm audit
npm audit fix

# CI/CD 集成
npm audit --audit-level=high
```

**错误示例**：
```json
{
  "dependencies": {
    "axios": "0.18.0"  // 已知安全漏洞的旧版本
  }
}
```

**工具检查**：npm audit, Snyk, Dependabot

---

## 8. 性能规范

### [PERF-001] 数据库查询优化 [必须] [error]

**说明**：避免 N+1 查询问题，使用 include 预加载关联数据。为高频查询字段添加索引。

**原因**：N+1 查询会导致数据库压力倍增，严重影响性能。

**正确示例**：
```javascript
// 预加载关联数据，避免 N+1
const orders = await Order.findAll({
  include: [
    { model: AppleId, attributes: ['email'] },
    { model: Recipient, attributes: ['name', 'idCardLast4'] }
  ],
  where: { status: 'pending' }
});
```

**错误示例**：
```javascript
const orders = await Order.findAll({ where: { status: 'pending' } });
for (const order of orders) {
  order.appleId = await AppleId.findByPk(order.appleIdId);  // N+1 查询
}
```

**工具检查**：手动审查 + 数据库慢查询日志

### [PERF-002] 爬虫请求延迟 [必须] [error]

**说明**：爬虫请求之间必须有延迟（5-10 秒），避免触发反爬虫机制。使用代理池轮换 IP。

**原因**：频繁请求会被识别为爬虫，触发风控（HTTP 541），导致 IP 被封禁。

**正确示例**：
```javascript
const REQUEST_DELAY = 5000;

async function crawlOrder(orderNumber) {
  await sleep(REQUEST_DELAY);
  const proxy = await proxyManager.getNextProxy();
  const response = await axios.get(url, { proxy });
  return response.data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

**错误示例**：
```javascript
for (const order of orders) {
  await crawlOrder(order);  // 无延迟，立即触发风控
}
```

**工具检查**：手动审查 + 集成测试

### [PERF-002-EXT] 爬虫反爬详细策略 [必须] [error]

**说明**：完整的反爬虫策略，包括错误处理、代理轮换、请求重试机制。

**原因**：Apple 网站有严格的反爬虫机制，需要完善的策略才能稳定运行。

**完整实现示例**：
```javascript
const PROXY_POOL = [];
const MAX_RETRY = 3;
const REQUEST_DELAY_MIN = 5000;
const REQUEST_DELAY_MAX = 10000;

async function fetchOrderWithAntiBot(url, orderNumber) {
  let retryCount = 0;
  let lastError = null;
  
  while (retryCount < MAX_RETRY) {
    try {
      // 随机延迟 5-10 秒
      const delay = Math.floor(Math.random() * (REQUEST_DELAY_MAX - REQUEST_DELAY_MIN)) + REQUEST_DELAY_MIN;
      await sleep(delay);
      
      // 获取代理
      const proxy = await proxyManager.getNextProxy();
      
      // 设置请求头模拟真实浏览器
      const response = await axios.get(url, {
        proxy: proxy,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Referer': 'https://www.apple.com.cn/'
        },
        timeout: 30000
      });
      
      return response.data;
      
    } catch (error) {
      lastError = error;
      retryCount++;
      
      // HTTP 541 表示触发风控
      if (error.response?.status === 541) {
        logger.warn('触发反爬虫机制', { orderNumber, proxy, retryCount });
        await proxyManager.markProxyAsBad(proxy);
        
        // 风控后额外延迟
        await sleep(30000);
        continue;
      }
      
      // 其他 HTTP 错误
      if (error.response) {
        logger.error('HTTP请求失败', {
          orderNumber,
          status: error.response.status,
          retryCount
        });
      }
      
      // 网络错误或超时
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        logger.warn('请求超时，重试', { orderNumber, retryCount });
        continue;
      }
      
      throw error;
    }
  }
  
  throw new Error(`爬取失败，已重试${MAX_RETRY}次: ${lastError.message}`);
}
```

**代理池管理示例**：
```javascript
class ProxyManager {
  constructor() {
    this.proxies = [];
    this.currentIndex = 0;
    this.badProxies = new Set();
  }
  
  async loadProxies() {
    // 从代理API获取代理列表（如快代理）
    const response = await axios.get(process.env.PROXY_API_URL);
    this.proxies = response.data.proxies;
  }
  
  getNextProxy() {
    // 轮询获取可用代理
    for (let i = 0; i < this.proxies.length; i++) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      
      if (!this.badProxies.has(proxy.ip)) {
        return {
          host: proxy.ip,
          port: proxy.port,
          auth: proxy.auth
        };
      }
    }
    throw new Error('无可用代理');
  }
  
  markProxyAsBad(proxy) {
    this.badProxies.add(proxy.host);
    // 1小时后重新尝试该代理
    setTimeout(() => {
      this.badProxies.delete(proxy.host);
    }, 3600000);
  }
}
```

**工具检查**：集成测试 + 监控告警

### [PERF-003] 资源释放 [必须] [error]

**说明**：及时释放数据库连接、文件句柄、IMAP 连接等资源。使用 try-finally 或事件监听器确保清理。

**原因**：资源泄漏会导致内存占用增加、连接池耗尽、系统崩溃。

**正确示例**：
```javascript
async function monitorEmail() {
  const imap = new Imap(config);
  
  try {
    await imap.connect();
    imap.on('mail', handleNewMail);
    // ... 其他逻辑
  } finally {
    imap.end();  // 确保连接关闭
  }
}

// 进程退出时清理
process.on('SIGTERM', async () => {
  await sequelize.close();
  process.exit(0);
});
```

**错误示例**：
```javascript
const imap = new Imap(config);
imap.connect();  // 连接后未关闭
```

**工具检查**：手动审查 + 内存监控

---

## 9. 测试规范

### [TEST-001] 单元测试覆盖 [推荐] [warning]

**说明**：核心业务逻辑必须有单元测试，目标覆盖率 >70%。重点测试：邮件解析、订单爬虫、数据验证。

**原因**：单元测试是代码质量的保障，防止回归问题。

**正确示例**：
```javascript
// test/emailParser.test.js
describe('parseEmailContent', () => {
  test('应正确解析单产品订单', () => {
    const emailBody = 'MG714CH/A-iPhone 17 x 1/冉念/5904/支付宝';
    const result = parseEmailContent(emailBody);
    expect(result.products).toHaveLength(1);
    expect(result.recipient).toBe('冉念');
  });
  
  test('应正确解析多产品订单', () => {
    const emailBody = 'iPhone x 2@Belkin挂绳 x 1/冉念/5904/支付宝';
    const result = parseEmailContent(emailBody);
    expect(result.products).toHaveLength(2);
  });
});
```

**工具检查**：Jest + nyc/istanbul

### [TEST-002] 测试命名规范 [推荐] [info]

**说明**：测试文件命名为 `*.test.js`，测试描述使用"应该..."句式，清晰表达测试意图。

**原因**：统一的命名和描述让测试报告更易读。

**正确示例**：
```javascript
describe('OrderCrawler', () => {
  describe('fetchOrderDetails', () => {
    test('应在成功时返回订单详情', async () => { });
    test('应在 404 时抛出异常', async () => { });
    test('应在触发风控时使用备用代理', async () => { });
  });
});
```

**错误示例**：
```javascript
test('test1', () => { });  // 名称不明确
test('fetchOrderDetails works', () => { });  // 非中文项目可接受
```

**工具检查**：Jest 配置

---

## 10. 日志规范

### [LOG-001] 日志库选择 [必须] [error]

**说明**：使用 Winston 作为统一日志库，禁止使用 console.log/error/warn。

**原因**：结构化日志便于查询、分析和告警，console 输出无法持久化和搜索。

**配置示例**：
```javascript
// utils/logger.js
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'apple-order-manager' },
  transports: [
    // 错误日志单独文件
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error' 
    }),
    // 所有日志
    new winston.transports.File({ 
      filename: 'logs/combined.log' 
    })
  ]
});

// 开发环境输出到控制台
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

module.exports = logger;
```

**工具检查**：ESLint `no-console`

### [LOG-002] 日志级别规范 [必须] [error]

**说明**：严格按日志级别记录信息，不混用级别。

**原因**：正确的日志级别便于过滤和告警。

**级别定义**：
- **error**：系统错误，需要立即处理（如数据库连接失败、爬虫多次重试失败）
- **warn**：警告信息，可能影响功能（如代理失效、HTTP 541风控）
- **info**：重要业务事件（如邮件解析成功、订单爬取完成）
- **debug**：调试信息，详细执行流程（仅开发环境）

**正确示例**：
```javascript
// 业务事件
logger.info('邮件解析成功', { 
  emailId, 
  orderNumber, 
  productCount: products.length 
});

// 警告
logger.warn('触发反爬虫机制', { 
  orderNumber, 
  statusCode: 541, 
  retryCount 
});

// 错误
logger.error('数据库保存失败', { 
  orderNumber, 
  error: error.message, 
  stack: error.stack 
});

// 调试
logger.debug('开始解析邮件', { 
  emailId, 
  bodyLength: emailBody.length 
});
```

**错误示例**：
```javascript
logger.info('数据库连接失败');  // 应该用 error
logger.error('用户登录成功');  // 应该用 info
```

**工具检查**：手动审查

### [LOG-003] 结构化日志 [必须] [error]

**说明**：日志必须包含上下文信息（如订单号、邮件ID），使用对象形式记录，不使用字符串拼接。

**原因**：结构化日志便于查询、统计和告警。

**正确示例**：
```javascript
logger.error('爬虫请求失败', {
  orderNumber: 'W123456789',
  url: 'https://...',
  statusCode: error.response?.status,
  message: error.message,
  duration: Date.now() - startTime
});
```

**错误示例**：
```javascript
logger.error(`爬虫请求失败: ${orderNumber} - ${error.message}`);  // 字符串拼接
logger.error('爬虫请求失败');  // 缺少上下文
```

**工具检查**：手动审查

---

## 11. Sequelize ORM 规范

### [ORM-001] 模型定义规范 [必须] [error]

**说明**：模型文件使用大驼峰命名，表名使用下划线命名，字段必须定义类型和约束。

**原因**：清晰的模型定义避免数据类型错误和约束遗漏。

**正确示例**：
```javascript
// models/Order.js
const { Model, DataTypes } = require('sequelize');

class Order extends Model {
  static associate(models) {
    // 定义关联关系
    Order.belongsTo(models.AppleId, { foreignKey: 'apple_id_id' });
    Order.belongsTo(models.Recipient, { foreignKey: 'recipient_id' });
  }
}

Order.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  orderNumber: {
    type: DataTypes.STRING(20),
    allowNull: false,
    unique: true,
    field: 'order_number',
    validate: {
      is: /^W\d{9}$/  // W订单号格式验证
    }
  },
  products: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: []
  },
  status: {
    type: DataTypes.ENUM('pending', 'processing', 'completed', 'cancelled'),
    defaultValue: 'pending'
  }
}, {
  sequelize,
  modelName: 'Order',
  tableName: 'orders',
  underscored: true,  // 字段自动转下划线
  timestamps: true
});

module.exports = Order;
```

**工具检查**：手动审查

### [ORM-002] 事务处理 [必须] [error]

**说明**：涉及多表操作或数据一致性要求高的操作必须使用事务。

**原因**：事务保证数据一致性，避免部分成功导致的脏数据。

**正确示例**：
```javascript
const { sequelize } = require('./models');

async function saveOrderWithRelations(orderData) {
  const transaction = await sequelize.transaction();
  
  try {
    // 查找或创建 Apple ID
    const [appleId] = await AppleId.findOrCreate({
      where: { email: orderData.appleId },
      defaults: { email: orderData.appleId },
      transaction
    });
    
    // 查找或创建收件人
    const [recipient] = await Recipient.findOrCreate({
      where: { 
        name: orderData.recipient.name,
        idCardLast4: orderData.recipient.idCardLast4
      },
      defaults: orderData.recipient,
      transaction
    });
    
    // 创建订单
    const order = await Order.create({
      orderNumber: orderData.orderNumber,
      appleIdId: appleId.id,
      recipientId: recipient.id,
      products: orderData.products,
      paymentMethod: orderData.paymentMethod
    }, { transaction });
    
    await transaction.commit();
    return order;
    
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
```

**错误示例**：
```javascript
// 无事务，可能导致数据不一致
const appleId = await AppleId.create({ email });
const order = await Order.create({ appleIdId: appleId.id });  // 如果失败，appleId已创建
```

**工具检查**：手动审查

### [ORM-003] 迁移文件规范 [推荐] [warning]

**说明**：所有数据库结构变更必须通过迁移文件管理，迁移文件命名格式：`YYYYMMDDHHMMSS-description.js`。

**原因**：迁移文件记录数据库变更历史，便于版本控制和环境同步。

**正确示例**：
```javascript
// migrations/20260706120000-create-orders-table.js
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('orders', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      order_number: {
        type: Sequelize.STRING(20),
        allowNull: false,
        unique: true
      },
      apple_id_id: {
        type: Sequelize.UUID,
        references: {
          model: 'apple_ids',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      status: {
        type: Sequelize.ENUM('pending', 'processing', 'completed', 'cancelled'),
        defaultValue: 'pending'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false
      }
    });
    
    // 添加索引
    await queryInterface.addIndex('orders', ['order_number']);
    await queryInterface.addIndex('orders', ['status']);
  },
  
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('orders');
  }
};
```

**工具检查**：Git 版本控制

### [ORM-004] 查询优化 [推荐] [warning]

**说明**：使用 attributes 限制返回字段，使用 raw 查询提升性能，避免查询不必要的关联数据。

**原因**：减少数据传输量和内存占用，提升查询性能。

**正确示例**：
```javascript
// 只查询需要的字段
const orders = await Order.findAll({
  attributes: ['id', 'orderNumber', 'status'],
  where: { status: 'pending' },
  include: [{
    model: AppleId,
    attributes: ['email']  // 只查询邮箱
  }],
  limit: 100
});

// 统计查询使用 raw
const count = await Order.count({
  where: { status: 'completed' },
  raw: true
});
```

**错误示例**：
```javascript
// 查询所有字段（包括大 JSONB 字段）
const orders = await Order.findAll();  // 无限制，可能返回数万条

// 不必要的关联
const order = await Order.findByPk(id, {
  include: [AppleId, Recipient]  // 如果不需要关联数据，不应加载
});
```

**工具检查**：数据库慢查询日志

---

## 附录 A: 工具配置文件

### .eslintrc.json

```json
{
  "env": {
    "node": true,
    "es2021": true,
    "jest": true
  },
  "extends": ["eslint:recommended"],
  "parserOptions": {
    "ecmaVersion": 12
  },
  "rules": {
    "indent": ["error", 2],
    "quotes": ["error", "single"],
    "semi": ["error", "always"],
    "camelcase": ["error", { "properties": "always" }],
    "no-console": "warn",
    "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    "no-magic-numbers": ["warn", { "ignore": [0, 1, -1] }],
    "require-await": "error",
    "no-async-promise-executor": "error",
    "max-len": ["warn", { "code": 100, "ignoreUrls": true }]
  }
}
```

### .prettierrc

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "printWidth": 100,
  "trailingComma": "es5",
  "arrowParens": "avoid"
}
```

### .editorconfig

```ini
root = true

[*]
charset = utf-8
indent_style = space
indent_size = 2
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

---

## 附录 B: 自动化检查脚本

### Git Pre-commit Hook

```bash
#!/bin/sh
# .git/hooks/pre-commit

echo "运行代码检查..."

# ESLint 检查
npm run lint
if [ $? -ne 0 ]; then
  echo "❌ ESLint 检查失败，请修复后再提交"
  exit 1
fi

# Prettier 格式检查
npm run format:check
if [ $? -ne 0 ]; then
  echo "❌ 代码格式不符合规范，运行 npm run format 自动修复"
  exit 1
fi

# 单元测试
npm test
if [ $? -ne 0 ]; then
  echo "❌ 单元测试失败"
  exit 1
fi

echo "✅ 所有检查通过"
exit 0
```

### package.json 脚本配置

```json
{
  "scripts": {
    "lint": "eslint . --ext .js",
    "lint:fix": "eslint . --ext .js --fix",
    "format": "prettier --write \"**/*.{js,json,md}\"",
    "format:check": "prettier --check \"**/*.{js,json,md}\"",
    "test": "jest --coverage",
    "test:watch": "jest --watch",
    "prepare": "husky install"
  },
  "devDependencies": {
    "eslint": "^8.0.0",
    "prettier": "^3.0.0",
    "jest": "^29.0.0",
    "husky": "^8.0.0"
  }
}
```

### CI/CD Pipeline 配置 (.github/workflows/ci.yml)

```yaml
name: Code Quality Check

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main, develop ]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Run ESLint
      run: npm run lint
    
    - name: Check code format
      run: npm run format:check
    
    - name: Run tests
      run: npm test
    
    - name: Upload coverage
      uses: codecov/codecov-action@v3
      with:
        files: ./coverage/lcov.info
```

---

## 附录 C: 规范演进

### 版本历史

| 版本 | 日期 | 修改内容 | 作者 |
|------|------|---------|------|
| 1.0 | 2026-07-06 | 初始版本，建立基础编码规范 | Seraph |

### 修改流程

1. **提议阶段**：任何团队成员可以通过 GitHub Issue 提出规范修改建议
2. **讨论阶段**：团队成员在 Issue 中讨论修改的必要性和影响范围
3. **投票阶段**：对于争议性规则，需要团队多数成员同意（>50%）
4. **实施阶段**：更新本文档，同步更新工具配置文件
5. **通知阶段**：在团队会议中宣布规范变更，给予 1 周适应期
6. **强制阶段**：适应期后，CI/CD 开始强制执行新规范

### 渐进式采用建议

对于现有代码库，建议采用渐进式策略：

**Phase 1（第 1-2 周）**：
- 仅对新增文件应用全部规范
- 现有文件仅修复 [必须] + [error] 级别问题

**Phase 2（第 3-4 周）**：
- 逐步重构核心模块（services/, crawler/）
- 应用全部 [必须] 级别规范

**Phase 3（第 5+ 周）**：
- 全面应用所有规范
- 开启 CI/CD 严格检查模式

---

## 快速参考

### 命名速查表

| 类型 | 规则 | 示例 |
|------|------|------|
| 变量 | 小驼峰 | `orderNumber`, `appleId` |
| 函数 | 小驼峰 + 动词 | `parseEmail()`, `fetchOrder()` |
| 类 | 大驼峰 + 名词 | `EmailParser`, `Order` |
| 常量 | 全大写 + 下划线 | `MAX_RETRY`, `REQUEST_DELAY` |
| 文件 | 小驼峰或短横线 | `emailParser.js`, `order-crawler.js` |

### 常见错误检查清单

在提交代码前，确认以下事项：

- [ ] 所有异步函数都有错误处理（try-catch）
- [ ] 没有硬编码的敏感信息（密码、密钥）
- [ ] 数据库查询避免了 N+1 问题
- [ ] 爬虫请求有适当延迟（5-10秒）
- [ ] 外部输入进行了验证和边界检查
- [ ] 核心功能有单元测试覆盖
- [ ] 导出的函数有 JSDoc 注释
- [ ] 资源使用后正确释放（连接、文件句柄）
- [ ] 代码通过 ESLint 和 Prettier 检查
- [ ] 没有使用 console.log（应使用 logger）

---

## 工具安装与使用

### 初始化项目规范工具

```bash
# 安装依赖
npm install --save-dev eslint prettier jest husky

# 初始化 ESLint
npx eslint --init

# 初始化 Husky（Git Hooks）
npx husky install
npx husky add .husky/pre-commit "npm run lint && npm test"

# 创建配置文件
# 复制附录 A 中的配置文件到项目根目录
```

### 日常使用命令

```bash
# 检查代码规范
npm run lint

# 自动修复代码规范问题
npm run lint:fix

# 格式化代码
npm run format

# 检查格式（不修改文件）
npm run format:check

# 运行测试
npm test

# 运行测试并查看覆盖率
npm run test -- --coverage
```

### IDE 集成

**VS Code 推荐插件**：
- ESLint (dbaeumer.vscode-eslint)
- Prettier - Code formatter (esbenp.prettier-vscode)
- EditorConfig for VS Code (editorconfig.editorconfig)

**VS Code 配置 (settings.json)**：
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "eslint.validate": ["javascript"]
}
```

---

## 总结

本编码规范旨在提升 Apple Order Manager 项目的代码质量和可维护性。核心原则：

1. **一致性优先**：统一的代码风格降低理解成本
2. **安全第一**：严格的输入验证和错误处理
3. **性能关注**：避免 N+1 查询、合理的爬虫延迟
4. **可测试性**：核心逻辑有单元测试覆盖
5. **工具辅助**：利用 ESLint、Prettier 自动化检查

**记住**：规范不是束缚，而是团队协作的共同语言。遇到不合理的规范，及时提出改进建议。

---

**文档维护者**：Seraph  
**最后更新**：2026-07-06  
**反馈渠道**：GitHub Issues

