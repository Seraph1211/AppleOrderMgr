# 邮件解析方案

## 一、邮件来源

### 发件人
- **邮箱地址**: `noreply_12@lanu.cn` (可能有变体如 noreply_13, noreply_14 等)
- **发件人名称**: "心选邮件通知"（Base64 编码）

### 邮件主题
- **固定格式**: `NULL预订助手提交预订成功通知`
- **编码方式**: UTF-8 Base64

### 邮件格式
- **Content-Type**: `multipart/mixed` → `multipart/alternative` → `text/html`
- **字符编码**: UTF-8
- **内容编码**: Base64

---

## 二、邮件内容结构

### 完整邮件示例

```
亲爱的 ***tzvcantetc8k@hotmail.com：

恭喜您于2025/10/8 20:21:58在电脑iZa8bpucta640l0Z上预订iPhone手机成功，以下为成功预订信息：

MG0A4CH/A-iPhone 17 Pro Max 星宇橙色 1T x 2/李浩/603X/支付宝/-/指定信息/天津

点击此处查看订单详情或请查收联系人邮箱的邮件查看订单详情

请在相应的时间到相应的店铺领取您预订的产品!

感谢您使用 NULL AOS Helper，我们一直在努力，谢谢您的支持。

更多详情查看：
Apple官网：https://www.apple.com
预订助手QQ交流群：2848501
```

### HTML 结构

```html
<div style='font-size:12px;'>
  亲爱的&nbsp;&nbsp;***tzvcantetc8k@hotmail.com：<br><br>
  恭喜您于2025/10/8 20:21:58在电脑iZa8bpucta640l0Z上预订iPhone手机成功，以下为成功预订信息：<br /><br />
  <span style='font-weight:bold'>MG0A4CH/A-iPhone 17 Pro Max 星宇橙色 1T x 2/李浩/603X/支付宝/-/指定信息/天津</span><br /><br />
  <a href="https://www.apple.com.cn/xc/cn/vieworder/W177976887/18640948351@8lvv.com" target='_blank'>点击此处查看订单详情</a>或请查收联系人邮箱的邮件查看订单详情<br /><br />
  ...
</div>
```

---

## 三、字段提取规则

### 3.1 Apple ID

**提取位置**: 邮件开头 "亲爱的 ***xxx@xxx.com"

**正则表达式**:
```javascript
const appleIdRegex = /\*\*\*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
const match = emailText.match(appleIdRegex);
const appleId = match ? match[1] : null;
```

**示例提取**:
- 输入: `亲爱的 ***tzvcantetc8k@hotmail.com：`
- 输出: `tzvcantetc8k@hotmail.com`

---

### 3.2 预订时间

**提取位置**: "恭喜您于xxxx/xx/xx xx:xx:xx"

**正则表达式**:
```javascript
const dateRegex = /(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2})/;
const match = emailText.match(dateRegex);
const orderDate = match ? new Date(match[1].replace(/\//g, '-')) : null;
```

**示例提取**:
- 输入: `恭喜您于2025/10/8 20:21:58在电脑`
- 输出: `2025-10-08 20:21:58` (Date 对象)

---

### 3.3 订单链接和订单号

**提取位置**: HTML 中的 `<a href="...">` 标签

**正则表达式**:
```javascript
const linkRegex = /https:\/\/www\.apple\.com\.cn\/xc\/cn\/vieworder\/([^\/'"]+)\/[^\s'"]+/;
const match = emailText.match(linkRegex);
const orderUrl = match ? match[0] : null;
const orderNumber = match ? match[1] : null;
```

**示例提取**:
- 输入: `https://www.apple.com.cn/xc/cn/vieworder/W177976887/18640948351@8lvv.com`
- 输出:
  - `orderUrl`: 完整链接
  - `orderNumber`: `W177976887`

---

### 3.4 产品信息（核心字段）

#### 字段格式说明

**单商品格式**:
```
型号标识-产品详情 x 数量/取机人姓名/身份证后四位/付款方式/未知字段1/未知字段2/取机人标签
```

**多商品格式** (用 @ 分隔):
```
型号1-产品1 x 数量1@型号2-产品2 x 数量2/取机人姓名/身份证后四位/付款方式/未知字段1/未知字段2/取机人标签
```

#### 示例

**单商品**:
```
MG0A4CH/A-iPhone 17 Pro Max 星宇橙色 1T x 2/李浩/603X/支付宝/-/指定信息/天津
```

**多商品**:
```
MG714CH/A-iPhone 17 鼠尾草绿色 256G x 2@HNPW2ZM/A-Belkin Secure Holder 挂绳 (适用于 AirTag) - 白色(98元) x 1/冉念/5904/支付宝/-/指定信息/水果惠
```

---

### 3.5 解析步骤

#### 步骤 1: 提取完整的产品信息字符串

