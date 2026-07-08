# 任务通知功能说明

## 功能介绍

在任务完成后自动发出提示音和系统通知，提醒用户任务已完成。

---

## 使用方法

### 1. 命令行方式

#### Bash 脚本
```bash
# 成功通知
./scripts/notify.sh "数据库迁移完成" "success"

# 错误通知
./scripts/notify.sh "数据库迁移失败" "error"

# 普通通知
./scripts/notify.sh "开始处理邮件" "info"
```

#### Node.js 脚本
```bash
# 成功通知
node src/utils/notify.js "数据库迁移完成" "success"

# 错误通知
node src/utils/notify.js "数据库迁移失败" "error"

# 普通通知
node src/utils/notify.js "开始处理邮件" "info"
```

### 2. 在代码中使用

```javascript
const { notify } = require('./src/utils/notify');

// 成功通知
notify('数据库迁移完成', 'success');

// 错误通知
notify('数据库连接失败', 'error');

// 普通通知
notify('正在处理邮件', 'info');
```

### 3. 在脚本中使用

#### 数据库迁移完成后通知
```bash
npm run db:migrate && node src/utils/notify.js "数据库迁移完成" "success"
```

#### 测试完成后通知
```bash
npm test && node src/utils/notify.js "测试通过" "success" || node src/utils/notify.js "测试失败" "error"
```

---

## 通知类型

| 类型 | 图标 | 提示音 | 用途 |
|------|------|--------|------|
| success | ✅ | Glass | 任务成功完成 |
| error | ❌ | Basso | 任务执行失败 |
| info | ℹ️ | Ping | 普通信息通知 |

---

## 示例场景

### 场景 1：数据库迁移脚本

```javascript
const { notify } = require('./src/utils/notify');
const { sequelize } = require('./src/models');

async function runMigrations() {
  try {
    await sequelize.authenticate();
    console.log('开始执行数据库迁移...');
    
    // 执行迁移逻辑
    // ...
    
    notify('数据库迁移完成', 'success');
  } catch (error) {
    console.error('迁移失败:', error);
    notify('数据库迁移失败', 'error');
    process.exit(1);
  }
}
```

### 场景 2：邮件解析服务

```javascript
const { notify } = require('../utils/notify');
const logger = require('../utils/logger');

async function processEmail(emailData) {
  try {
    // 解析邮件
    const parsedData = parseEmailContent(emailData);
    
    // 保存到数据库
    await saveOrder(parsedData);
    
    logger.info('邮件解析成功', { orderNumber: parsedData.orderNumber });
    notify(`订单 ${parsedData.orderNumber} 解析成功`, 'success');
  } catch (error) {
    logger.error('邮件解析失败', { error: error.message });
    notify('邮件解析失败', 'error');
  }
}
```

### 场景 3：爬虫任务

```javascript
const { notify } = require('../utils/notify');

async function crawlOrders() {
  const pendingOrders = await Order.findAll({ where: { status: 'pending' } });
  
  notify(`开始爬取 ${pendingOrders.length} 个订单`, 'info');
  
  let successCount = 0;
  let failCount = 0;
  
  for (const order of pendingOrders) {
    try {
      await crawlOrderDetails(order);
      successCount++;
    } catch (error) {
      failCount++;
    }
  }
  
  if (failCount === 0) {
    notify(`爬取完成：${successCount} 个订单成功`, 'success');
  } else {
    notify(`爬取完成：${successCount} 成功，${failCount} 失败`, 'error');
  }
}
```

---

## 系统要求

- **macOS**: 完整支持（提示音 + 系统通知）
- **Linux**: 终端提示（可扩展支持 libnotify）
- **Windows**: 终端提示（可扩展支持 Windows 通知）

---

## 自定义扩展

如果需要添加更多通知类型，可以修改 `src/utils/notify.js`：

```javascript
const config = {
  success: { sound: 'Glass', icon: '✅', message: '任务完成' },
  error: { sound: 'Basso', icon: '❌', message: '任务失败' },
  info: { sound: 'Ping', icon: 'ℹ️', message: '任务通知' },
  warning: { sound: 'Funk', icon: '⚠️', message: '警告' },  // 新增
  complete: { sound: 'Hero', icon: '🎉', message: '全部完成' }  // 新增
};
```

---

## 注意事项

1. **权限问题**：首次使用可能需要授予终端访问通知的权限
2. **静音模式**：如果系统处于静音模式，提示音不会播放
3. **勿扰模式**：系统通知可能不会显示，但终端提示仍然有效
4. **性能影响**：通知调用是异步的，不会阻塞主流程

---

**创建时间**：2026-07-07  
**最后更新**：2026-07-07
