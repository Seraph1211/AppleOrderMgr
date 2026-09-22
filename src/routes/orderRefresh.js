const express = require('express');

const retiredFeature = require('../middleware/retiredFeature');

const router = express.Router();

router.use(retiredFeature('官网订单刷新任务查询'));

module.exports = router;
