# 订单爬虫方案

## 一、目标网站

### 订单详情页
- **URL 格式**: `https://www.apple.com.cn/xc/cn/vieworder/{订单号}/{邮箱}`
- **示例**: `https://www.apple.com.cn/xc/cn/vieworder/W1316796973/15123298843@8lvv.com`
- **访问权限**: 无需登录，直接访问
- **页面类型**: React 单页应用，数据在 `<script>` 标签中的 JSON

---

## 二、反爬策略与应对

### 2.1 Apple 官网的反爬机制

| 反爬手段 | 严格程度 | 应对方案 |
|---------|---------|---------|
| User-Agent 检测 | 低 | 设置真实浏览器 UA |
| IP 频率限制 | **中** | **代理池 + 请求延时** |
| Cookie 验证 | 无 | 无需处理 |
| JavaScript 渲染 | 低 | 数据在 HTML 中，无需执行 JS |

### 2.2 风控阈值（经验值）

- **单 IP 访问频率**: 建议 < 10 次/分钟
- **请求间隔**: 5-10 秒
- **超过阈值后果**: 返回 541 状态码（Page Not Found）

---

## 三、技术方案

### 3.1 HTTP 客户端选择

**选用 axios（轻量级）**

✅ **优点**:
- 轻量快速，无需启动浏览器
- 支持代理配置
- 内存占用小

❌ **不选用 Puppeteer 的原因**:
- 性能开销大（每次启动浏览器）
- 内存占用高
- 本项目不需要执行 JavaScript（数据已在 HTML 中）

### 3.2 HTML 解析

**选用 cheerio**

- jQuery 语法，易于操作 DOM
- 轻量级，解析速度快
- 不执行 JavaScript，只解析 HTML

---

## 四、代理池方案

### 4.1 代理服务商选择

| 服务商 | 价格 | IP 质量 | 推荐度 |
|-------|------|---------|-------|
| 快代理 | ¥50-200/月 | 高 | ⭐⭐⭐⭐⭐ |
| 芝麻代理 | ¥60-150/月 | 中 | ⭐⭐⭐⭐ |
| 阿布云 | ¥100-300/月 | 高 | ⭐⭐⭐⭐ |

**推荐**: 快代理（性价比高，稳定性好）

### 4.2 代理使用策略

```javascript
class ProxyService {
  constructor() {
    this.proxyPool = [];
    this.currentIndex = 0;
  }

  // 从代理 API 获取代理列表
  async fetchProxies() {
    const response = await axios.get(process.env.PROXY_API_URL, {
      params: {
        key: process.env.PROXY_API_KEY,
        num: 10,  // 一次获取 10 个代理
        type: 'http',
        format: 'json'
      }
    });

    this.proxyPool = response.data.map(p => ({
      host: p.ip,
      port: p.port,
      protocol: 'http'
    }));
  }

  // 轮换获取代理
  getProxy() {
    if (this.proxyPool.length === 0) {
      return null;
    }

    const proxy = this.proxyPool[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxyPool.length;
    return proxy;
  }
}
```

### 4.3 代理池刷新策略

- **初始化**: 启动时获取 10 个代理
- **定时刷新**: 每 30 分钟刷新一次
- **失败重试**: 代理失败时，切换到下一个代理重试（最多 3 次）

---

## 五、数据提取方案

### 5.1 页面结构分析

Apple 订单页面的数据存储在 `<script>` 标签中的 JSON 对象：

```html
<script>
{
  "meta": {...},
  "orderDetail": {
    "orderHeader": {
      "d": {
        "orderNumber": "W1316796973",
        "orderPlacedDate": "2025年11月8日"
      }
    },
    "orderItems": {
      "c": ["orderItem-0000101", "orderItem-0000201"],
      "orderItem-0000101": {
        "orderItemDetails": {
          "d": {
            "productName": "iPhone 17 Pro Max 1TB 星宇橙色",
            "quantity": 0,
            ...
          }
        }
      }
    }
  }
}
</script>
```

### 5.2 提取步骤

#### 步骤 1: 发送 HTTP 请求

```javascript
const axios = require('axios');
const cheerio = require('cheerio');

async function fetchOrderPage(orderUrl, proxy = null) {
  const config = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    },
    timeout: 30000
  };

  // 使用代理
  if (proxy) {
    config.proxy = {
      host: proxy.host,
      port: proxy.port,
      protocol: proxy.protocol
    };
  }

  const response = await axios.get(orderUrl, config);
  return response.data;
}
```

#### 步骤 2: 查找包含订单数据的 script 标签

