/* services/ai.js - CommonJS, Chat Completions only (no Responses API params)
   Model: gpt-5-mini
   Notes:
   - No 'temperature' override (some deployments restrict it)
   - No 'max_tokens' / 'max_completion_tokens' / 'max_output_tokens'
   - Always return robust fallback when API fails
*/
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Utility: safe JSON extractor (grabs first top-level object)
function safeParseJSON(text) {
  if (!text || typeof text !== 'string') return null;
  // Try direct parse first
  try { return JSON.parse(text); } catch(_) {}
  // Fallback: extract first {...} block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try { return JSON.parse(slice); } catch(_) {}
  }
  return null;
}

async function chatJSON(system, user, extraMessages = []) {
  const messages = [
    { role: 'system', content: system },
    ...extraMessages,
    { role: 'user', content: user }
  ];
  let outText = '';
  try {
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      messages,
      // Do not set temperature or max_tokens to avoid model-specific errors
    });
    outText = resp?.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('[AI] API error:', err?.message || err);
    throw err;
  }
  return outText;
}

// Build Indonesian JSON-only extractor system prompt
const EXTRACT_SYSTEM = `
Kamu adalah asisten yang mengekstrak niat pengguna WhatsApp untuk pengingat dalam Bahasa Indonesia.
Kembalikan **JSON murni saja** tanpa penjelasan lain.

Skema:
{
  "intent": "unknown" | "potential_reminder" | "need_time" | "need_content" | "create" | "cancel_keyword" | "stop_number" | "list",
  "title": string | null,                         // isi pengingat (mis. "makan siang")
  "recipientUsernames": string[],                 // extract @username mentions (tanpa @)
  "timeType": "relative" | "absolute",            // jenis waktu bila ada
  "dueAtWIB": string | null,                      // ISO 8601 Asia/Jakarta (contoh "2025-08-17T14:00:00+07:00")
  "repeat": "none" | "minutes" | "hours" | "daily" | "weekly" | "monthly" | "yearly",
  "repeatDetails": {
    "interval": number | null,                    // untuk minutes/hours: interval number (30 menit = 30)
    "timeOfDay": string | null,                   // "14:00", dsb untuk daily/weekly/monthly
    "dayOfWeek": string | null,                   // "senin", dsb (bila weekly)
    "dayOfMonth": number | null,                  // (bila monthly)
    "monthDay": string | null,                    // "12 Mei" (bila yearly)
    "endDate": string | null                      // "sampai 30 Sep" atau "selama 3 bulan"
  },
  "cancelKeyword": string | null,                 // bila user kirim --reminder <keyword>
  "stopNumber": number | null,                    // bila user kirim "stop (N)"
  "reply": string                                 // satu kalimat balasan percakapan yang hangat & natural (bukan template), max 1 baris
}

Aturan penting:
- Deteksi niat pembuatan pengingat walau tanpa kata "ingatkan" (contoh: "jemput John nanti", "aku suka lupa minum air", "semoga gak lupa jemput John").
- Extract @username mentions ke recipientUsernames (hapus @, ambil username saja).
- Jika ada @username, tetap extract title dari sisa pesan setelah hapus mentions.
- Jika pesan hanya waktu (contoh "2 menit lagi") tanpa isi, intent = "need_content".
- Jika pesan hanya isi (contoh "minum obat") tanpa waktu, intent = "need_time".
- Jika keduanya ada, intent = "create".
- Jika mulai dengan "--reminder <keyword>", intent = "cancel_keyword", cancelKeyword=keyword.
- Jika format "stop (N)" atau "batal (N)" atau hanya angka setelah list reminder, intent = "stop_number", stopNumber=N.
- Jika "list" => intent = "list".
- Repeat patterns:
  - "setiap X menit/jam" → repeat="minutes"/"hours", interval=X
  - "setiap hari jam X" → repeat="daily", timeOfDay="X"
  - "setiap senin/selasa jam X" → repeat="weekly", dayOfWeek="senin", timeOfDay="X"
  - "setiap tanggal X jam Y" → repeat="monthly", dayOfMonth=X, timeOfDay="Y"
  - "setiap 12 Mei jam X" → repeat="yearly", monthDay="12 Mei", timeOfDay="X"
  - "sampai 30 Sep" atau "selama 3 bulan" → endDate extract
- Waktu:
  - Pahami: "1/2/5/15 menit lagi", "jam 20.00", "20:30", "besok jam 2 siang", "rabu depan jam 3", "lusa", "pagi/siang/sore/malam".
  - Konversi ke WIB ISO di dueAtWIB (gunakan nowWIB). Jika hanya hari (mis. "besok") tanpa jam, minta jam -> intent "need_time".
- reply: hangat, personal, dan relevan dengan pesan terbaru & konteks; 1 kalimat, tidak kaku, tanpa daftar panjang.
`;

