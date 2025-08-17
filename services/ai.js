// services/ai.js (CommonJS)
// Conversational + Structured action for WhatsApp reminders
// Model: gpt-5-mini (no temperature, use max_completion_tokens)

const { DateTime } = require('luxon');
const OpenAI = require('openai');

const WIB_TZ = 'Asia/Jakarta';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---- System Prompt (concise but strict) ----
function buildSystemPrompt(nowWIB, state) {
  return `
Kamu asisten WhatsApp yang HANGAT, NATURAL, dan PERSONAL (bukan bot kaku).
Tugasmu:
1) Balas chat user secara natural dalam Bahasa Indonesia casual (maks 1-2 emoji, tidak repetitif, tidak kaku).
2) Selain balasan percakapan (field "reply"), kembalikan juga "action" terstruktur untuk backend.

Format output HARUS JSON valid tanpa teks lain:
{
  "reply": "kalimat natural ramah dan relevan (1-2 emoji, hindari template, jangan terlalu panjang)",
  "action": {
    "type": "none|potential_reminder|need_time|need_content|create|cancel|cancel_all|cancel_keyword|stop_number|list",
    "title": "judul ringkas aktivitas (tanpa kata 'reminder/pengingat/setiap') atau null",
    "dueAtWIB": "YYYY-MM-DDTHH:mm:ssZZ (WIB) atau null",
    "timeType": "relative|absolute|recurring|null",
    "repeat": "none|hourly|daily|weekly|monthly",
    "repeatDetails": {
      "dayOfWeek": "senin|selasa|rabu|kamis|jumat|sabtu|minggu|null",
      "timeOfDay": "HH:mm|null",
      "dayOfMonth": "1-31|null"
    },
    "cancelKeyword": "string|null",
    "stopNumber": "string|null",
    "recipientUsernames": ["@john", ...]
  }
}

KONTEKS WAKTU:
- NOW_WIB: ${nowWIB.toFormat('yyyy-LL-dd HH:mm:ss')} WIB (${WIB_TZ})

GAYA BALASAN ("reply"):
- Personal, cair, empatik; gunakan nama user jika ada di konteks (state.userName), panggil "kamu" jika tidak ada.
- 1 baris saja, 1-2 emoji maksimal, jangan terasa template.
- Jika pesan umum/curhat/tidak jelas: tetap responsif dan OFFER bantuan reminder tanpa memaksa.

DETEKSI INTENT (action.type):
- "potential_reminder": pesan berpotensi perlu reminder walau tanpa kata "ingatkan/reminder" (contoh: "jemput John nanti", "aku suka lupa minum air", "besok ada rapat penting"). Balas tawarkan bantuan + tanya jamnya.
- "need_time": ada isi (title) tapi belum ada waktu → minta jamnya.
- "need_content": ada waktu tapi belum ada title → minta isi pengingatnya.
- "create": lengkap (title + waktu). Wajib isi dueAtWIB (zona ${WIB_TZ}) dan timeType.
- "cancel": batalkan semua reminder berulang aktif user (kalau user minta stop/batal tanpa keyword).
- "cancel_all": batalkan SEMUA reminder aktif user.
- "cancel_keyword": jika pola '--reminder <kata>' → isi action.cancelKeyword dengan kata itu.
- "stop_number": jika pola 'stop (angka)' → isi action.stopNumber.
- "list": jika user minta daftar reminder.
- "none": jika benar-benar tidak ada aksi (small talk).

PARSING WAKTU:
- RELATIVE: "X menit lagi/jam lagi/detik lagi/hari lagi" → dueAtWIB = NOW_WIB + X.
- "besok" (tanpa jam) → jangan jadwalkan otomatis; minta jam (need_time). Jika "besok jam 2 siang" → 14:00 esok hari.
- ABSOLUTE: "jam 14:00", "pukul 2 siang", "senin jam 9".
- RECURRING: "setiap hari jam 8" → repeat: "daily", timeOfDay: "08:00"; "setiap senin jam 9" → repeat: "weekly", dayOfWeek: "senin".
- Wajib gunakan zona ${WIB_TZ} untuk dueAtWIB.

TITLE:
- Ringkas (≤5 kata), hilangkan kata "reminder/pengingat/ingatkan/setiap".
- Contoh: "ingetin saya minum air putih" → "Minum Air Putih".

USERNAME TAG:
- Kumpulkan semua @username (recipientUsernames). Jika ada, repeat = "none".

CATATAN:
- Jangan pernah membuat "create" tanpa waktu valid (kalau ragu → need_time).
- Jangan menulis lebih dari 1 baris di "reply".
- Hindari emoji di awal kalimat; letakkan di akhir kalau perlu.
- Jangan pakai list berpoin di "reply".
- Jika user hanya kirim "halo/hey" → small talk ramah + tawarkan bantuan reminder secara halus.
STATE (konteks percakapan):
${JSON.stringify({
  userName: state?.userName || null,
  pendingTitle: state?.pendingTitle || null,
  pendingDueAtWIB: state?.pendingDueAtWIB || null,
}, null, 2)}
`;
}