```javascript
const $ = cheerio.load(html);
let orderJson = null;

$('script').each((i, elem) => {
  const scriptContent = $(elem).html();
  if (scriptContent && scriptContent.includes('orderItem-')) {
    try {
      // 清理控制字符
      const cleaned = scriptContent.trim()
        .replace(/[\x00-\x1F\x7F]/g, '')
        .replace(/\n/g, ' ')
        .replace(/\r/g, '')
        .replace(/\t/g, ' ');

      orderJson = JSON.parse(cleaned);
    } catch (e) {
      // JSON 解析失败，继续查找下一个
    }
  }
});
```

#### 步骤 3: 提取订单基本信息

```javascript
const orderNumber = orderJson.orderDetail.orderHeader.d.orderNumber;
const orderPlacedDate = orderJson.orderDetail.orderHeader.d.orderPlacedDate;

// 日期格式转换: "2025年11月8日" → "2025-11-08"
const dateMatch = orderPlacedDate.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
const formattedDate = dateMatch 
  ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
  : null;
```

#### 步骤 4: 提取商品列表

```javascript
const orderItems = orderJson.orderDetail.orderItems;
const products = [];

// 遍历所有商品项
Object.keys(orderItems).forEach(key => {
  if (key.startsWith('orderItem-') && key.match(/orderItem-\d+/)) {
    const item = orderItems[key];
    const itemDetails = item.orderItemDetails?.d;
    const itemStatus = item.orderItemStatusTracker?.d;
    const shippingInfo = item.shippingInfo?.d;

    if (itemDetails) {
      products.push({
        name: itemDetails.productName,
        quantity: itemDetails.quantity,
        status: itemStatus?.currentStatus || 'unknown',
        deliveryType: item.d?.deliveryType || 'unknown',
        imageUrl: itemDetails.imageData?.src || null,
        pickupType: itemDetails.pickupType,
        deliveryDate: itemDetails.deliveryDate
      });
    }
  }
});
```

#### 步骤 5: 提取取机门店信息

```javascript
// 从第一个商品的配送信息中提取门店
const firstItem = orderItems[orderItems.c[0]];
const storeInfo = firstItem?.shippingInfo?.['shipping-address']?.address?.d;

const pickupStore = storeInfo?.companyName || null;
const storeDirectionsUrl = firstItem?.orderItemDetails?.d?.hoursAndDirectionsURL || null;
```

---

## 六、完整爬虫函数

```javascript
const axios = require('axios');
const cheerio = require('cheerio');

async function crawlAppleOrder(orderUrl, proxy = null) {
  try {
    // 1. 发送请求
    const html = await fetchOrderPage(orderUrl, proxy);

    // 2. 解析 HTML
    const $ = cheerio.load(html);
    const bodyText = $('body').text();

    // 3. 提取 JSON 数据
    let orderJson = null;
    $('script').each((i, elem) => {
      const scriptContent = $(elem).html();
      if (scriptContent && scriptContent.includes('orderItem-')) {
        try {
          const cleaned = scriptContent.trim()
            .replace(/[\x00-\x1F\x7F]/g, '')
            .replace(/\n/g, ' ')
            .replace(/\r/g, '')
            .replace(/\t/g, ' ');
          orderJson = JSON.parse(cleaned);
        } catch (e) {
          // 继续尝试下一个
        }
      }
    });

    if (!orderJson) {
      throw new Error('无法提取订单 JSON 数据');
    }

    // 4. 提取订单基本信息
    const orderNumber = orderJson.orderDetail.orderHeader?.d?.orderNumber;
    const orderPlacedDate = orderJson.orderDetail.orderHeader?.d?.orderPlacedDate;
    
    const dateMatch = orderPlacedDate?.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    const orderDate = dateMatch 
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
      : null;

    // 5. 提取订单状态（从页面文本）
    let orderStatus = 'unknown';
    const statusKeywords = {
      '已取消': 'cancelled',
      '取货已取消': 'pickup_cancelled',
      '准备就绪': 'ready',
      '处理中': 'processing',
      '已发货': 'shipped',
      '已送达': 'delivered'
    };

    for (const [keyword, status] of Object.entries(statusKeywords)) {
      if (bodyText.includes(keyword)) {
        orderStatus = status;
        break;
      }
    }

    // 6. 提取商品列表
    const orderItems = orderJson.orderDetail.orderItems;
    const products = [];

    Object.keys(orderItems).forEach(key => {
      if (key.startsWith('orderItem-') && key.match(/orderItem-\d+/)) {
        const item = orderItems[key];
        const itemDetails = item.orderItemDetails?.d;
        const itemStatus = item.orderItemStatusTracker?.d;

        if (itemDetails) {
          products.push({
            name: itemDetails.productName,
            quantity: itemDetails.quantity,
            status: itemStatus?.currentStatus || 'unknown',
            deliveryType: item.d?.deliveryType || 'unknown',
            imageUrl: itemDetails.imageData?.src || null
          });
        }
      }
    });

    // 7. 提取取机门店
    let pickupStore = null;
    const storeRegex = /店内取货地点[：:]\s*(Apple\s+[一-龥\w]+)/;
    const storeMatch = bodyText.match(storeRegex);
    if (storeMatch) {
      pickupStore = storeMatch[1].trim();
    }

    return {
      orderNumber,
      orderDate,
      orderStatus,
      products,
      pickupStore,
      rawJson: orderJson
    };

  } catch (error) {
    throw new Error(`爬取订单失败: ${error.message}`);
  }
}

module.exports = { crawlAppleOrder };
```

