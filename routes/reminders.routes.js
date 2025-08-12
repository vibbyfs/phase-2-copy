const express = require('express');
const router = express.Router();
const ReminderController = require('../controllers/reminderController');

// Simplified routes - hanya yang diperlukan untuk fitur core
router.get('/active', ReminderController.getActiveReminders);
router.delete('/recurring/cancel', ReminderController.cancelRecurringReminders);
router.delete('/all/cancel', ReminderController.cancelAllReminders);
router.post('/cancel-by-keyword', ReminderController.cancelRemindersByKeyword);

module.exports = router;
