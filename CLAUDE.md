# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Apple Order Management System - Automates email monitoring and order synchronization for Apple product orders placed through NULL AOS Helper (third-party booking service).

**Core workflow**: Email arrives → Parse order info → Store in PostgreSQL → Crawl Apple website for details → Update order status periodically

## Architecture

### Three-Layer System

1. **Email Layer** (`services/emailParser.js`)
   - IMAP IDLE for real-time monitoring (<10s response)
   - Parses NULL AOS Helper emails (Base64 encoded)
   - Extracts: Apple ID, order number, products, recipient info, payment method
   - **Multi-product support**: Products separated by `@` symbol

2. **Crawler Layer** (`crawler/order_parser.js`)
   - Crawls Apple order pages using axios + cheerio
   - Extracts JSON from `<script>` tags (no JavaScript execution needed)
   - **Anti-scraping**: Proxy pool + 5-10s request delay required
   - Gets: order status, product images, pickup store, delivery info

3. **API Layer** (planned in `src/`)
   - Express.js RESTful API
   - PostgreSQL via Sequelize ORM
   - Manages: Apple IDs, recipients, orders

### Data Flow

```
邮件到达 → emailParser (extracts fields) → Database (initial insert)
   ↓
Trigger crawler → order_parser (enriches data) → Database (update)
   ↓
定时任务 → Re-crawl for status updates → Database (sync)
```

## Key Design Decisions

### Multi-Product Order Format

**Email format**:
```
型号1-产品1 x 数量1@型号2-产品2 x 数量2/取机人/身份证后四位/付款方式/-/-/标签
```

Example:
```
MG714CH/A-iPhone 17 鼠尾草绿色 256G x 2@HNPW2ZM/A-Belkin挂绳 x 1/冉念/5904/支付宝/-/-/水果惠
```

**Parsing rule**: Split by `@` for products; recipient info comes after last product.

### Data Authority

| Field | Source | Authority | Reason |
|-------|--------|-----------|--------|
| Product Quantity | Email | **Authoritative** | Apple website shows 0 for cancelled orders |
| Order Status | Website | **Authoritative** | Real-time status |
| Apple ID | Email | Only source | Not on website |
| Recipient Info | Email | Only source | Not on website |
| Product Images | Website | Only source | Not in email |

### Anti-Scraping Strategy

- **IP rotation**: Use proxy pool (快代理 recommended, ¥50-200/month)
- **Request delay**: 5-10 seconds between requests
- **Threshold**: <10 requests/minute per IP
- **Error handling**: HTTP 541 = wind control triggered → switch proxy

## Development Commands

```bash
# Install dependencies
npm install

# Development (with auto-reload)
npm run dev

# Production
npm start

# Test email parser
node test_parser.js

# Test crawler
node test_crawler.js
```

## Database Schema

**⚠️ AUTHORITY: `docs/DATABASE_SCHEMA.md` is the official database design specification**

All database-related development must follow `docs/DATABASE_SCHEMA.md`:
- Sequelize model definitions
- Migration files
- Table structure queries
- Index optimization

5 core tables:
- `apple_ids`: Apple account management
- `recipients`: Pickup person management  
- `orders`: Main order table (JSONB for products array)
- `email_logs`: Email processing history
- `crawl_logs`: Crawler execution logs

**JSONB storage**: Products stored as JSON array to support variable number of items per order.

**Quick reference**: See `docs/DATABASE_SCHEMA.md` for complete table definitions, field types, indexes, relationships, and query examples.

## Critical Implementation Notes

### Email Parsing (`services/emailParser.js`)

- Email content is **Base64 encoded UTF-8**
- Must handle HTML entities (`&nbsp;`, `<br />`)
- Order link format: `https://www.apple.com.cn/xc/cn/vieworder/{W订单号}/{邮箱}`
- Multi-product: Use regex with `@` split, extract recipient from last segment

### Order Crawling (`crawler/order_parser.js`)

- **No Puppeteer needed**: Data is in HTML `<script>` tags, not dynamically rendered
- **JSON extraction**: Find script containing `orderItem-` keyword
- **Control character handling**: Strip `\x00-\x1F\x7F` before JSON.parse
- **Product iteration**: Loop through `orderItems.c[]` array, then access each `orderItem-XXXXXXX` key
- **Fallback**: If JSON extraction fails, parse HTML directly for key fields

### Proxy Configuration

Set environment variables:
```bash
PROXY_API_URL=https://api.kdlapi.com/...
PROXY_API_KEY=your_key_here
```

Implement rotation in crawler service, not at request level.

## Documentation

Comprehensive technical docs in `docs/`:
- `01-项目概述.md`: System architecture
- `02-邮件解析方案.md`: Email parsing + data extraction capabilities (13 fields)
- `03-订单爬虫方案.md`: Crawler strategy + data integration (11 fields)
- `04-数据库设计方案.md`: Schema design (legacy, superseded by DATABASE_SCHEMA.md)
- `05-API接口设计方案.md`: RESTful endpoints
- **`DATABASE_SCHEMA.md`**: ✅ **Official database design specification** (all models must follow this)
- `06-CODING_STANDARDS.md`: Coding standards and best practices
- `DEVELOPMENT_PROGRESS.md`: Development progress tracking

**Read these before coding** - they contain detailed regex patterns, error handling strategies, and test cases.

## Development Phases (from docs)