```javascript
// 匹配整个产品信息行（从型号开始到最后一个中文字符）
const fullInfoRegex = /([A-Z0-9\/]+-[^\/\n]+)\/([^\/]+)\/([^\/]+)\/([^\/]+)\/[^\/]+\/[^\/]+\/(.+)/;
const match = emailText.match(fullInfoRegex);

if (!match) {
  throw new Error('无法解析产品信息');
}

const productsSection = match[1];  // 商品部分
const recipientName = match[2].trim();
const recipientIdLast4 = match[3].trim();
const paymentMethod = match[4].trim();
const recipientTag = match[5].trim();
```

#### 步骤 2: 按 @ 分割多个商品

```javascript
const productItems = productsSection.split('@');

// productItems[0] = "MG714CH/A-iPhone 17 鼠尾草绿色 256G x 2"
// productItems[1] = "HNPW2ZM/A-Belkin Secure Holder 挂绳 (适用于 AirTag) - 白色(98元) x 1"
```

#### 步骤 3: 解析每个商品

```javascript
const products = [];

productItems.forEach(item => {
  const productRegex = /([A-Z0-9\/]+)\s*-\s*(.+?)\s+x\s+(\d+)$/;
  const match = item.trim().match(productRegex);
  
  if (match) {
    products.push({
      modelId: match[1].trim(),        // "MG714CH/A"
      name: match[2].trim(),           // "iPhone 17 鼠尾草绿色 256G"
      quantity: parseInt(match[3])     // 2
    });
  }
});
```

---

## 四、完整解析函数

```javascript
const mailparser = require('mailparser').simpleParser;

async function parseOrderEmail(rawEmail) {
  // 1. 解析邮件
  const parsed = await mailparser(rawEmail);
  const textBody = parsed.text || '';
  const htmlBody = parsed.html || '';

  // 2. 提取 Apple ID
  const appleIdMatch = textBody.match(/\*\*\*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const appleId = appleIdMatch ? appleIdMatch[1] : null;

  // 3. 提取预订时间
  const dateMatch = textBody.match(/(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2})/);
  const orderDate = dateMatch ? new Date(dateMatch[1].replace(/\//g, '-')) : null;

  // 4. 提取订单链接和订单号
  const linkMatch = htmlBody.match(/href=['"](https:\/\/www\.apple\.com\.cn\/xc\/cn\/vieworder\/([^\/'"]+)\/[^'"]+)['"]/);
  const orderUrl = linkMatch ? linkMatch[1] : null;
  const orderNumber = linkMatch ? linkMatch[2] : null;

  // 5. 提取产品信息（支持多商品）
  const fullInfoMatch = textBody.match(/([A-Z0-9\/]+-[^\/\n]+)\/([^\/]+)\/([^\/]+)\/([^\/]+)\/[^\/]+\/[^\/]+\/(.+)/);
  
  if (!fullInfoMatch) {
    throw new Error('无法解析产品信息');
  }

  const productsSection = fullInfoMatch[1];
  const recipientName = fullInfoMatch[2].trim();
  const recipientIdLast4 = fullInfoMatch[3].trim();
  const paymentMethod = fullInfoMatch[4].trim();
  const recipientTag = fullInfoMatch[5].trim();

  // 6. 解析多个商品（按 @ 分割）
  const products = [];
  const productItems = productsSection.split('@');

  productItems.forEach(item => {
    const productMatch = item.trim().match(/([A-Z0-9\/]+)\s*-\s*(.+?)\s+x\s+(\d+)$/);
    if (productMatch) {
      products.push({
        modelId: productMatch[1].trim(),
        name: productMatch[2].trim(),
        quantity: parseInt(productMatch[3])
      });
    }
  });

  return {
    appleId,
    orderNumber,
    orderUrl,
    orderDate,
    products,
    recipient: {
      name: recipientName,
      idLast4: recipientIdLast4,
      tag: recipientTag
    },
    paymentMethod,
    emailRaw: rawEmail
  };
}

module.exports = { parseOrderEmail };
```

---

## 五、解析结果示例

### 输入（邮件内容）

```
亲爱的 ***tzvcantetc8k@hotmail.com：

恭喜您于2025/10/8 20:21:58在电脑iZa8bpucta640l0Z上预订iPhone手机成功，以下为成功预订信息：

MG714CH/A-iPhone 17 鼠尾草绿色 256G x 2@HNPW2ZM/A-Belkin Secure Holder 挂绳 (适用于 AirTag) - 白色(98元) x 1/冉念/5904/支付宝/-/指定信息/水果惠

点击此处查看订单详情
```

### 输出（JSON）

```json
{
  "appleId": "tzvcantetc8k@hotmail.com",
  "orderNumber": "W177976887",
  "orderUrl": "https://www.apple.com.cn/xc/cn/vieworder/W177976887/18640948351@8lvv.com",
  "orderDate": "2025-10-08T12:21:58.000Z",
  "products": [
    {
      "modelId": "MG714CH/A",
      "name": "iPhone 17 鼠尾草绿色 256G",
      "quantity": 2
    },
    {
      "modelId": "HNPW2ZM/A",
      "name": "Belkin Secure Holder 挂绳 (适用于 AirTag) - 白色(98元)",
      "quantity": 1
    }
  ],
  "recipient": {
    "name": "冉念",
    "idLast4": "5904",
    "tag": "水果惠"
  },
  "paymentMethod": "支付宝",
  "emailRaw": "..."
}
```

