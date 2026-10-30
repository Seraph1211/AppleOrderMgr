const express = require('express');
const { rateLimit } = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const quotePricingService = require('../services/quotePricingService');
const duoQuoteService = require('../services/duoQuoteService');
const duoQuoteHistoryService = require('../services/duoQuoteHistoryService');
const { subscribeDuoQuoteEvents } = require('../services/duoQuoteEvents');

const router = express.Router();

router.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: '访问过于频繁，请稍后再试' },
    },
  })
);

const getPublicQuotes = asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await quotePricingService.getPublicQuotes() });
});

router.get('/apple-quotes', getPublicQuotes);
router.get('/iphone18-quotes', getPublicQuotes);
router.get('/duo-quotes/events', asyncHandler(subscribeDuoQuoteEvents));
router.get(
  '/duo-quotes/history',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: await duoQuoteHistoryService.getPublicDuoQuoteHistory(req.query),
    });
  })
);
router.get(
  '/duo-quotes',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await duoQuoteService.getPublicDuoQuotes() });
  })
);

module.exports = router;
