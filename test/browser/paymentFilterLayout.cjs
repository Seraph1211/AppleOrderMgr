/* eslint-env node, browser */
const assert = require('node:assert/strict');

/** 用合成页面检查两张付款页的紧凑筛选布局，不提交筛选或访问业务接口。 */
async function checkPaymentFilterLayout(page, width, screenshotPath) {
  const fields = page.locator('.payment-filter-fields');
  const opened = !(await fields.isVisible());
  if (opened) await page.getByRole('button', { name: '筛选任务', exact: true }).click();
  assert.deepEqual(
    await page.getByLabel('处理状态筛选', { exact: true }).locator('option').allTextContents(),
    ['全部处理状态', '待处理', '处理中', '已完成', '异常']
  );
  if (width >= 640) {
    // 标准 input 有尺寸过渡，先等待手机到桌面的断点切换完成。
    await page.waitForFunction(
      () =>
        document.querySelector('.payment-filter-fields > input').getBoundingClientRect().width <=
        200
    );
  }
  const boxes = await fields.locator(':scope > *').evaluateAll(elements =>
    elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: Math.round(rect.top), width: rect.width };
    })
  );
  assert(
    boxes.every(box => box.left >= 0 && box.right <= width),
    `筛选区溢出 ${width}`
  );
  if (width >= 1920) {
    assert.equal(new Set(boxes.map(box => box.top)).size, 1, '宽屏基础筛选应在同一行');
  }
  if (width >= 640) {
    assert(boxes[0].width <= 200, '订单号不应等分拉伸');
    assert(boxes[1].width <= 400, '商品筛选应控制宽度');
  }
  const product = page.getByLabel('商品信息筛选', { exact: true });
  await product.click();
  const option = page.getByRole('option', {
    name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色',
    exact: true,
  });
  assert(
    await option
      .locator('span')
      .last()
      .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
    `完整商品选项不应截断 ${width}`
  );
  const wasSelected = (await option.getAttribute('aria-selected')) === 'true';
  if (!wasSelected) await option.click();
  assert(
    await product
      .locator('span')
      .evaluate(element => element.scrollWidth <= element.clientWidth + 1),
    `已选商品不应截断 ${width}`
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  if (!wasSelected) await option.click();
  await product.click();
  if (opened) await page.getByRole('button', { name: '收起筛选', exact: true }).click();
}

/** 验证处理筛选提交精确值，重置恢复全部而非未完成范围。 */
async function checkProcessingFilterSubmission(page, getQuery) {
  for (const processingStatus of ['pending', 'processing', 'completed', 'exception', '']) {
    if (!(await page.locator('.payment-filter-fields').isVisible())) {
      await page.getByRole('button', { name: '筛选任务', exact: true }).click();
    }
    await page.getByLabel('处理状态筛选', { exact: true }).selectOption(processingStatus);
    const response = page.waitForResponse(res =>
      /\/api\/(payment-tasks|payment-dispatch\/tasks)\?/.test(res.url())
    );
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await response;
    assert.equal(getQuery().processingStatus || '', processingStatus);
  }
  if (!(await page.locator('.payment-filter-fields').isVisible())) {
    await page.getByRole('button', { name: '筛选任务', exact: true }).click();
  }
  await page.getByLabel('处理状态筛选', { exact: true }).selectOption('completed');
  const response = page.waitForResponse(res =>
    /\/api\/(payment-tasks|payment-dispatch\/tasks)\?/.test(res.url())
  );
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await response;
  assert.equal(getQuery().processingStatus || '', '');
  assert.equal(await page.getByLabel('处理状态筛选', { exact: true }).inputValue(), '');
}

module.exports = { checkPaymentFilterLayout, checkProcessingFilterSubmission };
