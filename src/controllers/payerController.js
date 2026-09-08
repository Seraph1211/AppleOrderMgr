const payerService = require('../services/payerService');

/** 更新订单的外部付款人姓名。 */
async function assignOrderPayer(req, res) {
  const data = await payerService.assignOrderPayer(
    Number(req.params.id),
    { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey },
    req.user.id
  );
  return res.json({ success: true, data });
}

module.exports = { assignOrderPayer };