---

## 六、异常处理

### 6.1 邮件格式异常

```javascript
try {
  const orderData = await parseOrderEmail(rawEmail);
} catch (error) {
  console.error('邮件解析失败:', error.message);
  // 记录错误日志
  await EmailLog.create({
    email_uid: emailUid,
    processed: false,
    error_message: error.message
  });
}
```

### 6.2 字段缺失处理

```javascript
// 必填字段
if (!appleId || !orderNumber || !orderUrl || products.length === 0) {
  throw new Error('缺少必要字段');
}

// 可选字段默认值
const recipient = {
  name: recipientName || 'Unknown',
  idLast4: recipientIdLast4 || '',
  tag: recipientTag || ''
};
```

### 6.3 数量验证

```javascript
products.forEach(product => {
  if (product.quantity <= 0 || product.quantity > 10) {
    console.warn(`商品数量异常: ${product.name}, 数量: ${product.quantity}`);
  }
});
```

---

## 七、测试用例

### 测试用例 1: 单商品订单

```javascript
const testEmail1 = `
亲爱的 ***test@hotmail.com：
恭喜您于2025/10/8 20:21:58在电脑xxx上预订iPhone手机成功，以下为成功预订信息：
MG0A4CH/A-iPhone 17 Pro Max 星宇橙色 1T x 2/李浩/603X/支付宝/-/指定信息/天津
`;

// 期望输出
{
  products: [
    { modelId: "MG0A4CH/A", name: "iPhone 17 Pro Max 星宇橙色 1T", quantity: 2 }
  ]
}
```

### 测试用例 2: 多商品订单

```javascript
const testEmail2 = `
MG714CH/A-iPhone 17 鼠尾草绿色 256G x 2@HNPW2ZM/A-Belkin Secure Holder 挂绳 (适用于 AirTag) - 白色(98元) x 1/冉念/5904/支付宝/-/指定信息/水果惠
`;

// 期望输出
{
  products: [
    { modelId: "MG714CH/A", name: "iPhone 17 鼠尾草绿色 256G", quantity: 2 },
    { modelId: "HNPW2ZM/A", name: "Belkin Secure Holder 挂绳 (适用于 AirTag) - 白色(98元)", quantity: 1 }
  ],
  recipient: { name: "冉念", idLast4: "5904", tag: "水果惠" }
}
```

---

## 八、数据提取能力清单

### 8.1 可提取的字段

| 字段分类 | 字段名 | 数据类型 | 示例值 | 用途 |
|---------|--------|---------|--------|------|
| **Apple ID** | `appleId` | String | `tzvcantetc8k@hotmail.com` | 关联订单到账号 |
| **时间信息** | `orderDate` | DateTime | `2025-10-08 20:21:58` | 订单创建时间 |
| **订单标识** | `orderNumber` | String | `W177976887` | 订单唯一标识 |
| **订单链接** | `orderUrl` | String (URL) | `https://www.apple.com.cn/...` | 用于爬取详情 |
| **产品型号** | `productModelId` | String | `MG0A4CH/A` | 产品型号标识 |
| **产品名称** | `productName` | String | `iPhone 17 Pro Max` | 产品名称 |
| **产品颜色** | `productColor` | String | `星宇橙色` | 产品颜色 |
| **产品容量** | `productCapacity` | String | `1T` | 存储容量 |
| **产品数量** | `quantity` | Integer | `2` | 购买数量 |
| **取机人姓名** | `recipientName` | String | `李浩` | 取机人姓名 |
| **身份证后四位** | `recipientIdLast4` | String (4位) | `603X` | 身份验证 |
| **付款方式** | `paymentMethod` | String | `支付宝` / `微信` / `信用卡` | 支付方式 |
| **取机人标签** | `recipientTag` | String | `天津` | 地区/批次标识 |

### 8.2 多商品订单支持

- ✅ 支持一个订单包含多个商品
- ✅ 使用 `@` 符号分隔不同商品
- ✅ 每个商品独立包含型号、名称、数量
- ✅ 取机人信息位于最后一个商品之后

**格式示例**:
```
商品1型号-商品1详情 x 数量1@商品2型号-商品2详情 x 数量2/取机人信息
```

### 8.3 数据可靠性

| 数据项 | 可靠性 | 说明 |
|-------|--------|------|
| Apple ID | 高 | 固定格式，易于提取 |
| 订单号 | 高 | W + 9位数字，格式固定 |
| 订单时间 | 高 | 格式固定，易于解析 |
| 产品数量 | **权威** | **邮件中的数量是实际购买数量（即使订单已取消）** |
| 取机人信息 | 高 | 官网无此信息，邮件独有 |
| 订单状态 | ❌ | 邮件中无，需从官网获取 |
| 取机门店 | ❌ | 邮件中无，需从官网获取 |

---

**文档版本**: v2.0  
**更新时间**: 2026-07-06  
**变更说明**: 整合"多商品订单解析逻辑"和"数据提取能力汇总"内容