// ---- Call model and parse JSON safely ----
async function callModel(messages, maxTokens = 400) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-5-mini',
    messages,
    // IMPORTANT for gpt-5-mini:
    // - don't send 'temperature'
    // - use 'max_completion_tokens' instead of 'max_tokens'
    max_completion_tokens: maxTokens,
  });

  const content = completion.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty AI response');
  return content;
}

function safeJSONParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- Public: extract (main entry) ----
async function extract(userText, sessionState = {}) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const system = buildSystemPrompt(nowWIB, sessionState);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userText },
  ];

  try {
    const raw = await callModel(messages, 450);
    const json = safeJSONParse(raw);

    if (!json || typeof json !== 'object' || !json.action) {
      throw new Error('Invalid AI JSON');
    }

    // Normalize minimal fields expected by controller:
    const action = json.action || {};
    return {
      reply: typeof json.reply === 'string' ? json.reply.trim() : null,
      action: {
        type: action.type || 'none',
        title: action.title || null,
        dueAtWIB: action.dueAtWIB || null,
        timeType: action.timeType || null,
        repeat: action.repeat || 'none',
        repeatDetails: action.repeatDetails || {},
        cancelKeyword: action.cancelKeyword || null,
        stopNumber: action.stopNumber || null,
        recipientUsernames: Array.isArray(action.recipientUsernames) ? action.recipientUsernames : [],
      },
    };
  } catch (err) {
    console.error('[AI] Extract error:', err);

    // ---- Fallback heuristic (simple & robust) ----
    const text = (userText || '').trim().toLowerCase();

    // STOP (n)
    const stopNum = text.match(/^stop\s*\((\d+)\)\s*$/i);
    if (stopNum) {
      return {
        reply: 'Oke, kubatalkan sesuai nomor itu ya 😊',
        action: { type: 'stop_number', title: null, dueAtWIB: null, timeType: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: stopNum[1], recipientUsernames: [] },
      };
    }

    // --reminder <keyword>
    const ck = text.match(/^--reminder\s+(.+)$/i);
    if (ck) {
      const keyword = ck[1].trim();
      return {
        reply: `Baik, kucek pengingat yang mengandung "${keyword}" ya.`,
        action: { type: 'cancel_keyword', title: null, dueAtWIB: null, timeType: null, repeat: 'none', repeatDetails: {}, cancelKeyword: keyword, stopNumber: null, recipientUsernames: [] },
      };
    }

    // list
    if (/^list($|\s+reminder)/i.test(text) || /tampilkan\s+reminder/i.test(text)) {
      return {
        reply: 'Ini daftar pengingat aktifmu.',
        action: { type: 'list', title: null, dueAtWIB: null, timeType: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, recipientUsernames: [] },
      };
    }

    // crude "ingatkan" path
    if (text.includes('ingatkan') || text.includes('ingetin') || text.includes('pengingat') || text.includes('reminder')) {
      // Has time?
      const relMin = text.match(/(\d+)\s*menit/i);
      const relJam = text.match(/(\d+)\s*jam/i);
      const besok = text.includes('besok');
      if (relMin || relJam) {
        const now = DateTime.now().setZone(WIB_TZ);
        let due = now;
        if (relMin) due = due.plus({ minutes: parseInt(relMin[1], 10) });
        if (relJam) due = due.plus({ hours: parseInt(relJam[1], 10) });
        return {
          reply: 'Siap, kubantu jadwalkan. Ada judulnya mau apa?',
          action: {
            type: 'need_content',
            title: null,
            dueAtWIB: due.toISO(),
            timeType: 'relative',
            repeat: 'none',
            repeatDetails: {},
            cancelKeyword: null,
            stopNumber: null,
            recipientUsernames: [],
          },
        };
      }
      if (besok) {
        return {
          reply: 'Besok jam berapa enaknya?',
          action: { type: 'need_time', title: extractTitleFallback(userText), dueAtWIB: null, timeType: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, recipientUsernames: [] },
        };
      }
      return {
        reply: 'Siap, mau diingatkan tentang apa dan jam berapa?',
        action: { type: 'potential_reminder', title: extractTitleFallback(userText), dueAtWIB: null, timeType: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, recipientUsernames: [] },
      };
    }

    // Generic friendly fallback
    return {
      reply: 'Hai! Aku bisa bantu bikin pengingat biar nggak lupa. Mau diingatkan soal apa?',
      action: { type: 'none', title: null, dueAtWIB: null, timeType: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, recipientUsernames: [] },
    };
  }
}

