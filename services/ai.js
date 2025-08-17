// services/ai.js
// CommonJS – gunakan Chat Completions (bukan Responses API)
// Model: gpt-5-mini (tanpa set temperature agar tidak error)

const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Util: coba parse JSON aman
function safeParseJSON(str) {
  if (!str || typeof str !== 'string') return null;
  try {
    return JSON.parse(str);
  } catch (_) {
    // Coba ekstrak blok { ... } terluar
    const first = str.indexOf('{');
    const last = str.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(str.slice(first, last + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

// Heuristik cepat untuk beberapa pola agar tetap responsif kalau AI gagal
function quickHeuristics(text) {
  const t = (text || '').trim().toLowerCase();

  // stop (No)
  const mStop = t.match(/^stop\s*\(\s*(\d+)\s*\)\s*$/i);
  if (mStop) {
    return { intent: 'stop_number', stopNumber: parseInt(mStop[1], 10) };
  }

  // --reminder keyword
  const mKw = t.match(/^--reminder\s+(.+)\s*$/i);
  if (mKw) {
    return { intent: 'cancel_keyword', cancelKeyword: mKw[1].trim() };
  }

  // list
  if (['list', 'daftar', 'lihat', 'reminder'].includes(t)) {
    return { intent: 'list' };
  }

  // cancel all
  if (/(batal|hapus|stop).*(semua|semuanya|all)/i.test(t)) {
    return { intent: 'cancel_all' };
  }

  return null; // biar model yang tentukan
}

/**
 * extract(text, opts) -> { intent, title, dueAtWIB, timeType, repeat, repeatDetails, recipientUsernames, reply, stopNumber, cancelKeyword }
 * - reply: balasan natural (bukan template) yang langsung bisa dikirim ke user
 * - dueAtWIB: ISO Asia/Jakarta jika ada
 */
async function extract(text, opts = {}) {
  // Heuristik dulu supaya cepat
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

  // Prompt sistem yang menggabungkan 8 fitur dan gaya natural
  const systemPrompt = `
Kamu adalah asisten WhatsApp berbahasa Indonesia yang HANGAT, NATURAL, dan KONTEKSTUAL.
Tugas: bantu buat & batal reminder dengan percakapan yang enak, seperti teman yang peduli.
HARUS:
- Gaya santai (pakai "aku" & "kamu"), ramah, tidak kaku, tidak seperti bot.
- Emoji secukupnya (😊✨🙏), jangan berlebihan. Maksimal 2 emoji per balasan.
- Hindari template generik berulang; balasan harus menyesuaikan konteks user.
- Jika belum cukup info, tanya dengan jelas dan beri contoh singkat format waktu (jam 20.00, 1 jam lagi, besok 09.00).
- Jangan mengarang waktu. Jika user belum sebut waktu/aktivitas, minta klarifikasi.
- Jika mendeteksi potensi reminder meski tanpa kata "ingatkan", TAWARKAN dengan sopan.
- Saat membalas, kamu juga mengembalikan STRUKTUR JSON untuk keperluan server.
- Motivasi boleh 1 baris pendek MAKSIMAL, spontan sesuai konteks (jangan pakai pola kalimat yang sama terus).

Keluarkan dalam JSON DENGAN STRUKTUR TEPAT berikut:
{
  "intent": "create" | "need_time" | "need_content" | "list" | "cancel_keyword" | "stop_number" | "cancel" | "cancel_all" | "potential_reminder" | "unknown",
  "title": string | null,            // isi reminder, singkat & jelas, TANPA kata "lagi", "nanti", dll
  "recipientUsernames": string[],    // array username, mis. ["@andi"]. Kosongkan jika tidak ada.
  "timeType": "relative" | "absolute" | "recurring",
  "dueAtWIB": string | null,         // ISO 8601 di zona Asia/Jakarta (contoh: "2025-08-17T20:00:00+07:00") jika sudah bisa ditentukan
  "repeat": "none" | "hourly" | "daily" | "weekly" | "monthly",
  "repeatDetails": {                 // opsional untuk recurring
     "timeOfDay": string | null,     // "HH:mm"
     "dayOfWeek": string | null,     // "senin"..."minggu"
     "dayOfMonth": number | null     // 1..31
  },
  "cancelKeyword": string | null,    // jika user kirim --reminder [keyword]
  "stopNumber": number | null,       // jika user kirim stop (No)
  "reply": string                    // BALASAN NATURAL SATU PARAGRAF PENDEK untuk user, sesuai konteks
}

Aturan penentuan intent ringkas:
- "create": isi & waktu cukup untuk dijadwalkan (sekali).
- "need_time": ada isi, belum ada waktu.
- "need_content": ada waktu, belum ada isi.
- "list": user minta daftar.
- "cancel_keyword": user kirim "--reminder <keyword>".
- "stop_number": user kirim "stop (No)".
- "cancel": user minta stop reminder berulang secara umum.
- "cancel_all": user minta stop semua reminder aktif.
- "potential_reminder": ada indikasi ingin diingatkan tapi belum eksplisit (perintah/harapan/reflektif).
- "unknown": tidak relevan / random -> tetap balas hangat dan tawarkan bantuan pengingat dengan lembut.

PENTING:
- "title" jangan berisi kata waktu seperti "lagi", "nanti", "besok".
- "reply" harus natural, tidak kaku, tidak template. Boleh ada contoh singkat jika perlu.
- Jika user hanya menjawab waktu (mis. "1 menit lagi"), jangan isi "title" sembarang. Biarkan null dan set intent "need_content".
- Jika user hanya sebut isi (mis. "beli kopi nescafe"), jangan karang jam. Set intent "need_time".
- "dueAtWIB" harus valid ISO Asia/Jakarta jika waktu sudah jelas, termasuk kasus "1 menit lagi".
`;

  const userName = opts.userName || null;
  const userTz = opts.timezone || 'Asia/Jakarta';

  const userMsg = `
Nama user: ${userName || '-'}
Zona waktu: ${userTz}
Pesan user: "${text}"
Balas sesuai aturan, hasilkan JSON persis seperti skema di atas.
`;

  let content;
  try {
    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ],
      // JANGAN set temperature untuk hindari error "unsupported temperature"
      response_format: { type: 'json_object' },
      max_tokens: 500
    });

    content = resp?.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty AI response');
  } catch (e) {
    console.error('[AI] Extract error:', e);
    // fallback minimal
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
      reply: 'Aku di sini buat bantu kamu bikin pengingat biar nggak lupa. Mau diingatkan tentang apa, dan kapan? 😊'
    };
  }

  const parsed = safeParseJSON(content);
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
      reply: 'Boleh ceritakan mau diingatkan apa, dan jam berapa? Aku bantu aturkan ya 😊'
    };
  }

  // Normalisasi output
  const out = {
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

  return out;
}

module.exports = { extract };
