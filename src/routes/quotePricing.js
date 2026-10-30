const express = require('express');
const { requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');
const quotePricingService = require('../services/quotePricingService');
const duoQuotePricingService = require('../services/duoQuotePricingService');

const router = express.Router();

router.use(requireRole(['admin']));
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get(
  '/iphone18',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await quotePricingService.getAdminQuotes() });
  })
);
router.put(
  '/iphone18/availability',
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: await quotePricingService.setAvailability(req.user.id, req.body),
    });
  })
);
router.put(
  '/iphone18/display-order',
  asyncHandler(async (req, res) => {
    const data = await quotePricingService.saveDisplayOrder(req.user, req.body);
    req.auditTarget = `公开报价展示顺序；商品 ${data.itemCount} 款`;
    res.json({ success: true, data });
  })
);
router.put(
  '/iphone18/adjustments',
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: await quotePricingService.saveAdjustments(req.user, req.body),
    });
  })
);
router.post(
  '/iphone18/adjustments/reset',
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: await quotePricingService.resetAdjustments(req.user, req.body),
    });
  })
);
router.get(
  '/iphone18/versions',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await quotePricingService.listVersions(req.query) });
  })
);
router.post(
  '/iphone18/versions/:id/restore',
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: await quotePricingService.restoreVersion(req.user, req.params.id, req.body),
    });
  })
);

router.get(
  '/duo',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await duoQuotePricingService.getAdminQuotes() });
  })
);
router.post(
  '/duo/preview',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await duoQuotePricingService.preview(req.body) });
  })
);
router.put(
  '/duo/adjustments',
  asyncHandler(async (req, res) => {
    const data = await duoQuotePricingService.saveAdjustments(req.user, req.body);
    req.auditTarget = `Duo报价加价；商品 ${data.selectedCount} 款`;
    res.json({ success: true, data });
  })
);
router.post(
  '/duo/adjustments/reset',
  asyncHandler(async (req, res) => {
    const data = await duoQuotePricingService.resetAdjustments(req.user, req.body);
    req.auditTarget = `Duo报价重置；商品 ${data.selectedCount} 款`;
    res.json({ success: true, data });
  })
);
router.get(
  '/duo/versions',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await duoQuotePricingService.listVersions(req.query) });
  })
);
router.post(
  '/duo/versions/:id/restore',
  asyncHandler(async (req, res) => {
    const data = await duoQuotePricingService.restoreVersion(req.user, req.params.id, req.body);
    req.auditTarget = `Duo报价恢复；商品 ${data.selectedCount} 款`;
    res.json({ success: true, data });
  })
);

module.exports = router;
