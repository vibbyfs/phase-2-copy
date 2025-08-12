const axios = require('axios');

async function sendReminder(to, text, reminderId) {
  const url = process.env.N8N_OUTBOUND_WEBHOOK;
  if (!url) throw new Error('N8N_OUTBOUND_WEBHOOK is not set');
  return axios.post(url, { to, text, reminderId });
}

module.exports = { sendReminder };
