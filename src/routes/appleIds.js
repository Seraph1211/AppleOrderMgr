/**
 * Apple ID 路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const controller = require('../controllers/appleIdController');

const router = express.Router();

router.get('/', asyncHandler(controller.listAppleIds));
router.get('/:id', asyncHandler(controller.getAppleIdDetail));
router.post('/', asyncHandler(controller.createAppleId));
router.put('/:id', asyncHandler(controller.updateAppleId));
router.delete('/:id', asyncHandler(controller.deleteAppleId));

module.exports = router;
