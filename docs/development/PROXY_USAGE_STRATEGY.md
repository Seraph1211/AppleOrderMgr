# 代理使用策略文档

**更新时间**: 2026-07-09  
**作者**: Seraph

## 概述

本文档详细说明当前项目的代理使用策略、IP 消耗原因分析，以及优化建议。

---

## 当前代理策略

### 1. 代理来源

- **供应商**: 快代理（KDL）
- **类型**: 私密代理（带用户名密码认证）
- **有效期**: **1-5 分钟**（极短！）
- **获取方式**: 通过 API 一次性获取 N 个代理（例如 1000 个）

### 2. 代理池管理策略

#### 初始化加载
```javascript
// src/utils/proxyManager.js:71-108
async loadProxies() {
  // 调用快代理 API 获取代理列表
  const response = await axios.get(apiUrl);
  
  // 解析格式: { code: 0, data: { proxy_list: ["ip:port:user:pass", ...] } }
  this.proxies = parseProxyResponse(response.data);
  
  // ⚠️ 全量替换策略 - 清空所有历史数据
  this.badProxies.clear();
  this.proxyFailCount.clear();
}
```

**问题**: 每次刷新会清空所有已废弃代理记录和失败计数，但新代理有效期只有 1-5 分钟。

#### 代理轮换策略
```javascript
// src/utils/proxyManager.js:182-210
getNextProxy() {
  // 轮询策略：按索引顺序获取下一个可用代理
  while (attempts < this.proxies.length) {
    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    
    // 跳过已废弃的代理
    if (!this.badProxies.has(proxyKey)) {
      return proxy;
    }
    attempts++;
  }
  
  return null; // 无可用代理
}
```

**特点**: 简单轮询，跳过坏代理。当所有代理都废弃后返回 `null`。

#### 失败处理策略（最严格）
```javascript
// src/utils/proxyManager.js:217-250
recordProxyFailure(proxy) {
  const currentFailCount = this.proxyFailCount.get(proxyKey) || 0;
  const newFailCount = currentFailCount + 1;
  
  this.proxyFailCount.set(proxyKey, newFailCount);
  
  // ⚠️ 失败 2 次永久废弃
  if (newFailCount >= 2) {
    this.badProxies.add(proxyKey);
    return true; // 已废弃
  }
  
  return false;
}

recordProxySuccess(proxy) {
  // ⚠️ 成功后不重置失败计数！
  // 失败次数累积，永不清零
}
```

**关键问题**:
1. **失败阈值极低**: 仅允许失败 2 次
2. **失败计数永不重置**: 即使成功 100 次，之前的 1 次失败仍然计入
3. **无恢复机制**: 一旦废弃，永不恢复

#### 自动刷新策略
```javascript
// src/utils/proxyManager.js:55-56
// ⚠️ 自动刷新已禁用 - 按需手动刷新，避免浪费代理配额
// this.startAutoRefresh();
logger.info('代理池自动刷新已禁用（按需手动刷新模式）');
```

**当前状态**: **已禁用**自动刷新，需要手动调用 `proxyManager.refresh()`。

---

## 爬虫服务如何使用代理

### 爬取流程

```javascript
// src/services/crawlerService.js:277-382
async function fetchWithRetry(orderUrl, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // 1. 获取代理
    currentProxy = proxyManager.getNextProxy();
    
    // 2. 发送请求
    const html = await fetchOrderPage(orderUrl, currentProxy);
    
    // 3. 解析数据
    const orderData = parseOrderData(orderJson, html);
    
    // 4. 记录成功（不重置失败计数）
    proxyManager.recordProxySuccess(currentProxy);
    
    return { success: true, data: orderData };
  }
}
```

### 失败处理

```javascript
// src/services/crawlerService.js:342-365
if (error.response?.status === 541) {
  // HTTP 541: Apple 风控，立即永久废弃
  proxyManager.markProxyAsBad(currentProxy);
  await proxyManager.refresh(); // 尝试刷新代理池
} else {
  // 其他错误：累计失败次数
  proxyManager.recordProxyFailure(currentProxy);
}
```

### 请求延迟

```javascript
// src/services/crawlerService.js:36-38
function getRandomDelay() {
  return Math.floor(Math.random() * 5000) + 5000; // 5-10秒
}
```

**批量爬取**: 每个订单之间延迟 5-10 秒。

---

## 为什么代理消耗很快？

### 真实配置

**重要发现**：
```bash
# .env 配置
PROXY_API_URL=...&num=3&...  # 每次只获取 3 个代理（不是 1000 个！）
PROXY_ENABLED=false          # 默认关闭
```

