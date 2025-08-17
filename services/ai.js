// services/ai.js (CommonJS, Chat Completions only)
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Utils ---
function safeParseJSON(str) {
  if (!str || typeof str !== 'string') return null;
  try { return JSON.parse(str); } catch {}
  const i = str.indexOf('{'), j = str.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(str.slice(i, j + 1)); } catch {} }
  return null;
}

function quickHeuristics(text) {
  const t = (text || '').trim().toLowerCase();
  const mStop = t.match(/^stop\s*\(\s*(\d+)\s*\)\s*$/i);
  if (mStop) return { intent: 'stop_number', stopNumber: parseInt(mStop[1], 10) };
  const mKw = t.match(/^--reminder\s+(.+)\s*$/i);
  if (mKw) return { intent: 'cancel_keyword', cancelKeyword: mKw[1].trim() };
  if (['list', 'daftar', 'lihat', 'reminder'].includes(t)) return { intent: 'list' };
  if (/(batal|hapus|stop).*(semua|semuanya|all)/i.test(t)) return { intent: 'cancel_all' };
  return null;
}

/**
 * extract(text, { userName, timezone, context })
 * Output:
 * {
 *   intent, title, recipientUsernames, timeType, dueAtWIB, repeat, repeatDetails,
 *   cancelKeyword, stopNumber, reply
 * }
 */
async function extract(text, opts = {}) {
  const { userName, timezone, context } = opts;
  const h = quickHeuristics(text);
  if (h) {
    return {
      intent: h.intent,
      title: null,
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: h.cancelKeyword || null,
      stopNumber: h.stopNumber || null,
      reply: null
    };
  }

  const systemPrompt = `
Kamu asisten WhatsApp yang HANGAT dan NATURAL (bahasa Indonesia santai: aku/kamu).
Misi: bantu buat/batal reminder secara percakapan, dukung konteks lintas pesan.
Prinsip:
- Jangan kaku. Balasan 1 baris, maksimal 2 emoji.
- Kalau user belum lengkap (hanya isi atau hanya waktu), gabungkan dengan konteks sebelumnya bila tersedia, lalu tentukan intent sesuai kelengkapan.
- Kalau masih kurang jelas, tanya sopan dan beri contoh singkat.
- Hindari menjadikan kata waktu seperti "lagi", "nanti", "besok" sebagai judul.
- Untuk self-reminder, recipientUsernames = [].
- Jika waktu jelas, "dueAtWIB" harus ISO 8601 di zona Asia/Jakarta (contoh: 2025-08-17T14:00:00+07:00).
- Jika mendeteksi potensi reminder (perintah/reflektif/harapan) tanpa eksplisit, gunakan "potential_reminder".

Struktur output WAJIB JSON valid:
{
  "intent": "create" | "need_time" | "need_content" | "list" | "cancel_keyword" | "stop_number" | "cancel" | "cancel_all" | "potential_reminder" | "unknown",
  "title": string | null,
  "recipientUsernames": string[],
  "timeType": "relative" | "absolute" | "recurring",
  "dueAtWIB": string | null,
  "repeat": "none" | "hourly" | "daily" | "weekly" | "monthly",
  "repeatDetails": { "timeOfDay": string | null, "dayOfWeek": string | null, "dayOfMonth": number | null },
  "cancelKeyword": string | null,
  "stopNumber": number | null,
  "reply": string
}
`;

  const ctx = context && typeof context === 'object' ? {
    lastIntent: context.lastIntent || null,
    pendingTitle: context.pendingTitle || null,
    pendingDueAtWIB: context.pendingDueAtWIB || null,
    pendingRepeat: context.pendingRepeat || 'none',
    pendingRepeatDetails: context.pendingRepeatDetails || {}
  } : null;

  const userMsg = `
Nama user: ${userName || '-'}
Zona waktu: ${timezone || 'Asia/Jakarta'}

Konteks percakapan sebelumnya (bila ada):
${JSON.stringify(ctx || {}, null, 2)}

Pesan user saat ini: "${text}"

TUGAS:
- Deteksi intent.
- Gabungkan informasi dari konteks bila relevan (misal: user baru menyebut jam sekarang, isi ada di konteks → jadikan lengkap).
- Jika sudah lengkap, intent "create" dan isi dueAtWIB.
- Jawab ringkas & hangat dalam "reply" (1 baris, ≤2 emoji).

Balas HANYA JSON valid sesuai skema (tanpa teks lain).
`;

  let raw;
  try {
    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ]
      // JANGAN kirim max_tokens/temperature → model menolak.
      // Boleh pertahankan response_format JSON kalau model mendukung.
      // Jika model kamu error dengan response_format, hapus baris di bawah.
      ,response_format: { type: 'json_object' }
    });
    raw = resp?.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error('Empty AI response');
  } catch (e) {
    console.error('[AI] Extract error:', e);
    return {
      intent: 'unknown',
      title: null,
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      reply: 'Aku bisa bantu kamu bikin pengingat biar nggak lupa. Mau diingatkan apa dan kapan? 😊'
    };
  }

  const parsed = safeParseJSON(raw);
  if (!parsed || typeof parsed !== 'object') {
    return {
      intent: 'unknown',
      title: null,
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      reply: 'Boleh jelasin mau diingatkan apa dan jam berapa? Aku bantu aturin ya 🙂'
    };
  }

  // Normalisasi agar self-reminder tidak mengisi recipient
  const recipients = Array.isArray(parsed.recipientUsernames) ? parsed.recipientUsernames : [];

  return {
    intent: parsed.intent || 'unknown',
    title: parsed.title || null,
    recipientUsernames: recipients,
    timeType: parsed.timeType || 'relative',
    dueAtWIB: parsed.dueAtWIB || null,
    repeat: parsed.repeat || 'none',
    repeatDetails: parsed.repeatDetails || {},
    cancelKeyword: parsed.cancelKeyword || null,
    stopNumber: parsed.stopNumber || null,
    reply: parsed.reply || null
  };
}

module.exports = { extract };
