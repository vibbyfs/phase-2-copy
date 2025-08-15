const express = require('express');
const router = express.Router();
const ReminderController = require('../controllers/reminderController');

router.get('/actives', ReminderController.getAllReminders);
router.put('/cancel/:id', ReminderController.cancelReminderById);
router.delete('/delete/:id', ReminderController.deleteReminderById);

module.exports = router;
