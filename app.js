if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const app = express();
const cors = require('cors');

const { loadAllScheduledReminders } = require('./services/scheduler');
const authentication = require('./middleware/authentication');
const errorHandler = require('./middleware/errorHandler');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', authentication, require('./routes/users.routes'));
app.use('/api/reminders', authentication, require('./routes/reminders.routes'));
app.use('/api/friends', authentication, require('./routes/friends.routes'));
app.use('/api/wa', require('./routes/wa.routes'));

if (process.env.SCHEDULER_ENABLED !== 'false') {
  loadAllScheduledReminders()
    .then(() => console.log('[SCHED] loaded at startup'))
    .catch((err) => console.error('Scheduler init error', err));
}

app.use(errorHandler);

module.exports = app;
