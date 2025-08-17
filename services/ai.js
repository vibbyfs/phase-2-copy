// /services/ai.js  (CommonJS)
'use strict';

const { DateTime } = require('luxon');
const OpenAI = require('openai');

const WIB_TZ = 'Asia/Jakarta';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/** Ambil blok JSON pertama yang valid dari teks */
function extractFirstJSONBlock(text) {
  if (!text) return null;
  // Cari blok {...} paling luar
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // Coba strategi: ambil blok dengan kurung kurawal seimbang
    let depth = 0;
    let s = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') { if (depth === 0) s = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && s !== -1) {
          const cand = text.slice(s, i + 1);
          try { return JSON.parse(cand); } catch { /* ignore */ }
        }
      }
    }
  }
  return null;
}

function titleCase(str) {
  if (!str) return '';
  return str
    .split(' ')
    .filter(Boolean)
    .map(w => w[0] ? (w[0].toUpperCase() + w.slice(1)) : w)
    .join(' ')
    .trim();
}

/** Ekstrak @username dari teks */
function extractUsernames(message) {
  const usernameRegex = /@(\w+)/g;
  const matches = message.match(usernameRegex);
  return matches || [];
}

/** Ekstrak judul sederhana dari teks (fallback non-AI) */
function extractTitleFromText(text) {
  const t = (text || '').toLowerCase();

  const cleaned = t
    .replace(/\b(tolong|mohon|bisa|minta|please|ingetin|ingatkan|reminder|pengingat|setiap|every)\b/gi, '')
    .replace(/\b(hari|jam|menit|bulan|minggu|daily|weekly|monthly|hourly|besok|lusa|nanti|siang|pagi|malam)\b/gi, '')
    .replace(/\b(saya|aku|gue|gua|ane|i|me|aku|saya)\b/gi, '')
    .replace(/\d+(:\d+)?/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length > 2);
  const title = words.slice(0, 4).join(' ');
  return title ? titleCase(title) : 'Reminder';
}