**实际情况**：
- 每次调用 `proxyManager.initialize()` 或 `refresh()` 只获取 **3 个代理**
- 如果代理有效期是 1-5 分钟，3 个代理很快就用完或过期

### 问题分析

#### 1. **代理有效期极短（1-5 分钟）**
```
快代理返回的代理有效期: 1-5 分钟
即使只获取 3 个代理，5 分钟后也会过期
```

**示例**:
- 获取 3 个代理
- 爬取 1 个订单耗时 10 秒（请求 + 解析）
- 如果失败重试 3 次，需要切换 3 个代理
- **1 个订单就消耗完 3 个代理！**

#### 2. **失败阈值过低（2 次）**
```javascript
// 代理失败 2 次就永久废弃
if (newFailCount >= 2) {
  this.badProxies.add(proxyKey);
}
```

**影响**:
- 网络波动导致 1 次失败
- 重试时再失败 1 次 → **永久废弃**
- 即使这个代理后续可能正常，也无法恢复

#### 3. **失败计数永不重置**
```javascript
// 成功后不清零失败计数
recordProxySuccess(proxy) {
  // 不重置 this.proxyFailCount
}
```

**后果**:
- 代理 A 失败 1 次（计数 = 1）
- 成功 100 次（计数仍然 = 1）
- 再失败 1 次（计数 = 2）→ **永久废弃**

#### 4. **❌ HTTP 541 后立即刷新浪费代理（已修复）**
```javascript
// ❌ 之前的错误逻辑
if (error.response?.status === 541) {
  proxyManager.markProxyAsBad(currentProxy);
  await proxyManager.refresh(); // 浪费！代理池里还有可用代理
}

// ✅ 修复后的正确逻辑
if (error.response?.status === 541) {
  proxyManager.markProxyAsBad(currentProxy);
  // 不刷新，下次循环 getNextProxy() 会自动获取下一个代理
  // 只有当代理池耗尽时，才在获取代理时自动刷新
}
```

**之前的浪费场景**:
- 代理池有 3 个代理：A、B、C
- 代理 A 触发 HTTP 541 → 立即刷新获取新的 3 个代理
- **代理 B、C 被浪费！**

**修复后**:
- 代理 A 触发 HTTP 541 → 只废弃 A
- 重试时使用代理 B → 如果失败使用代理 C
- **只有 A、B、C 都用完，才刷新获取新代理**

#### 5. **测试代码反复初始化代理池**
```javascript
// test/test_crawler.js:96, 293
await proxyManager.initialize(); // 每次测试都获取 3 个新代理
```

**浪费场景**:
- 运行测试 1 次 → 获取 3 个代理（可能只用 1 个）
- 运行测试 10 次 → 获取 30 个代理
- 运行测试 100 次 → 获取 300 个代理 ❌

**建议**: 测试代码应该检查代理池是否已初始化，避免重复获取。

#### 6. **爬虫重试机制放大消耗**
```javascript
// 每个订单最多重试 3 次
for (let attempt = 1; attempt <= maxRetries; attempt++) {
  currentProxy = proxyManager.getNextProxy(); // 每次重试获取新代理
  // ...
}
```

**示例**:
- 订单 A 失败 3 次 → 消耗 3 个代理
- 其中 2 个代理因为失败 2 次被永久废弃
- 实际只爬取了 1 个订单，浪费了 2 个代理

---

## IP 消耗速度计算（基于实际配置）

### 场景 1: 爬取单个订单（成功）

**假设**:
- 每次获取 3 个代理
- 第 1 次尝试成功

**消耗计算**:
```
初始化代理池: 获取 3 个代理
第 1 次尝试: 使用代理 A，成功
剩余代理: B、C（5 分钟后过期）

总消耗: 3 个代理
实际使用: 1 个代理
浪费: 2 个代理过期
利用率: 33.3%
```

### 场景 2: 爬取单个订单（失败 3 次）

**假设**:
- 每次获取 3 个代理
- 失败 3 次，代理用完后刷新

**消耗计算**:
```
初始化: 获取 3 个代理（A、B、C）
第 1 次尝试: 使用 A，失败（失败计数 +1）
第 2 次尝试: 使用 B，失败（失败计数 +1）
第 3 次尝试: 使用 C，失败（失败计数 +1）

代理池耗尽，刷新: 获取 3 个新代理（D、E、F）
第 4 次尝试: 使用 D，失败
... （循环）

总消耗: 6-9 个代理（2-3 次刷新）
实际成功: 0 个订单
浪费: 100%（全部用于重试失败）
```