function buildExtractUserPrompt({ text, username, nowWIB, lastContext }) {
  const ctx = {
    text,
    username,
    nowWIB,          // ISO Asia/Jakarta "YYYY-MM-DDTHH:mm:ss+07:00"
    lastContext      // { pendingTitle, pendingTimeHint, lastListedIds }
  };
  return JSON.stringify(ctx);
}

async function extract({ text, userProfile = {}, sessionContext = {} }) {
  const now = new Date();
  const offsetMs = 7 * 60 * 60 * 1000;
  const nowWIB = new Date(now.getTime() + offsetMs).toISOString().replace('Z', '+07:00');

  const system = EXTRACT_SYSTEM;
  const user = buildExtractUserPrompt({
    text,
    username: userProfile?.username || null,
    nowWIB,
    lastContext: sessionContext || null
  });

  let out;
  try {
    const raw = await chatJSON(system, user);
    out = safeParseJSON(raw);
  } catch (err) {
    // API failure -> handled below
  }

  // Default object if parsing fails
  if (!out || typeof out !== 'object') {
    return {
      intent: 'unknown',
      title: text?.trim() || null,
      recipientUsernames: [],
      timeType: 'absolute',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: { 
        interval: null,
        timeOfDay: null, 
        dayOfWeek: null, 
        dayOfMonth: null,
        monthDay: null,
        endDate: null
      },
      cancelKeyword: null,
      stopNumber: null,
      reply: 'Aku di sini buat bantu kamu bikin pengingat biar nggak lupa. Mau diingatkan tentang apa, dan kapan? 😊'
    };
  }

  // Normalize minimal fields
  out.recipientUsernames = Array.isArray(out.recipientUsernames) ? out.recipientUsernames : [];
  out.repeat = out.repeat || 'none';
  if (!out.repeatDetails) out.repeatDetails = { timeOfDay: null, dayOfWeek: null, dayOfMonth: null };
  if (typeof out.reply !== 'string' || !out.reply.trim()) {
    out.reply = 'Siap. Ada yang mau kamu ingatkan?';
  }

  return out;
}

// Enhanced message generator for various contexts including motivational reminder delivery
const REPLY_SYSTEM = `
Kamu adalah asisten WhatsApp berbahasa Indonesia yang hangat, santai, dan natural.

Untuk context.kind = "reminder_delivery":
- Buat pesan pengingat yang SANGAT personal dan motivasional
- Sesuaikan emoticon dengan aktivitas (☕ untuk kopi, 💪 untuk olahraga, 📚 untuk belajar, dll)
- Tambahkan kalimat motivasi singkat yang relevan dengan aktivitas
- Gunakan nama user jika ada
- Format: "Halo [nama], waktunya [aktivitas]! [motivasi singkat] [emoticon]"

Untuk context lainnya:
- Hasilkan **SATU kalimat** saja (maksimal satu baris), ramah & relevan dengan konteks
- Hindari bahasa kaku, boleh pakai emoji secukupnya

Contoh reminder_delivery:
- title: "minum kopi" → "Halo Budi, waktunya minum kopi! Nikmati aromanya yang bikin semangat ☕😊"
- title: "olahraga" → "Halo Sarah, waktunya olahraga! Tubuh sehat, pikiran fresh 💪✨"
- title: "meeting" → "Halo Alex, waktunya meeting! Semoga diskusinya produktif 📋🌟"
- title: "minum obat" → "Halo Rina, waktunya minum obat! Jaga kesehatan ya 💊❤️"
- title: "jemput anak" → "Halo Papa, waktunya jemput anak! Safe trip 🚗👶"
`;

async function generateReply(context) {
  const user = JSON.stringify(context || {});
  try {
    const text = await chatJSON(REPLY_SYSTEM, user);
    // ensure it is a single line
    return (text || '').replace(/\s+/g, ' ').trim();
  } catch (err) {
    console.error('[AI] generateReply error:', err?.message || err);
    return null;
  }
}

module.exports = {
  extract,
  generateReply
};
