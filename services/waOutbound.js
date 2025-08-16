// services/waOutbound.js
import twilio from "twilio";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM, // contoh: "whatsapp:+14155238886" (sandbox) atau nomor WA bisnis kamu
} = process.env;

let client = null;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.warn("[WAOutbound] Missing Twilio credentials. Set TWILIO_ACCOUNT_SID & TWILIO_AUTH_TOKEN.");
} else {
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

function toWhatsAppFormat(num) {
  if (!num) return num;
  return num.startsWith("whatsapp:") ? num : `whatsapp:${num}`;
}

function fromWhatsAppFormat() {
  // fallback ke sandbox default bila env tidak di-set
  const val = TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";
  return val.startsWith("whatsapp:") ? val : `whatsapp:${val}`;
}

/**
 * Kirim pesan WhatsApp ke nomor user (format internasional).
 * Tetap kompatibel dengan implementasi lama:
 *   sendReminder(to, body, reminderId)
 * Mengembalikan object mirip log lama:
 *   { sid, to, from, reminderId, status }
 */
export async function sendReminder(to, body, reminderId = null, mediaUrl = null) {
  if (!client) throw new Error("Twilio client not configured.");

  const payload = {
    from: fromWhatsAppFormat(),
    to: toWhatsAppFormat(to),
    body: body || "",
  };
  if (mediaUrl) payload.mediaUrl = mediaUrl;

  const res = await client.messages.create(payload);

  const result = {
    sid: res.sid,
    to: res.to,
    from: res.from,
    reminderId,
    status: res.status, // biasanya 'queued' | 'sent' | ...
  };

  console.log("[TWILIO] Message sent successfully:", result);
  return result;
}

/**
 * Alias sederhana agar kode baru yang memakai sendMessage juga tetap jalan.
 * (call ke sendReminder di bawah)
 */
export async function sendMessage(to, text, mediaUrl = null) {
  return sendReminder(to, text, null, mediaUrl);
}
