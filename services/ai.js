// services/ai.js
// CommonJS – Chat Completions only (tanpa max_tokens), aman untuk gpt-5-mini
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Utils ---
function safeParseJSON(str) {
  if (!str || typeof str !== 'string') return null;
  try {
    return JSON.parse(str);
  } catch (_) {
    const first = str.indexOf('{');
    const last = str.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(str.slice(first, last + 1)); } catch (_) {}
    }
    return null;
  }
}

// Heuristik cepat untuk command khusus
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
 * extract(text, { userName, timezone })
 * Return shape:
 * {
 *   intent, title, recipientUsernames, timeType, dueAtWIB, repeat, repeatDetails,
 *   cancelKeyword, stopNumber, reply
 * }
 */
async function extract(text, opts = {}) {
  // Command cepat (biar gak selalu panggil model)
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
Kamu asisten WhatsApp berbahasa Indonesia yang HANGAT, NATURAL, dan KONTEKSTUAL.
Fokus: bantu buat/batal reminder secara percakapan, seperti teman yang peduli.
Gaya:
- Santai (pakai "aku/kamu"), tidak kaku, tidak seperti bot.
- Emoji secukupnya (maks 2 per balasan).
- Jangan mengarang waktu; kalau kurang info, tanya jelas dan beri contoh singkat.
- Jika ada potensi reminder meski user tak bilang "ingatkan", tawarkan dengan sopan.
- Beri balasan natural (bukan template), + KEMBALIKAN JSON sesuai skema.

KELUARKAN **HANYA** JSON persis skema ini:
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

Aturan ringkas:
- "create": isi & waktu cukup.
- "need_time": ada isi, belum waktu.
- "need_content": ada waktu, belum isi.
- "list": minta daftar.
- "cancel_keyword": pola --reminder <keyword>.
- "stop_number": pola stop (No).
- "cancel": stop reminder berulang saja.
- "cancel_all": stop semua.
- "potential_reminder": indikasi ingin diingatkan (perintah/harapan/reflektif) tapi belum eksplisit.
- "unknown": random/umum → tetap balas hangat & tawarkan bantuan reminder.

Catatan:
- "title" JANGAN mengandung kata waktu ("lagi", "nanti", "besok", dsb).
- "dueAtWIB": ISO 8601 zona Asia/Jakarta bila waktu jelas (termasuk "1 menit lagi").
- "reply": balasan natural singkat, maksimal 2 emoji.
`;

  const userMsg = `
Nama user: ${opts.userName || '-'}
Zona waktu: ${opts.timezone || 'Asia/Jakarta'}
Pesan user: "${text}"
Balas dengan JSON valid sesuai SKEMA (tanpa teks lain).
`;

  let raw;
  try {
    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ],
      // PENTING: jangan kirim max_tokens di model ini → error "unsupported_parameter"
      // response_format JSON bisa tidak didukung pada sebagian model.
      // Kalau model-mu error karena ini, hapus baris response_format di bawah.
      response_format: { type: 'json_object' }
    });
    raw = resp?.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error('Empty AI response');
  } catch (e) {
    console.error('[AI] Extract error:', e);
    return {
      intent: 'unknown',
      title: (text || '').trim(),
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      reply: 'Aku bisa bantu bikin pengingat biar nggak lupa. Mau diingatkan tentang apa, dan kapan? 😊'
    };
  }

  const parsed = safeParseJSON(raw);
  if (!parsed || typeof parsed !== 'object') {
    return {
      intent: 'unknown',
      title: (text || '').trim(),
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      reply: 'Boleh jelaskan mau diingatkan apa, dan jam berapa? Aku bantu aturkan ya 😊'
    };
  }

  return {
    intent: parsed.intent || 'unknown',
    title: parsed.title || null,
    recipientUsernames: Array.isArray(parsed.recipientUsernames) ? parsed.recipientUsernames : [],
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