### 场景 3: 测试代码运行 10 次

**假设**:
- 每次测试都调用 `proxyManager.initialize()`
- 每次测试只爬取 1 个订单

**消耗计算**:
```
测试 1: 获取 3 个代理，使用 1 个，剩余 2 个过期
测试 2: 获取 3 个代理，使用 1 个，剩余 2 个过期
...
测试 10: 获取 3 个代理，使用 1 个，剩余 2 个过期

总消耗: 30 个代理
实际使用: 10 个代理
浪费: 20 个代理过期
利用率: 33.3%
```

**结论**: 如果昨天运行了 300 次测试，就消耗了 900-1000 个代理！

---

## 优化建议

### 短期优化（快速见效）

#### 1. 增加失败阈值
```javascript
// src/utils/proxyManager.js:32
this.maxFailCount = config.proxy.maxFailCount || 5; // 改为 5 次
```

**效果**: 代理寿命延长 2.5 倍，减少不必要的废弃。

#### 2. 启用失败计数重置
```javascript
// src/utils/proxyManager.js:256-270
recordProxySuccess(proxy) {
  const proxyKey = `${proxy.host}:${proxy.port}`;
  
  // ✅ 成功后重置失败计数
  const currentFailCount = this.proxyFailCount.get(proxyKey) || 0;
  if (currentFailCount > 0) {
    this.proxyFailCount.set(proxyKey, Math.max(0, currentFailCount - 1));
    logger.debug('代理成功，失败计数递减', {
      proxy: proxyKey,
      newFailCount: currentFailCount - 1,
    });
  }
}
```

**效果**: 偶尔失败的"好代理"不会因为历史失败被错误废弃。

#### 3. 缩短爬取间隔（代理有效期内完成）
```javascript
// src/services/crawlerService.js:36-38
function getRandomDelay() {
  return Math.floor(Math.random() * 2000) + 2000; // 改为 2-4秒
}
```

**效果**: 在代理 5 分钟有效期内完成更多订单，减少过期浪费。

**⚠️ 风险**: 请求频率增加，可能触发 Apple 风控（需要测试）。

#### 4. 按需刷新（避免全量替换）
```javascript
// src/utils/proxyManager.js:70-116
async loadProxies(mode = 'refresh') {
  if (mode === 'append') {
    // 追加模式：只获取 100 个新代理补充
    const newProxies = parseProxyResponse(response.data);
    this.proxies.push(...newProxies);
    logger.info('追加代理', { added: newProxies.length });
  } else {
    // 全量刷新模式
    this.proxies = parseProxyResponse(response.data);
    this.badProxies.clear();
  }
}
```

**效果**: 减少浪费，延长代理使用周期。

---

### 中期优化（架构调整）

#### 1. 智能代理池分级管理
```javascript
class ProxyManager {
  constructor() {
    this.freshProxies = [];   // 新鲜代理（成功率 > 80%）
    this.normalProxies = [];  // 普通代理（成功率 50-80%）
    this.suspectProxies = []; // 可疑代理（成功率 < 50%）
  }
  
  getNextProxy() {
    // 优先使用新鲜代理，其次普通代理，最后可疑代理
    return this.freshProxies[0] || this.normalProxies[0] || this.suspectProxies[0];
  }
}
```

#### 2. 代理有效期追踪
```javascript
class ProxyManager {
  parseProxyString(proxyStr) {
    return {
      host: parts[0],
      port: parseInt(parts[1]),
      auth: { username: parts[2], password: parts[3] },
      createdAt: Date.now(),           // 记录创建时间
      expiresAt: Date.now() + 300000,  // 5 分钟后过期
    };
  }
  
  getNextProxy() {
    // 过滤过期代理
    const validProxies = this.proxies.filter(p => p.expiresAt > Date.now());
    
    if (validProxies.length === 0) {
      logger.warn('所有代理已过期，触发刷新');
      await this.refresh();
    }
    
    return validProxies[this.currentIndex];
  }
}
```

#### 3. 自适应批量爬取
```javascript
async function crawlMultipleOrders(orderIds) {
  const proxyStatus = proxyManager.getStatus();
  const availableProxies = proxyStatus.available;
  
  // 根据可用代理数量动态调整批次大小
  const batchSize = Math.min(availableProxies / 3, 50);
  
  logger.info('自适应批量爬取', {
    totalOrders: orderIds.length,
    availableProxies,
    batchSize,
  });
  
  // 分批处理
  for (let i = 0; i < orderIds.length; i += batchSize) {
    const batch = orderIds.slice(i, i + batchSize);
    await processBatch(batch);
    
    // 检查是否需要刷新代理
    if (proxyManager.needsRefresh()) {
      await proxyManager.refresh();
    }
  }
}
```

