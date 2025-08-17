// /services/waOutbound.js  (ESM)
import Twilio from 'twilio';

const {
  TWILIO_ACCOUNT_SID = '',
  TWILIO_AUTH_TOKEN = '',
  TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886', // default sandbox number
} = process.env;

let client = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (e) {
    console.error('[WAOutbound] Gagal inisialisasi Twilio:', e);
  }
} else {
  console.warn('[WAOutbound] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN belum diset di env.');
}

function normalizeWhatsApp(to) {
  if (!to) return to;
  return to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
}

/**
 * Kirim pesan WhatsApp via Twilio
 * @param {string} to - nomor tujuan (contoh: +62813xxxx → akan diprefix whatsapp:)
 * @param {string} text - isi pesan
 * @param {number|null} reminderId - optional, untuk logging
 * @returns {Promise<{sid:string,to:string,from:string,reminderId:number|null,status:string}>}
 */
export async function sendReminder(to, text, reminderId = null) {
  if (!client) {
    console.error('[WAOutbound] Twilio client belum tersedia. Cek credentials env.');
    throw new Error('Twilio not configured');
  }
  const toWa = normalizeWhatsApp(to);
  try {
    const msg = await client.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: toWa,
      body: text,
    });
    const payload = {
      sid: msg.sid,
      to: toWa,
      from: TWILIO_WHATSAPP_FROM,
      reminderId: reminderId ?? null,
      status: msg.status || 'queued',
    };
    console.log('[TWILIO] Message sent successfully:', payload);
    return payload;
  } catch (err) {
    console.error('[WAOutbound] Gagal kirim pesan:', err);
    throw err;
  }
}

/** Alias untuk backward-compat (beberapa modul lama pakai sendMessage) */
export async function sendMessage(to, text, reminderId = null) {
  return sendReminder(to, text, reminderId);
}

export default { sendReminder, sendMessage };