// ---- Optional: one-line confirm / reminder send by AI ----
async function generateReply(kind, context = {}) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const sys = `
Kamu menulis BALASAN SATU BARIS, hangat dan personal, Bahasa Indonesia casual.
- Jangan pakai template atau pola berulang.
- Maks 1-2 emoji.
- Hindari emoji di awal kalimat.
- Balasan SINGKAT, jelas, dan relevan dengan konteks.
Jenis: ${kind}
Konteks: ${JSON.stringify({ now: nowWIB.toISO(), ...context })}
Output: hanya 1 baris teks.
`;
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: 'Tulis 1 kalimat balasan sesuai konteks.' },
  ];

  try {
    const raw = await callModel(messages, 80);
    return (raw || '').trim().split('\n').join(' ');
  } catch (e) {
    // Fallback minimal
    if (kind === 'confirm') {
      const t = context?.title || 'pengingat';
      const ts = context?.timeText ? ` ${context.timeText}` : '';
      return `Siap, kuingatkan '${t}'${ts}.`;
    }
    // reminder_send
    const t = context?.title || 'pengingatmu';
    const name = context?.userName || 'kamu';
    return `Halo ${name}, ini pengingatmu untuk '${t}'.`;
  }
}

// ---- Helpers ----
function extractTitleFallback(text) {
  const t = (text || '').toLowerCase();
  const cleaned = t
    .replace(/\b(tolong|mohon|bisa|minta|please|ingetin|ingatkan|reminder|pengingat|setiap|every)\b/gi, '')
    .replace(/\b(hari|jam|menit|bulan|minggu|daily|weekly|monthly|hourly|besok|lusa|nanti)\b/gi, '')
    .replace(/\b(saya|aku|gue|gua|ane|i|me)\b/gi, '')
    .replace(/\d{1,2}[:.]\d{2}/g, '') // HH:mm
    .replace(/\d+/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length > 1);
  const title = words.slice(0, 4).join(' ');
  return title ? title[0].toUpperCase() + title.slice(1) : 'Pengingat';
}

module.exports = {
  extract,
  generateReply,
  WIB_TZ,
};
