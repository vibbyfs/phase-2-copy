// services/ai.js (CommonJS) — OpenAI gpt-5-mini, guard-rail sapaan & waktu
'use strict';

const { DateTime } = require('luxon');
const OpenAI = require('openai');

const WIB_TZ = 'Asia/Jakarta';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** ===== Util ===== */
const GREET_WORDS = [
  'halo','hai','hey','hi','hello','hola','pagi','siang','sore','malam','oi','yo','hay'
];

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function isGreeting(raw) {
  const t = normalize(raw);
  if (!t) return false;
  const words = t.split(' ');
  if (words.length > 3) return false; // sapaan biasanya singkat
  const score = words.reduce((s,w)=> s + (GREET_WORDS.includes(w)?1:0), 0);
  return score >= Math.max(1, Math.ceil(words.length/2));
}

function hasTimeCue(raw) {
  const t = normalize(raw);
  if (!t) return false;
  const cues = [
    /\b(\d+)\s*menit\b/,
    /\b(\d+)\s*jam\b/,
    /\b(\d+)\s*detik\b/,
    /\b(besok|lusa)\b/,
    /\b(senin|selasa|rabu|kamis|jumat|sabtu|minggu)\b/,
    /\b(jam|pukul)\s*\d{1,2}([:\.]\d{2})?\b/,
    /\b\d{1,2}[:\.]\d{2}\b/
  ];
  return cues.some(r => r.test(t));
}

function extractFirstJSONBlock(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try { return JSON.parse(slice); } catch {}
  let depth = 0, s = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { if (depth === 0) s = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && s !== -1) {
      const cand = text.slice(s, i + 1);
      try { return JSON.parse(cand); } catch {}
    }}
  }
  return null;
}

function titleCase(str) {
  if (!str) return '';
  return str.split(' ')
    .filter(Boolean)
    .map(w => w[0] ? (w[0].toUpperCase() + w.slice(1)) : w)
    .join(' ')
    .trim();
}

function extractTitleFromText(text) {
  const t = (text || '').toLowerCase();
  const cleaned = t
    .replace(/\b(tolong|mohon|bisa|minta|please|ingetin|ingatkan|reminder|pengingat|setiap|every)\b/gi, '')
    .replace(/\b(hari|jam|menit|bulan|minggu|daily|weekly|monthly|hourly|besok|lusa|nanti|siang|pagi|malam)\b/gi, '')
    .replace(/\b(saya|aku|gue|gua|ane|i|me)\b/gi, '')
    .replace(/\d+(:\d+)?/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length > 2 && !GREET_WORDS.includes(w));
  const title = words.slice(0, 5).join(' ');
  return title ? titleCase(title) : 'Reminder';
}

function fallbackTimeParser(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = (message || '').toLowerCase();
  let m;

  if ((m = text.match(/(\d+)\s*detik(?:\s*lagi)?/i)))
    return { timeType: 'relative', dueAtWIB: nowWIB.plus({ seconds: +m[1] }).toISO(), ok: true };
  if ((m = text.match(/(\d+)\s*menit(?:\s*lagi)?/i)))
    return { timeType: 'relative', dueAtWIB: nowWIB.plus({ minutes: +m[1] }).toISO(), ok: true };
  if ((m = text.match(/(\d+)\s*jam(?:\s*lagi)?/i)))
    return { timeType: 'relative', dueAtWIB: nowWIB.plus({ hours: +m[1] }).toISO(), ok: true };

  const timePat = /(?:jam|pukul)?\s*(\d{1,2})(?::|\.?)(\d{2})?/i;
  if (text.includes('besok')) {
    const base = nowWIB.plus({ days: 1 }).startOf('day');
    const mt = text.match(timePat);
    const hour = mt ? Math.min(23, Math.max(0, +mt[1])) : 9;
    const minute = mt && mt[2] ? Math.min(59, Math.max(0, +mt[2])) : 0;
    return { timeType: 'absolute', dueAtWIB: base.set({ hour, minute }).toISO(), ok: true };
  }
  if (text.includes('lusa')) {
    const base = nowWIB.plus({ days: 2 }).startOf('day');
    const mt = text.match(timePat);
    const hour = mt ? Math.min(23, Math.max(0, +mt[1])) : 9;
    const minute = mt && mt[2] ? Math.min(59, Math.max(0, +mt[2])) : 0;
    return { timeType: 'absolute', dueAtWIB: base.set({ hour, minute }).toISO(), ok: true };
  }

  if ((m = text.match(/\b(\d{1,2})[:\.](\d{2})\b/))) {
    const h = Math.min(23, Math.max(0, +m[1]));
    const mm = Math.min(59, Math.max(0, +m[2]));
    let dt = nowWIB.set({ hour: h, minute: mm, second: 0, millisecond: 0 });
    if (dt <= nowWIB) dt = dt.plus({ days: 1 });
    return { timeType: 'absolute', dueAtWIB: dt.toISO(), ok: true };
  }

  return { ok: false };
}

