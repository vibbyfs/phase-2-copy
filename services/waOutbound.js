// twilio-outbound.js

// ==== Lazy initialize Twilio client (singleton) ====
let _twilioClient = null;

function getTwilioClient() {
  // Jika env tidak lengkap, tetap kembalikan null -> DEMO MODE
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return null;
  }
  if (_twilioClient) return _twilioClient;

  const twilio = require('twilio');
  _twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return _twilioClient;
}

// ==== Util: normalisasi nomor ke whatsapp:+E164 ====
function ensureWhatsappAddr(num) {
  if (!num) throw new Error('Nomor tujuan kosong');

  let s = String(num).trim();

  // Jika sudah lengkap dengan prefix whatsapp:
  if (s.startsWith('whatsapp:')) {
    // pastikan setelahnya dalam bentuk +E164
    const bare = s.slice('whatsapp:'.length);
    if (!bare.startsWith('+')) {
      // normalisasi ringan: ambil digit dan tambahkan +
      const digits = bare.replace(/\D/g, '');
      return `whatsapp:+${digits}`;
    }
    return s;
  }

  // Jika belum ada prefix whatsapp:, pastikan ada tanda + di depan
  if (!s.startsWith('+')) {
    s = '+' + s.replace(/\D/g, '');
  }
  return `whatsapp:${s}`;
}

// ==== Main function: sendReminder ====
async function sendReminder(to, text, reminderId) {
  try {
    const client = getTwilioClient();

    if (!client) {
      // DEMO MODE: kredensial tidak tersedia di runtime
      console.warn('[TWILIO] DEMO MODE - missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN. Would send:', {
        to,
        text,
        reminderId
      });
      return {
        success: false,                // <- jangan true agar tidak menandai "terkirim"
        messageId: null,
        status: 'demo_missing_credentials'
      };
    }

    if (!process.env.TWILIO_WHATSAPP_FROM) {
      throw new Error('TWILIO_WHATSAPP_FROM is not set');
    }

    // Pastikan from & to memakai prefix whatsapp:
    const from =
      process.env.TWILIO_WHATSAPP_FROM.startsWith('whatsapp:')
        ? process.env.TWILIO_WHATSAPP_FROM
        : `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;

    const toAddr = ensureWhatsappAddr(to);

    // OPTIONAL: status callback (set via env kalau ada)
    const payload = {
      body: text,
      from,
      to: toAddr
    };
    if (process.env.TWILIO_STATUS_CALLBACK_URL) {
      payload.statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL;
    }

    // Kirim pesan WhatsApp via Twilio
    const message = await client.messages.create(payload);

    console.log('[TWILIO] Message sent successfully:', {
      sid: message.sid,
      to: toAddr,
      from,
      reminderId,
      status: message.status
    });

    return {
      success: true,
      messageId: message.sid,
      status: message.status
    };
  } catch (error) {
    // Permukaan-kan detail error Twilio agar mudah debug
    console.error('[TWILIO] Error sending message:', {
      message: error.message,
      code: error.code,
      status: error.status,
      moreInfo: error.moreInfo,
      reminderId
    });
    // Lanjutkan throw agar lapisan pemanggil bisa memutuskan retry/mark failed
    throw error;
  }
}

module.exports = { sendReminder };