---

### 长期优化（成本优化）

#### 1. 切换代理供应商
**推荐**: 寻找提供**长效代理**的供应商（有效期 > 30 分钟）

**对比**:
| 供应商 | 有效期 | 价格 | 适用场景 |
|--------|--------|------|----------|
| 快代理（当前） | 1-5 分钟 | ¥50-200/月 | 高频短任务 |
| 阿布云 | 5-30 分钟 | ¥100-300/月 | 中频任务 |
| 芝麻代理 | 1-5 分钟 | ¥80-250/月 | 高频短任务 |
| 太阳代理 | 30-60 分钟 | ¥200-500/月 | 低频长任务 ✅ |

**建议**: 切换到有效期 > 30 分钟的供应商，可减少 80% 的 IP 浪费。

#### 2. 实施代理复用策略
```javascript
// 每个代理在有效期内尽可能复用
class ProxyManager {
  getNextProxy() {
    // 优先返回最近成功的代理（热代理）
    const hotProxy = this.getHotProxy();
    if (hotProxy) return hotProxy;
    
    // 其次返回未使用过的代理
    return this.getUnusedProxy();
  }
  
  getHotProxy() {
    // 返回最近 10 秒内成功的代理
    const recentSuccess = this.successHistory
      .filter(record => Date.now() - record.timestamp < 10000)
      .sort((a, b) => b.timestamp - a.timestamp);
    
    return recentSuccess[0]?.proxy || null;
  }
}
```

---

## 配置建议

### 开发环境
```bash
# .env.development
PROXY_ENABLED=false              # 开发时禁用代理
CRAWLER_DELAY_MIN=2000           # 2 秒
CRAWLER_DELAY_MAX=4000           # 4 秒
CRAWLER_MAX_RETRY=2              # 最多重试 2 次
```

### 生产环境（推荐配置）
```bash
# .env.production
PROXY_ENABLED=true
PROXY_API_URL=https://api.kdlapi.com/...
PROXY_MAX_FAIL_COUNT=5           # 失败 5 次才废弃
PROXY_REFRESH_THRESHOLD=0.3      # 可用代理 < 30% 时刷新
CRAWLER_DELAY_MIN=3000           # 3 秒（平衡速度和风控）
CRAWLER_DELAY_MAX=6000           # 6 秒
CRAWLER_MAX_RETRY=3              # 最多重试 3 次
```

---

## 监控指标

### 关键指标
```javascript
const metrics = {
  totalProxies: 1000,              // 总代理数
  availableProxies: 450,           // 可用代理数
  badProxies: 550,                 // 已废弃代理数
  utilizationRate: 0.45,           // 利用率: 45%
  avgResponseTime: 2500,           // 平均响应时间: 2.5秒
  successRate: 0.72,               // 成功率: 72%
  expiredProxies: 200,             // 过期未使用代理数
};
```

### 监控日志
```javascript
// 每小时输出代理池状态
setInterval(() => {
  const status = proxyManager.getStatus();
  logger.info('代理池状态报告', {
    total: status.total,
    available: status.available,
    bad: status.bad,
    utilizationRate: ((status.available / status.total) * 100).toFixed(1) + '%',
  });
}, 3600000);
```

---

## 总结

### 当前问题
1. ❌ **代理有效期过短**（1-5 分钟）导致大量过期浪费
2. ❌ **失败阈值过低**（2 次）导致误判废弃
3. ❌ **失败计数永不重置**导致好代理被错误废弃
4. ❌ **全量刷新策略**浪费剩余可用代理
5. ❌ **重试机制**放大代理消耗

### 改进优先级
1. 🔴 **高优先级**: 增加失败阈值（2 → 5）
2. 🔴 **高优先级**: 启用失败计数重置（成功时递减）
3. 🟡 **中优先级**: 添加代理有效期追踪
4. 🟡 **中优先级**: 实施追加刷新模式（避免全量替换）
5. 🟢 **低优先级**: 评估切换到长效代理供应商

### 预期效果
实施以上优化后，预计可：
- ✅ **减少 IP 消耗 60-70%**
- ✅ **提高代理利用率** 45% → 75%
- ✅ **延长 1000 个 IP 的使用周期** 1 天 → 3-5 天

---

**最后更新**: 2026-07-09  
**维护者**: Seraph
