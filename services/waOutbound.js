// services/waOutbound.js (CommonJS, Twilio)
'use strict';

const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM, // contoh: "whatsapp:+14155238886"
} = process.env;

let client = null;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.warn('[WAOutbound] Missing Twilio credentials. Set TWILIO_ACCOUNT_SID & TWILIO_AUTH_TOKEN.');
} else {
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

function toWa(num) {
  if (!num) return num;
  return num.startsWith('whatsapp:') ? num : `whatsapp:${num}`;
}

function fromWa() {
  const v = TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // fallback sandbox
  return v.startsWith('whatsapp:') ? v : `whatsapp:${v}`;
}

/**
 * Kirim pesan WA. Kompatibel dengan pemanggilan lama:
 *   sendReminder(to, body, reminderId)
 * Return object mirip log lama.
 */
async function sendReminder(to, body, reminderId = null, mediaUrl = null) {
  if (!client) throw new Error('Twilio client not configured.');

  const payload = {
    from: fromWa(),
    to: toWa(to),
    body: body || '',
  };
  if (mediaUrl) payload.mediaUrl = mediaUrl; // string atau array string

  const res = await client.messages.create(payload);

  const result = {
    sid: res.sid,
    to: res.to,
    from: res.from,
    reminderId,
    status: res.status,
  };

  console.log('[TWILIO] Message sent successfully:', result);
  return result;
}

/** Alias sederhana */
async function sendMessage(to, text, mediaUrl = null) {
  return sendReminder(to, text, null, mediaUrl);
}

module.exports = { sendReminder, sendMessage };