/** Parser fallback waktu sederhana */
function fallbackTimeParser(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = (message || '').toLowerCase();

  const rel = [
    { regex: /(\d+)\s*menit/i, unit: 'minutes' },
    { regex: /(\d+)\s*jam/i, unit: 'hours' },
    { regex: /(\d+)\s*detik/i, unit: 'seconds' },
    { regex: /(\d+)\s*hari/i, unit: 'days' },
  ];
  for (const p of rel) {
    const m = text.match(p.regex);
    if (m) {
      const v = parseInt(m[1], 10);
      return nowWIB.plus({ [p.unit]: v }).toISO();
    }
  }
  if (text.includes('besok')) {
    return nowWIB.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
  }
  if (text.includes('lusa')) {
    return nowWIB.plus({ days: 2 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
  }
  return nowWIB.plus({ minutes: 5 }).toISO();
}

/** Apakah teks hanya waktu (untuk bridging konteks) */
function isTimeOnly(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return false;
  const timeWords = ['menit', 'jam', 'detik', 'hari', 'besok', 'lusa', 'nanti', 'pagi', 'siang', 'sore', 'malam', 'minggu depan', 'hari ini'];
  const hasTimeWord = timeWords.some(w => t.includes(w)) || /\b(\d{1,2}([:.]\d{2})?)\b/.test(t);
  const tokens = t.split(/\s+/);
  const nonTimeTokens = tokens.filter(tok => !timeWords.includes(tok) && !/^\d{1,4}([:.]\d{2})?$/.test(tok));
  return hasTimeWord && nonTimeTokens.length <= 1;
}

/** Fallback parser full (jika AI gagal total) */
function fallbackParser(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = (message || '').toLowerCase();

  // --reminder KEYWORD
  const cancelKeywordMatch = text.match(/--reminder\s+(.+)/i);
  if (cancelKeywordMatch) {
    const key = cancelKeywordMatch[1].trim();
    return {
      intent: 'cancel_keyword',
      title: '',
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: key,
      stopNumber: null,
      conversationalResponse: `Mencari pengingat terkait '${key}'...`,
    };
  }

  // stop (No)
  const stopNumberMatch = text.match(/stop\s*\((\d+)\)/i);
  if (stopNumberMatch) {
    return {
      intent: 'stop_number',
      title: '',
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: stopNumberMatch[1],
      conversationalResponse: `Membatalkan reminder nomor ${stopNumberMatch[1]}...`,
    };
  }

  if (text.includes('stop') || text.includes('batal') || text.includes('cancel')) {
    if (text.includes('semua') || text.includes('all')) {
      return { intent: 'cancel_all', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, conversationalResponse: null };
    }
    return { intent: 'cancel', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, conversationalResponse: null };
  }

  if (text.includes('list') || text.includes('tampilkan')) {
    return { intent: 'list', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, conversationalResponse: null };
  }

  // Potential reminder tanpa kata eksplisit
  const potentialKeywords = ['nanti', 'besok', 'jemput', 'meeting', 'minum obat', 'lupa', 'semoga', 'rapat', 'penting'];
  const hasPotentialKeyword = potentialKeywords.some(k => text.includes(k));
  const hasExplicit = text.includes('ingatkan') || text.includes('reminder') || text.includes('pengingat');

  if (hasPotentialKeyword && !hasExplicit) {
    return {
      intent: 'potential_reminder',
      title: extractTitleFromText(message),
      recipientUsernames: extractUsernames(message),
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      conversationalResponse: "Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?",
    };
  }

  // Jika hanya waktu → need_content
  if (isTimeOnly(message)) {
    return {
      intent: 'need_content',
      title: '',
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: fallbackTimeParser(message),
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      conversationalResponse: "Noted jamnya! Kamu mau diingatkan tentang apa ya?",
    };
  }

  // Default: create paksa dengan +5 menit
  return {
    intent: 'create',
    title: extractTitleFromText(message),
    recipientUsernames: extractUsernames(message),
    timeType: 'relative',
    dueAtWIB: nowWIB.plus({ minutes: 5 }).toISO(),
    repeat: 'none',
    repeatDetails: {},
    cancelKeyword: null,
    stopNumber: null,
    conversationalResponse: null,
  };
}

/** ===== INTENT EXTRACTOR (pakai gpt-5-mini, tanpa temperature; gunakan max_completion_tokens) ===== */
async function extract(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);

  const systemMsg = `
Kamu asisten WhatsApp yang hangat, natural, dan proaktif. Tugasmu adalah membaca konteks pesan dan mengeluarkan JSON VALID (tanpa teks lain) sesuai skema berikut:

{
  "intent": "create/potential_reminder/need_time/need_content/cancel/cancel_all/cancel_keyword/list/stop_number/unknown",
  "title": "judul singkat aktivitas (<=5 kata, tanpa kata 'reminder/pengingat/setiap')",
  "recipientUsernames": ["array @username jika ada"],
  "timeType": "relative/absolute/recurring/null",
  "dueAtWIB": "ISO time zona Asia/Jakarta atau null",
  "repeat": "none/hourly/daily/weekly/monthly",
  "repeatDetails": {"dayOfWeek": null|"senin"...,"timeOfDay": null|"HH:mm","dayOfMonth": null|1-31},
  "cancelKeyword": null|string,
  "stopNumber": null|string,
  "conversationalResponse": null|string
}

CATATAN:
- CURRENT TIME: ${nowWIB.toFormat('yyyy-MM-dd HH:mm:ss')} WIB (Asia/Jakarta).
- Deteksi 'potential_reminder' jika kalimat menunjukkan niat tapi belum eksplisit (ex: "jemput John nanti").
- "need_time": ada judul tapi belum ada waktu → tanya waktu secara natural.
- "need_content": ada waktu tapi belum ada judul → tanya isi secara natural.
- "create": lengkap judul + waktu → langsung siap.
- Waktu relatif contoh: "1 menit lagi", "2 jam lagi".
- Waktu absolut contoh: "besok jam 14", "Senin 10.00".
- Recurring: "setiap hari jam 8" (daily), "tiap Senin 9" (weekly), "tanggal 1 jam 10" (monthly).
- Jika hanya waktu tanpa judul, set "need_content".
- Jika hanya judul tanpa waktu, set "need_time".
- Selalu output JSON valid saja, TANPA backticks, TANPA penjelasan.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: `Pesan: "${message}"` },
      ],
      // IMPORTANT: gpt-5-mini hanya menerima default temperature (1), jadi JANGAN kirim temperature/top_p.
      max_completion_tokens: 400,
    });

    const content = completion.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty AI response');

    const parsed = extractFirstJSONBlock(content);
    if (!parsed) throw new Error('JSON parse failed');

    const result = {
      intent: parsed.intent || 'unknown',
      title: parsed.title || extractTitleFromText(message),
      recipientUsernames: Array.isArray(parsed.recipientUsernames) ? parsed.recipientUsernames : extractUsernames(message),
      timeType: parsed.timeType || null,
      dueAtWIB: parsed.dueAtWIB || null,
      repeat: ['none', 'hourly', 'daily', 'weekly', 'monthly'].includes(parsed.repeat) ? parsed.repeat : 'none',
      repeatDetails: parsed.repeatDetails || {},
      cancelKeyword: parsed.cancelKeyword || null,
      stopNumber: parsed.stopNumber || null,
      conversationalResponse: parsed.conversationalResponse || null,
    };

    // Jika intent create tapi dueAt kosong → coba fallback time
    if (result.intent === 'create' && !result.dueAtWIB) {
      result.dueAtWIB = fallbackTimeParser(message);
      result.timeType = result.timeType || 'relative';
    }

    // Jika input-nya hanya waktu, tandai agar controller bisa bridging title dari sesi
    result._timeOnly = isTimeOnly(message);

    return result;
  } catch (error) {
    console.error('[AI] Extract error:', error);
    return fallbackParser(message);
  }
}

/** ===== REPLY GENERATOR: satu baris, natural; tanpa template panjang ===== */
async function generateReply(type, context = {}) {
  const sysConfirm = `Tulis satu kalimat konfirmasi yang hangat & natural untuk WhatsApp (Bahasa Indonesia). 
- Nada ramah, tidak kaku, sebut nama bila ada.
- Maksimal 1 baris. 
- Tambahkan klimaks pendek relevan (1 frasa singkat), tanpa daftar/formatting.
Contoh gaya: "✅ Siap, Rani! Aku ingatkan 'Minum Obat' jam 14.00. Semangat jaga ritme!"`;

  const sysReminder = `Tulis satu kalimat pesan reminder (Bahasa Indonesia) yang hangat & natural untuk WhatsApp.
- Format: "Halo [nama], ini pengingatmu untuk '[title]'." + klimaks pendek (maks 1 frasa) yang relevan.
- Maksimal 1 baris, tanpa emoji berlebihan, jangan kaku.`;

  const systemMsg = type === 'confirm' ? sysConfirm : sysReminder;

  const userMsg = JSON.stringify(context);

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg },
      ],
      max_completion_tokens: 80,
    });

    const out = completion.choices?.[0]?.message?.content?.trim();
    if (out) return out.replace(/\s+/g, ' ');

    // Fallback super singkat 1 baris
    if (type === 'confirm') {
      const name = context.userName || context.recipients || 'kamu';
      const timeInfo = context.timeDescription || context.relativeTime || context.dueTime || '';
      return `✅ Siap, ${name}! Aku ingatkan '${context.title}' ${timeInfo}.`;
    } else {
      const name = context.userName || 'kamu';
      return `Halo ${name}, ini pengingatmu untuk '${context.title}'.`;
    }
  } catch (error) {
    console.error('[AI] Generate reply error:', error);
    if (type === 'confirm') {
      const name = context.userName || context.recipients || 'kamu';
      const timeInfo = context.timeDescription || context.relativeTime || context.dueTime || '';
      return `✅ Siap, ${name}! Aku ingatkan '${context.title}' ${timeInfo}.`;
    } else {
      const name = context.userName || 'kamu';
      return `Halo ${name}, ini pengingatmu untuk '${context.title}'.`;
    }
  }
}

/** Conversational canned responses (tetap natural) */
function generateConversationalResponse(intent, context = {}) {
  const { title } = context;
  switch (intent) {
    case 'potential_reminder':
      return 'Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?';
    case 'need_time':
      return `Siap! Untuk '${title}', kamu mau diingatkan kapan?`;
    case 'need_content':
      return 'Noted jamnya! Kamu mau diingatkan tentang apa ya?';
    case 'time_ambiguous':
      return "Maksudnya 'nanti' itu jam berapa ya? Biar aku bisa pasin pengingatnya 😊";
    default:
      return "Aku bisa bantu bikin pengingat. Tulis: 'ingatkan saya <aktivitas> <waktu>'. Contoh: 'ingatkan saya makan malam jam 20.00' 😊";
  }
}

/** Daftar reminder bernomor untuk pembatalan */
function generateReminderList(reminders, keyword) {
  if (!reminders || reminders.length === 0) {
    return `Tidak ada pengingat aktif terkait '${keyword}' nih. Mau cek semua reminder kamu? Ketik 'list reminder' ya 😊`;
  }
  let response = `Berikut pengingat aktif terkait '${keyword}':\n`;
  reminders.forEach((r, i) => {
    const time = new Date(r.dueAt).toLocaleString('id-ID', {
      timeZone: WIB_TZ,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    response += `${i + 1}. ${r.title} - ${time}\n`;
  });
  response += `\nKirim: \`stop (${1})\` untuk membatalkan pengingat nomor 1, dst.`;
  return response;
}

module.exports = {
  extract,
  generateReply,
  extractTitleFromText,
  generateConversationalResponse,
  generateReminderList,
  fallbackTimeParser,
  isTimeOnly,
};
