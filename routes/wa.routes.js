const express = require('express');
const router = express.Router();
const WaController = require('../controllers/waController');

router.post('/inbound', WaController.inbound);

module.exports = router;