1. **Phase 1** (2 weeks): Email monitoring + parser + crawler + basic API
2. **Phase 2** (1 week): Frontend (React + Ant Design)
3. **Phase 3** (1 week): Deployment (Docker + PM2 + Nginx)

Current status: **Phase 0 - Documentation complete, ready for implementation**

## Development Progress Tracking

**MANDATORY**: After completing each development stage, update the progress document (`docs/DEVELOPMENT_PROGRESS.md`) with:

- **Current Phase & Stage**: What phase/stage was just completed
- **Completed Features**: Detailed list of implemented features/modules
- **Key Implementation Notes**: Important technical decisions, workarounds, or gotchas
- **Next Steps**: What needs to be done next
- **Blockers/Issues**: Any unresolved problems or dependencies

This document serves as the single source of truth for development progress and helps maintain continuity across development sessions.

## Environment Setup

Required services:
- PostgreSQL 14+ (local or cloud)
- Proxy service API (for production crawling)
- Email account with IMAP access (QQ/163/Gmail)

Environment variables needed:
- `DATABASE_URL`: PostgreSQL connection string
- `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`: Email monitoring
- `PROXY_API_URL`, `PROXY_API_KEY`: Proxy pool
- `PORT`: API server port (default 3000)

---

## ⚠️ CODING STANDARDS - MANDATORY

**ALL CODE MUST FOLLOW THE CODING STANDARDS DEFINED IN `docs/06-CODING_STANDARDS.md`**

This is a **BLOCKING REQUIREMENT**. Any code that violates these standards will be rejected.

### Critical Rules (Must Follow)

1. **Naming Conventions**
   - Variables/Functions: `camelCase` (e.g., `parseEmail`, `orderNumber`)
   - Classes/Models: `PascalCase` (e.g., `EmailParser`, `Order`)
   - Constants: `UPPER_SNAKE_CASE` (e.g., `MAX_RETRY`, `REQUEST_DELAY`)
   - Files: `camelCase` or `kebab-case` (NEW files use `camelCase`, legacy `order_parser.js` is exception)

2. **Error Handling**
   - ALL async functions MUST have try-catch
   - Log errors with context: `logger.error('message', { orderNumber, error })`
   - Use structured logging (Winston), NEVER use `console.log`

3. **Database Operations**
   - Use transactions for multi-table operations
   - Avoid N+1 queries (use `include` for eager loading)
   - Validate all external inputs before database operations

4. **Crawler Anti-Scraping**
   - MUST have 5-10 second delay between requests
   - MUST use proxy pool rotation
   - Handle HTTP 541 errors (wind control) with proxy switching
   - Include retry logic with max 3 attempts

5. **Code Quality**
   - Run `npm run lint` before committing
   - Run `npm run format` to auto-fix formatting
   - Write unit tests for core business logic (>70% coverage target)
   - Add JSDoc comments to all exported functions

### Quick Check Before Writing Code

When implementing ANY feature, verify:
- [ ] Read `docs/06-CODING_STANDARDS.md` for detailed rules
- [ ] Understand the specific coding patterns for this project
- [ ] Use `logger` instead of `console.log`
- [ ] Add error handling with try-catch
- [ ] Use transactions for database operations
- [ ] Follow naming conventions (camelCase for variables/functions)
- [ ] Add JSDoc comments to exported functions
- [ ] Write unit tests for business logic

### Example: Correct Code Pattern

```javascript
const logger = require('../utils/logger');
const { Order, AppleId, sequelize } = require('../models');

/**
 * 保存订单及关联数据
 * @param {Object} orderData - 订单数据对象
 * @returns {Promise<Object>} 创建的订单对象
 * @throws {Error} 当数据验证失败或数据库操作失败时
 */
async function saveOrderWithRelations(orderData) {
  const transaction = await sequelize.transaction();
  
  try {
    // 验证输入
    if (!orderData.orderNumber || !/^W\d{9}$/.test(orderData.orderNumber)) {
      throw new Error('订单号格式无效');
    }
    
    // 创建关联数据
    const [appleId] = await AppleId.findOrCreate({
      where: { email: orderData.appleId },
      defaults: { email: orderData.appleId },
      transaction
    });
    
    // 创建订单
    const order = await Order.create({
      orderNumber: orderData.orderNumber,
      appleIdId: appleId.id,
      products: orderData.products,
      status: 'pending'
    }, { transaction });
    
    await transaction.commit();
    
    logger.info('订单保存成功', { 
      orderNumber: order.orderNumber,
      productCount: order.products.length 
    });
    
    return order;
    
  } catch (error) {
    await transaction.rollback();
    logger.error('订单保存失败', {
      orderNumber: orderData.orderNumber,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

module.exports = { saveOrderWithRelations };
```

### Violation Examples (DO NOT DO THIS)

```javascript
// ❌ WRONG: No error handling, console.log, snake_case naming
function save_order(order_data) {
  console.log('saving order');
  const order = Order.create(order_data);  // No await, no try-catch
  return order;
}

// ❌ WRONG: No transaction, no validation, poor logging
async function saveOrder(data) {
  const order = await Order.create(data);
  console.log('done');
  return order;
}
```

### Before Committing Code

Run these commands to ensure code quality:

```bash
# Check coding standards
npm run lint

# Auto-fix formatting issues
npm run lint:fix
npm run format

# Run tests
npm test

# All checks must pass before git commit
```

**Remember**: The coding standards document (`docs/06-CODING_STANDARDS.md`) is the source of truth. When in doubt, refer to it!
