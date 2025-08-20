// Twilio WhatsApp sender

const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

if (!accountSid || !authToken) {
  console.warn('[WAOutbound] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN belum diset.');
}

const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

function normalizeToWhatsApp(to) {
  if (!to || typeof to !== 'string') return to;
  const raw = to.replace(/^whatsapp:/, '');
  return raw.startsWith('+') ? `whatsapp:${raw}` : `whatsapp:+${raw}`;
}

async function sendMessage(to, text, reminderId = null) {
  if (!client) {
    console.error('[WAOutbound] Twilio client belum terinisialisasi.');
    throw new Error('Twilio not configured');
  }
  const toWA = normalizeToWhatsApp(to);
  const res = await client.messages.create({
    from: fromNumber,
    to: toWA,
    body: text,
  });
  console.log('[TWILIO] Message sent successfully:', {
    sid: res.sid,
    to: toWA,
    from: fromNumber,
    reminderId,
    status: res.status,
  });
  return res;
}

// Backward compatibility: some old code calls sendReminder
module.exports = {
  sendMessage,
  sendReminder: sendMessage,
};