---

## 七、错误处理与重试

### 7.1 HTTP 错误处理

```javascript
async function fetchWithRetry(orderUrl, maxRetries = 3) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      // 获取代理
      const proxy = proxyService.getProxy();
      
      // 发送请求
      const html = await fetchOrderPage(orderUrl, proxy);
      return html;

    } catch (error) {
      lastError = error;

      // 记录日志
      console.warn(`爬取失败 (尝试 ${i + 1}/${maxRetries}):`, error.message);

      // 风控检测
      if (error.response?.status === 541) {
        console.warn('检测到风控，切换代理...');
        await proxyService.fetchProxies(); // 刷新代理池
      }

      // 延时重试
      if (i < maxRetries - 1) {
        await sleep(5000 * (i + 1)); // 递增延时
      }
    }
  }

  throw new Error(`爬取失败，已重试 ${maxRetries} 次: ${lastError.message}`);
}
```

### 7.2 JSON 解析失败处理

如果 JSON 解析失败，回退到 HTML 解析：

```javascript
if (!orderJson) {
  // 回退方案：从 HTML 中提取关键信息
  const orderNumber = bodyText.match(/订单号[：:]\s*(W\d{10})/)?.[1];
  const orderDate = bodyText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)?.[0];
  
  // 提取商品名称（基于特定的 class）
  const products = [];
  $('.rs-od-itemname, .rs-display-item-name').each((i, elem) => {
    const name = $(elem).text().trim();
    if (name && name.length > 5) {
      products.push({
        name,
        quantity: 1, // HTML 解析无法获取准确数量
        status: 'unknown'
      });
    }
  });

  return { orderNumber, orderDate, products, pickupStore, rawJson: null };
}
```

---

## 八、性能优化

### 8.1 请求延时策略

```javascript
// 全局请求队列
class RequestQueue {
  constructor(delayMs = 5000) {
    this.queue = [];
    this.delayMs = delayMs;
    this.lastRequestTime = 0;
  }

  async enqueue(task) {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.delayMs) {
      await sleep(this.delayMs - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();
    return await task();
  }
}

const requestQueue = new RequestQueue(5000); // 5秒间隔

// 使用
await requestQueue.enqueue(() => crawlAppleOrder(orderUrl, proxy));
```

### 8.2 并发控制

```javascript
const pLimit = require('p-limit');

// 限制并发数为 3
const limit = pLimit(3);

const tasks = orderUrls.map(url => 
  limit(() => crawlAppleOrder(url))
);

const results = await Promise.all(tasks);
```

---

## 九、日志记录

```javascript
await CrawlLog.create({
  order_id: order.id,
  proxy_ip: proxy ? `${proxy.host}:${proxy.port}` : null,
  success: true,
  response_time: Date.now() - startTime,
  error_message: null
});
```

---

## 十、测试与验证

### 10.1 单元测试

```javascript
describe('crawlAppleOrder', () => {
  it('应该正确提取订单信息', async () => {
    const html = fs.readFileSync('./test/fixtures/order_page.html', 'utf-8');
    const result = await parseOrderPage(html);

    expect(result.orderNumber).toBe('W1316796973');
    expect(result.products).toHaveLength(2);
    expect(result.products[0].name).toContain('iPhone');
  });

  it('应该处理已取消的订单', async () => {
    const html = fs.readFileSync('./test/fixtures/cancelled_order.html', 'utf-8');
    const result = await parseOrderPage(html);

    expect(result.orderStatus).toBe('cancelled');
    expect(result.products[0].quantity).toBe(0);
  });
});
```

### 10.2 集成测试

```javascript
// 使用真实订单链接测试（需要有效的订单号）
const testUrl = 'https://www.apple.com.cn/xc/cn/vieworder/W1316796973/15123298843@8lvv.com';

async function testCrawler() {
  try {
    const result = await crawlAppleOrder(testUrl);
    console.log('✅ 爬取成功:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('❌ 爬取失败:', error.message);
  }
}
```

