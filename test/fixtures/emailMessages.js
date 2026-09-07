function buildHtmlBody({ products, recipient, tag, orderNumber, appleId, time = '20:21:58' }) {
  return `<div>
亲爱的&nbsp;&nbsp;***${appleId}：<br><br>
恭喜您于2025/10/8 ${time}预订成功，以下为成功预订信息：<br><br>
<span>${products}/${recipient}/603X/支付宝/-/指定信息/${tag}</span><br><br>
<a href="https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/${appleId}">点击此处查看订单详情</a><br>
请在相应的时间到相应的店铺领取您预订的产品。
</div>`;
}

function buildMime({ body, contentType = 'text/html', transferEncoding, encode = false }) {
  const headers = [
    'From: 心选邮件通知 <orders@example.com>',
    'Subject: NULL预订助手提交预订成功通知',
    'Date: Wed, 8 Oct 2025 20:21:58 +0800',
    'Message-ID: <fixture@example.com>',
    `Content-Type: ${contentType}; charset=UTF-8`,
  ];
  if (transferEncoding) headers.push(`Content-Transfer-Encoding: ${transferEncoding}`);
  return `${headers.join('\n')}\n\n${encode ? Buffer.from(body).toString('base64') : body}`;
}

const singleHtml = buildMime({
  body: buildHtmlBody({
    appleId: 'test@hotmail.com',
    orderNumber: 'W1234567890',
    products: 'MG0A4CH/A-iPhone 17 Pro Max 星宇橙色 1T x 2',
    recipient: '李浩',
    tag: '天津',
  }),
});

const multipleHtml = buildMime({
  body: buildHtmlBody({
    appleId: 'tzvcantetc8k@hotmail.com',
    orderNumber: 'W1779768870',
    products:
      'MG714CH/A-iPhone 17 鼠尾草绿色 256G x 2@HNPW2ZM/A-Belkin Secure Holder 挂绳 (适用于 AirTag) - 白色(98元) x 1',
    recipient: '冉念',
    tag: '水果惠',
    time: '20:30:00',
  }),
});

const plainText = buildMime({
  contentType: 'text/plain',
  body: `亲爱的 ***plain@example.com：
恭喜您于2025/10/8 09:01:02预订成功
MY/123-iPhone 测试款 / 256G x 1/张三/123X/支付宝/-/指定信息/北京
https://www.apple.com.cn/xc/cn/vieworder/W1111111111/plain@example.com`,
});

const base64Html = buildMime({
  body: buildHtmlBody({
    appleId: 'base64@example.com',
    orderNumber: 'W2222222222',
    products: 'AB123CH/A-iPhone &amp; 配件 x 1',
    recipient: '王五',
    tag: '上海',
  }),
  transferEncoding: 'base64',
  encode: true,
});

module.exports = { buildHtmlBody, buildMime, singleHtml, multipleHtml, plainText, base64Html };
