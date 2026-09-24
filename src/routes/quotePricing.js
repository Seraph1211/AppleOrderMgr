const express = require('express');
const { requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');
const quotePricingService = require('../services/quotePricingService');

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

module.exports = router;