---

## 十一、数据提取能力清单

### 11.1 可提取的字段

| 字段分类 | 字段名 | 数据类型 | 示例值 | 用途 |
|---------|--------|---------|--------|------|
| **订单号（验证）** | `orderNumber` | String | `W1316796973` | 与邮件订单号对比验证 |
| **下单日期** | `orderPlacedDate` | Date | `2025-11-08` | 官方下单日期 |
| **订单状态** | `orderStatus` | String (枚举) | `PICK_UP_CANCELLED` | 实时订单状态 |
| **商品名称** | `productName` | String | `iPhone 17 Pro Max 1TB 星宇橙色` | 完整商品名称 |
| **商品数量** | `quantity` | Integer | `0`（已取消）/ `1` / `2` | 官网显示数量 |
| **商品状态** | `itemStatus` | String | `PICK_UP_CANCELLED` | 商品级别状态 |
| **配送方式** | `deliveryType` | String | `RETAIL_STORE` / `SHIPPED` | 店取或快递 |
| **商品图片** | `imageUrl` | String (URL) | `https://store.storeimages.cdn-apple.com/...` | 用于前端展示 |
| **取机门店** | `pickupStore` | String | `Apple 重庆万象城` | 店内取货地点 |
| **门店信息** | `hoursAndDirectionsURL` | String (URL) | `http://www.apple.com/cn/retail/...` | 门店营业时间与路线 |
| **预计送达** | `estimatedDelivery` | String | `取货已取消` / `2025年11月15日` | 送达时间 |

### 11.2 订单状态枚举值

| 状态值 | 含义 | 显示文本 |
|-------|------|---------|
| `PICK_UP_CANCELLED` | 取货已取消 | 取货已取消 |
| `READY_FOR_PICKUP` | 准备就绪可取货 | 准备就绪 |
| `PROCESSING` | 处理中 | 处理中 |
| `SHIPPED` | 已发货 | 已发货 |
| `DELIVERED` | 已送达 | 已送达 |

### 11.3 多商品订单支持

- ✅ 自动提取订单中的所有商品（主商品 + 配件）
- ✅ 每个商品独立包含名称、数量、状态、图片
- ✅ 支持混合状态（部分取消、部分完成）

### 11.4 数据可靠性

| 数据项 | 可靠性 | 说明 |
|-------|--------|------|
| 订单状态 | **权威** | **实时状态，可定时更新** |
| 商品列表 | 高 | 完整的商品清单（含配件） |
| 商品图片 | 高 | 高清商品图，用于前端展示 |
| 取机门店 | 高 | 准确的门店信息 |
| 商品数量 | ⚠️ | **已取消订单显示为 0，需以邮件数量为准** |
| Apple ID | ❌ | 官网无此信息，需从邮件获取 |
| 取机人信息 | ❌ | 官网无此信息，需从邮件获取 |
| 付款方式 | ❌ | 官网无此信息，需从邮件获取 |

### 11.5 与邮件数据的整合策略

| 字段 | 邮件 | 官网 | 最终使用 |
|------|------|------|----------|
| 订单号 | ✅ | ✅ | 两者验证一致性 |
| Apple ID | ✅ | ❌ | **邮件** |
| 下单时间 | ✅ | ✅ | **官网**（更准确）|
| 产品名称 | ✅ | ✅ | **官网**（更完整）|
| 产品数量 | ✅ | ✅ | **邮件**（权威，已取消订单官网显示0）|
| 订单状态 | ❌ | ✅ | **官网** |
| 取机门店 | ❌ | ✅ | **官网** |
| 取机人信息 | ✅ | ❌ | **邮件** |
| 付款方式 | ✅ | ✅ | **邮件**（更详细）|
| 商品图片 | ❌ | ✅ | **官网** |

### 11.6 特殊情况处理

#### 已取消订单
- **问题**: 官网 `quantity` 显示为 `0`
- **解决**: 使用邮件中的数量作为实际购买数量
- **验证**: 检查 `status` 是否包含 `CANCELLED`

#### 多商品订单
- **问题**: 邮件可能只显示主商品，官网会列出所有商品（含配件）
- **解决**: 以官网商品列表为准，用邮件数据补充型号和数量验证
- **匹配**: 优先通过型号匹配，其次模糊名称匹配

#### 订单号不一致
- **问题**: 极少数情况下邮件和官网订单号可能不匹配
- **解决**: 记录警告日志，标记为异常订单
- **处理**: 人工介入审核

---

**文档版本**: v2.0  
**更新时间**: 2026-07-06  
**变更说明**: 整合"数据提取能力汇总"内容，增加与邮件数据的整合策略
