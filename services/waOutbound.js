// services/waOutbound.js (CommonJS, Twilio)
'use strict';

const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID = '',
  TWILIO_AUTH_TOKEN = '',
  TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886', // default sandbox
} = process.env;

let client = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (e) {
    console.error('[WAOutbound] Gagal init Twilio:', e);
  }
} else {
  console.warn('[WAOutbound] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN belum diset.');
}

function normalizeWhatsApp(num) {
  if (!num) return num;
  return num.startsWith('whatsapp:') ? num : `whatsapp:${num}`;
}

async function sendReminder(to, body, reminderId = null, mediaUrl = null) {
  if (!client) throw new Error('Twilio not configured');

  const payload = {
    from: TWILIO_WHATSAPP_FROM.startsWith('whatsapp:')
      ? TWILIO_WHATSAPP_FROM
      : `whatsapp:${TWILIO_WHATSAPP_FROM}`,
    to: normalizeWhatsApp(to),
    body: body || '',
  };
  if (mediaUrl) payload.mediaUrl = mediaUrl;

  const res = await client.messages.create(payload);

  const result = {
    sid: res.sid,
    to: res.to,
    from: res.from,
    reminderId,
    status: res.status || 'queued',
  };
  console.log('[TWILIO] Message sent successfully:', result);
  return result;
}

async function sendMessage(to, text, mediaUrl = null) {
  return sendReminder(to, text, null, mediaUrl);
}

module.exports = { sendReminder, sendMessage };