async function callLLM(systemText, userText, maxTokens = 500) {
  const r = await openai.responses.create({
    model: MODEL,
    input: [
      { role: 'system', content: [{ type: 'text', text: systemText }] },
      { role: 'user',   content: [{ type: 'text', text: userText }] },
    ],
    max_output_tokens: maxTokens,
  });
  return r.output_text;
}

/** ===== Main: Extract ===== */
async function extract(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);

  // Hard guard: sapaan → langsung conversational
  if (isGreeting(message)) {
    return {
      intent: 'unknown',
      title: 'Reminder',
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      conversationalResponse:
        'Hai! Semoga harimu menyenangkan 😊 Aku bisa bantu bikin pengingat biar nggak lupa. Mau buat pengingat untuk sesuatu?',
    };
  }

  // Hard guard: perintah cancel/list via regex (tanpa LLM)
  const lower = normalize(message);
  const mStop = lower.match(/^stop\s*\(\s*(\d+)\s*\)$/i);
  if (mStop) {
    return {
      intent: 'stop_number',
      title: null,
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: +mStop[1],
      conversationalResponse: null,
    };
  }
  const mKey = lower.match(/^--reminder\s+(.+)$/i);
  if (mKey) {
    return {
      intent: 'cancel_keyword',
      title: null,
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: mKey[1].trim(),
      stopNumber: null,
      conversationalResponse: null,
    };
  }

  // Fallback parser cepat
  const prelim = fallbackTimeParser(message);
  const prelimTitle = extractTitleFromText(message);
  let guessIntent = 'unknown';
  if (prelim.ok && prelimTitle && prelimTitle !== 'Reminder') {
    guessIntent = 'create';
  } else if (!prelim.ok && prelimTitle && prelimTitle !== 'Reminder') {
    guessIntent = hasTimeCue(message) ? 'create' : 'need_time';
  }

  // LLM
  const system = `
Kamu asisten pribadi WhatsApp yang hangat. Deteksi intent reminder.
Balas HANYA JSON valid:

{
  "intent": "create|potential_reminder|need_time|need_content|cancel|cancel_all|stop_number|cancel_keyword|list|unknown",
  "title": "judul singkat (≤5 kata, tanpa 'reminder/pengingat')",
  "recipientUsernames": [],
  "timeType": "relative|absolute|recurring",
  "dueAtWIB": "ISO Asia/Jakarta atau null",
  "repeat": "none|hourly|daily|weekly|monthly",
  "repeatDetails": { "dayOfWeek": null, "timeOfDay": null, "dayOfMonth": null },
  "cancelKeyword": null,
  "stopNumber": null,
  "conversationalResponse": "1-2 kalimat hangat, BI"
}

Aturan:
- "need_time" jika ada aktivitas tapi belum ada waktu.
- "need_content" jika ada waktu tapi belum ada aktivitas.
- "potential_reminder" untuk kalimat yang berpotensi jadi reminder.
- Jangan gunakan temperature custom. Pastikan JSON tunggal.
CURRENT_TIME_WIB=${nowWIB.toFormat('yyyy-MM-dd HH:mm:ss')}.
`;
  let parsed = null;
  try {
    const out = await callLLM(system, message, 500);
    parsed = extractFirstJSONBlock(out);
  } catch (e) {
    console.error('[AI] Extract error:', e);
  }

  // Normalisasi & guard-rail
  const result = {
    intent: parsed?.intent || guessIntent,
    title: (parsed?.title || prelimTitle || 'Reminder').trim(),
    recipientUsernames: Array.isArray(parsed?.recipientUsernames) ? parsed.recipientUsernames : [],
    timeType: parsed?.timeType || (prelim.ok ? prelim.timeType : 'relative'),
    dueAtWIB: parsed?.dueAtWIB || (prelim.ok ? prelim.dueAtWIB : null),
    repeat: parsed?.repeat || 'none',
    repeatDetails: parsed?.repeatDetails || {},
    cancelKeyword: parsed?.cancelKeyword || null,
    stopNumber: parsed?.stopNumber || null,
    conversationalResponse: parsed?.conversationalResponse || null,
  };

  // Jika tidak ada sinyal waktu & intent create → turunkan ke need_time atau unknown
  if (result.intent === 'create' && !result.dueAtWIB && !hasTimeCue(message)) {
    if (result.title && result.title !== 'Reminder') {
      result.intent = 'need_time';
      result.conversationalResponse =
        `Siap! Untuk “${result.title}”, kamu mau diingatkan kapan? 😊`;
    } else {
      result.intent = 'unknown';
      result.conversationalResponse =
        'Aku bisa bantu bikin pengingat biar makin teratur 😊 Mau buat pengingat untuk sesuatu?';
    }
  }

  // Jika judul cuma sapaan, jangan dijadikan konten reminder
  if (GREET_WORDS.includes(normalize(result.title))) {
    result.title = 'Reminder';
    if (result.intent === 'create') {
      result.intent = 'need_content';
      result.conversationalResponse = 'Noted jamnya! Kamu mau diingatkan tentang apa ya?';
    }
  }

  // Jika tidak ada judul berarti perlu konten
  if (result.intent === 'create' && (!result.title || result.title === 'Reminder')) {
    result.intent = 'need_content';
    result.conversationalResponse = 'Noted jamnya! Kamu mau diingatkan tentang apa ya?';
  }

  // Jika tidak ada waktu tapi ada judul, tetap minta jamnya
  if ((result.intent === 'unknown' || result.intent === 'potential_reminder') &&
      result.title && result.title !== 'Reminder' && !result.dueAtWIB) {
    result.intent = 'need_time';
    result.conversationalResponse =
      `Baik, untuk “${result.title}” mau diingatkan kapan ya? 😊`;
  }

  // Fallback final
  if (!result.conversationalResponse && result.intent === 'unknown') {
    result.conversationalResponse =
      'Semangat ya! Aku bisa bantu bikin pengingat biar nggak lupa 😊 Mau bikin pengingat sekarang?';
  }

  return result;
}

/** ===== One-liner friendly generator (tanpa emoji di awal) ===== */
async function generateReply(kind, context = {}) {
  const { title = 'pengingat', userName = 'kamu', whenText = '' } = context;
  const system = `
Tulis 1 kalimat (≤140 karakter), tone hangat non-formal, Bahasa Indonesia.
JANGAN memulai dengan emoji atau "✅".
Boleh 1-2 emoji di akhir/pertengahan. Hindari berlebihan.
Kalimat harus natural, sebut aktivitas dan/atau waktu secukupnya.`;
  const user = `kind=${kind}; nama=${userName}; judul="${title}"; waktu="${whenText}".`;
  try {
    const out = await callLLM(system, user, 80);
    return (out || '').split('\n')[0].trim();
  } catch {
    return `Siap, ${userName}! Pengingat "${title}" dijadwalkan ${whenText}.`;
  }
}

module.exports = {
  extract,
  generateReply,
  extractTitleFromText,
};
