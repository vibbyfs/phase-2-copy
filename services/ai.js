// services/ai.js
// Model: gpt-5-mini (tanpa temperature), gunakan max_completion_tokens
// Fitur: retry 1x bila kosong, deteksi "time-only", cegah title seperti "lagi"

const { DateTime } = require('luxon');
const OpenAI = require('openai');

const WIB_TZ = 'Asia/Jakarta';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** =========================
 *  EXTRACT (INTENT PARSER)
 *  ========================= */
async function extract(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);

  // 0) HARD GUARD: pesan waktu saja (tanpa aktivitas) → langsung need_content
  const timeOnly = detectTimeOnly(message);
  if (timeOnly) {
    return {
      intent: 'need_content',
      title: '',
      recipientUsernames: extractUsernames(message),
      timeType: timeOnly.timeType,
      dueAtWIB: timeOnly.dueAtWIB,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      conversationalResponse:
        "Siap, jamnya aku catat. Pengingatnya tentang apa ya? 😊 Contoh: 'beli kopi nescafe', 'makan malam', 'minum obat'."
    };
  }

  const systemMsg = `
Kamu adalah asisten WhatsApp yang hangat, natural, dan proaktif.

CURRENT TIME: ${nowWIB.toFormat('yyyy-MM-dd HH:mm:ss')} WIB (${WIB_TZ})

KELUARKAN **JSON VALID SAJA** (tanpa teks lain) dg struktur:
{
  "intent": "create/potential_reminder/need_time/need_content/cancel/list/stop_number/cancel_keyword/cancel_all/unknown",
  "title": "≤5 kata, tanpa 'pengingat/reminder/setiap'",
  "recipientUsernames": ["@username"],
  "timeType": "relative/absolute/recurring",
  "dueAtWIB": "ISO ${WIB_TZ} atau null",
  "repeat": "none/hourly/daily/weekly/monthly",
  "repeatDetails": {"dayOfWeek": "...", "timeOfDay":"HH:mm","dayOfMonth":"1-31"},
  "cancelKeyword": null,
  "stopNumber": null,
  "conversationalResponse": "respon hangat yang mengarahkan user dg contoh"
}

ATURAN PENTING:
- Jika user hanya memberi WAKTU (mis. "1 menit lagi", "jam 8", "besok jam 9"), JANGAN set 'create'. Set:
  intent: "need_content", dueAtWIB terisi, title: "".
- Jika ada AKTIVITAS tanpa waktu → intent: "need_time".
- 'create' hanya bila ada aktivitas + waktu valid.
- Jangan pernah mengisi title dengan kata waktu seperti "lagi", "nanti", "besok".
- 'conversationalResponse' harus memberi contoh konkret (jam 20.00, 30 menit lagi, besok jam 9).
`;

  try {
    const content = await callOpenAIForJSON(systemMsg, `Pesan: "${message}"`, 400);
    if (!content) throw new Error('Empty AI response');

    const parsed = safeParseJSON(content) || {};
    const result = {
      intent: parsed.intent || 'unknown',
      title: parsed.title || 'Reminder',
      recipientUsernames: Array.isArray(parsed.recipientUsernames) ? parsed.recipientUsernames : [],
      timeType: parsed.timeType || 'relative',
      dueAtWIB: parsed.dueAtWIB || null,
      repeat: ['none', 'hourly', 'daily', 'weekly', 'monthly'].includes(parsed.repeat) ? parsed.repeat : 'none',
      repeatDetails: parsed.repeatDetails || {},
      cancelKeyword: parsed.cancelKeyword || null,
      stopNumber: parsed.stopNumber || null,
      conversationalResponse: parsed.conversationalResponse || null
    };

    // Cegah title generik berbasis waktu (lagi/besok/dll)
    if (isGenericTimeWord(result.title)) result.title = '';

    // Kalau 'create' tapi dueAt kosong → turunkan ke need_time
    if (result.intent === 'create' && !result.dueAtWIB) {
      result.intent = 'need_time';
      result.conversationalResponse =
        result.conversationalResponse ||
        `Baik, aku buat pengingat '${result.title || 'aktivitasmu'}'. Jam berapa enaknya? 😊 Misal: "jam 20.00", "30 menit lagi".`;
    }

    return result;
  } catch (error) {
    console.error('[AI] Extract error:', error);
    return fallbackParser(message);
  }
}

/** =========== OpenAI call dengan retry 1x (tanpa temperature & tanpa response_format) =========== */
async function callOpenAIForJSON(systemMsg, userMsg, maxCompletionTokens = 400) {
  const payload = {
    model: 'gpt-5-mini',
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user', content: userMsg }
    ],
    max_completion_tokens: maxCompletionTokens
  };

  // attempt 1
  let res = await openai.chat.completions.create(payload).catch(() => null);
  let text = res?.choices?.[0]?.message?.content?.trim();
  if (text) return text;

  // attempt 2 (instruksi lebih ketat)
  const stricter = {
    ...payload,
    messages: [
      { role: 'system', content: systemMsg + '\n\nWAJIB keluarkan JSON valid saja tanpa teks lain.' },
      { role: 'user', content: userMsg }
    ]
  };
  res = await openai.chat.completions.create(stricter).catch(() => null);
  text = res?.choices?.[0]?.message?.content?.trim();
  return text || null;
}

/** =========== Fallback Parser (aman) =========== */
function fallbackParser(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = (message || '').toLowerCase();

  // --reminder <keyword>
  const cancelKeywordMatch = text.match(/--reminder\s+(.+)/i);
  if (cancelKeywordMatch) {
    return {
      intent: 'cancel_keyword',
      title: '',
      recipientUsernames: [],
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: cancelKeywordMatch[1].trim(),
      stopNumber: null,
      conversationalResponse: `Mencari pengingat terkait '${cancelKeywordMatch[1].trim()}'...`
    };
  }

  // stop (n)
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
      conversationalResponse: `Membatalkan reminder nomor ${stopNumberMatch[1]}...`
    };
  }

  // cancel/cancel all
  if (/\b(stop|batal|cancel)\b/i.test(text)) {
    if (/\b(semua|all)\b/i.test(text)) {
      return { intent: 'cancel_all', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, conversationalResponse: null };
    }
    return { intent: 'cancel', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, conversationalResponse: null };
  }

  if (/\b(list|tampilkan)\b/i.test(text)) {
    return { intent: 'list', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, conversationalResponse: null };
  }

  // Deteksi kemungkinan reminder
  const potentialKeywords = ['nanti', 'besok', 'jemput', 'meeting', 'minum obat', 'lupa', 'semoga', 'rapat', 'penting', 'makan', 'beli', 'kopi'];
  const hasPotentialKeyword = potentialKeywords.some(k => text.includes(k));
  const hasExplicitKeyword = /\b(ingatkan|ingetin|reminder|pengingat)\b/i.test(text);

  // Parse waktu
  let dueAtWIB = null;
  let repeat = 'none';
  let timeType = 'relative';
  const repeatDetails = {};

  const minuteMatch = text.match(/(\d+)\s*menit/i);
  const hourMatch = text.match(/(\d+)\s*jam\b/i);
  const secondMatch = text.match(/(\d+)\s*detik/i);
  const dayMatch = text.match(/(\d+)\s*hari/i);

  if (minuteMatch) {
    dueAtWIB = nowWIB.plus({ minutes: parseInt(minuteMatch[1], 10) }).toISO();
  } else if (hourMatch) {
    dueAtWIB = nowWIB.plus({ hours: parseInt(hourMatch[1], 10) }).toISO();
  } else if (secondMatch) {
    dueAtWIB = nowWIB.plus({ seconds: parseInt(secondMatch[1], 10) }).toISO();
  } else if (dayMatch) {
    dueAtWIB = nowWIB.plus({ days: parseInt(dayMatch[1], 10) }).toISO();
  } else if (text.includes('besok')) {
    timeType = 'absolute';
    dueAtWIB = nowWIB.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
  } else if (text.includes('lusa')) {
    timeType = 'absolute';
    dueAtWIB = nowWIB.plus({ days: 2 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
  }

  // Recurring
  if (text.includes('setiap')) {
    timeType = 'recurring';
    if (text.includes('jam') && !text.includes('hari') && !text.includes('minggu') && !text.includes('bulan')) {
      repeat = 'hourly';
    } else if (text.includes('hari')) {
      repeat = 'daily';
      const timeMatch = text.match(/jam\s*(\d{1,2})(?:[:.](\d{2}))?/i);
      if (timeMatch) {
        const hh = timeMatch[1].padStart(2, '0');
        const mm = timeMatch[2] ? timeMatch[2].padStart(2, '0') : '00';
        repeatDetails.timeOfDay = `${hh}:${mm}`;
        dueAtWIB = nowWIB.plus({ days: 1 }).set({ hour: parseInt(hh, 10), minute: parseInt(mm, 10), second: 0 }).toISO();
      }
    } else if (text.includes('minggu')) {
      repeat = 'weekly';
    } else if (text.includes('bulan')) {
      repeat = 'monthly';
    }
  }

  const hasAnyTimeSignal =
    minuteMatch || hourMatch || secondMatch || dayMatch ||
    text.includes('besok') || text.includes('lusa') ||
    /jam\s*\d{1,2}/i.test(text);

  const title = extractTitleFromText(message);
  const hasContentInfo = title && title !== 'Reminder' && title.length > 0;

  // Pesan ringan → jangan create
  if (!hasAnyTimeSignal && !hasExplicitKeyword) {
    return {
      intent: hasPotentialKeyword ? 'potential_reminder' : 'unknown',
      title,
      recipientUsernames: extractUsernames(message),
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      conversationalResponse: hasPotentialKeyword
        ? "Sepertinya kamu ingin bikin pengingat itu. Jam berapa enaknya? 😊 Contoh: 'jam 20.00', '30 menit lagi'."
        : "Aku bisa bantu bikin pengingat. Tulis: 'ingatkan saya <aktivitas> <waktu>'. Contoh: 'ingatkan saya makan malam jam 20.00' 😊"
    };
  }

  // Eksplisit ingin diingatkan tapi belum ada jam → need_time
  if (hasExplicitKeyword && hasContentInfo && !hasAnyTimeSignal) {
    return {
      intent: 'need_time',
      title,
      recipientUsernames: extractUsernames(message),
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      conversationalResponse: `Baik, aku buat pengingat *${title}*. Jam berapa enaknya? 😊 Misal: "jam 20.00", "1 jam lagi".`
    };
  }

  // Ada waktu tapi belum ada konten → need_content
  if (hasAnyTimeSignal && !hasContentInfo) {
    return {
      intent: 'need_content',
      title: '',
      recipientUsernames: extractUsernames(message),
      timeType,
      dueAtWIB,
      repeat,
      repeatDetails,
      cancelKeyword: null,
      stopNumber: null,
      conversationalResponse: "Siap, jamnya aku catat. Pengingatnya tentang apa ya? 😊"
    };
  }

  // Create hanya jika dueAtWIB valid
  if (!dueAtWIB) {
    return {
      intent: 'need_time',
      title,
      recipientUsernames: extractUsernames(message),
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      conversationalResponse: `Baik, aku buat pengingat *${title}*. Jam berapa enaknya? 😊`
    };
  }

  return {
    intent: 'create',
    title,
    recipientUsernames: extractUsernames(message),
    timeType,
    dueAtWIB,
    repeat,
    repeatDetails,
    cancelKeyword: null,
    stopNumber: null,
    conversationalResponse: null
  };
}

/** =========== Waktu: fallback ringan =========== */
function fallbackTimeParser(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = (message || '').toLowerCase();
  const patterns = [
    { regex: /(\d+)\s*menit/i, unit: 'minutes' },
    { regex: /(\d+)\s*jam\b/i, unit: 'hours' },
    { regex: /(\d+)\s*detik/i, unit: 'seconds' },
    { regex: /(\d+)\s*hari/i, unit: 'days' }
  ];
  for (const p of patterns) {
    const m = text.match(p.regex);
    if (m) return nowWIB.plus({ [p.unit]: parseInt(m[1], 10) }).toISO();
  }
  if (text.includes('besok')) {
    return nowWIB.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
  }
  return null;
}

/** =========== Ekstraksi lain =========== */
function extractUsernames(message) {
  const usernameRegex = /@(\w+)/g;
  const matches = message.match(usernameRegex);
  return matches || [];
}

function extractTitleFromText(text) {
  const t = (text || '').toLowerCase();
  const cleaned = t
    .replace(/\b(tolong|mohon|bisa|minta|please|ingetin|ingatkan|reminder|pengingat|setiap|every)\b/gi, '')
    .replace(/\b(hari|jam|menit|bulan|minggu|daily|weekly|monthly|hourly|besok|lusa|nanti|lagi|pukul)\b/gi, '')
    .replace(/\b(saya|aku|gue|gua|ane|i|me)\b/gi, '')
    .replace(/\d+/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length > 2);
  const title = words.slice(0, 5).join(' ');
  return title || 'Reminder';
}

/** =========== Generate balasan =========== */
async function generateReply(type, context = {}) {
  const systemMsg = type === 'confirm'
    ? `Kamu asisten WhatsApp yang ramah & personal. Buat konfirmasi reminder yang hangat (Bahasa Indonesia), ringkas, natural, dengan emoji kontekstual.`
    : `Kamu asisten WhatsApp yang ramah & komunikatif. Buat pesan reminder yang natural & personal (Bahasa Indonesia), dengan motivasi ringan dan emoji kontekstual.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: JSON.stringify(context) }
      ],
      max_completion_tokens: 150
    });

    const aiResponse = completion.choices[0]?.message?.content?.trim();
    if (aiResponse && aiResponse.length > 10) return aiResponse;

    // Fallback templates
    if (type === 'confirm') {
      const name = context.userName || context.recipients || 'kamu';
      const timeInfo = context.timeType === 'relative'
        ? `${context.relativeTime}`
        : `pada ${context.dueTime}`;
      return `✅ Siap, ${name}! Aku akan ingatkan kamu untuk '${context.title}' ${timeInfo}. ${getMotivationalMessage(context.title)} 😊`;
    } else {
      const name = context.userName || 'kamu';
      if (context.isForFriend) {
        const senderName = context.senderName || context.senderUsername || 'temanmu';
        return `Halo ${name}! Ada reminder dari ${senderName}: ini pengingatmu untuk '${context.title}'. ${getMotivationalMessage(context.title)} ✨🙏`;
      }
      return `Halo ${name}, ini pengingatmu untuk '${context.title}'. ${getMotivationalMessage(context.title)} ✨🙏`;
    }
  } catch (error) {
    console.error('[AI] Generate reply error:', error);
    if (type === 'confirm') {
      const name = context.userName || context.recipients || 'kamu';
      return `✅ Siap, ${name}! Pengingat '${context.title}' sudah dijadwalkan. Aku akan ingetin kamu tepat waktu! 😊`;
    } else {
      const name = context.userName || 'kamu';
      if (context.isForFriend) {
        const senderName = context.senderName || context.senderUsername || 'temanmu';
        return `Halo ${name}! Ada reminder dari ${senderName}: ini pengingatmu untuk '${context.title}'. ${getMotivationalMessage(context.title)} ✨🙏`;
      }
      return `Halo ${name}, ini pengingatmu untuk '${context.title}'. ${getMotivationalMessage(context.title)} ✨🙏`;
    }
  }
}

/** =========== Conversational builder opsional =========== */
function generateConversationalResponse(intent, context = {}) {
  const { title, userName, cancelKeyword, stopNumber, timeInfo } = context;
  const name = userName || 'kamu';
  switch (intent) {
    case 'potential_reminder':
      return "Sepertinya kamu ingin bikin pengingat itu. Jam berapa enaknya? 😊 Contoh: 'jam 20.00', '30 menit lagi'.";
    case 'need_time':
      return `Baik, untuk '${title}', jam berapa enaknya? 😊`;
    case 'need_content':
      return "Siap jamnya! Pengingatnya tentang apa ya? 😊";
    case 'create':
      return `✅ Siap, ${name}! Aku akan ingatkan kamu untuk '${title}' ${timeInfo}. 😊`;
    case 'cancel_keyword':
      return `Kirim: \`--reminder ${cancelKeyword}\` untuk melihat & batalkan yang terkait.`;
    case 'time_ambiguous':
      return "Maksudnya 'nanti' itu jam berapa ya? 😊";
    case 'time_passed':
      return "Waktunya sudah lewat 😅 Mau dijadwalkan ulang?";
    case 'user_cancelled':
      return "Oke, pengingatnya aku batalin ya 😊";
    case 'stop_success':
      return `✅ Reminder nomor ${stopNumber} dibatalkan. Perlu set pengingat baru? 😊`;
    case 'stop_invalid':
      return "Nomornya belum cocok 😅 Coba cek daftar reminder ya.";
    case 'missing_time':
      return "Aku belum dapat jamnya. Kamu mau diingatkan jam berapa?";
    default:
      return "Aku bisa bantu bikin pengingat. Tulis: 'ingatkan saya <aktivitas> <waktu>' ya 😊";
  }
}

/** =========== Reminder list =========== */
function generateReminderList(reminders, keyword) {
  if (!reminders || reminders.length === 0) {
    return `Tidak ada pengingat aktif terkait '${keyword}'. Ketik 'list reminder' untuk semua ya 😊`;
  }
  let response = `Berikut pengingat aktif terkait '${keyword}':\n`;
  reminders.forEach((r, i) => {
    const time = new Date(r.dueAt).toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
    response += `${i + 1}. ${r.title} - ${time}\n`;
  });
  response += `\nKetik: \`stop (1)\` untuk membatalkan nomor 1, dst.`;
  return response;
}

/** =========== Motivasi kontekstual =========== */
function getMotivationalMessage(title) {
  const lower = (title || '').toLowerCase();
  if (lower.includes('kopi') || lower.includes('nescafe') || lower.includes('coffee')) {
    const arr = [
      'Saatnya seduh favoritmu! ☕✨',
      'Kopi enak nggak nungguin—gas! ☕😄',
      'Biar makin semangat dengan secangkir kopi! ☕🌟',
      'Waktunya boost energi! ☕⚡'
    ];
    return arr[Math.floor(Math.random() * arr.length)];
  }
  if (lower.includes('olahraga') || lower.includes('gym') || lower.includes('workout') || lower.includes('lari')) {
    const arr = [
      'Semangat jaga kesehatan! 💪🌅',
      'Tubuh sehat, pikiran fresh! 💪😊',
      "Let's go, jangan sampai skip! 💪🔥",
      'Sehat itu investasi terbaik! 💪✨'
    ];
    return arr[Math.floor(Math.random() * arr.length)];
  }
  if (lower.includes('meeting') || lower.includes('rapat') || lower.includes('kerja')) {
    const arr = [
      'Jangan sampai telat ya! 📅⏰',
      'Sukses untuk meetingnya! 📋✨',
      'Tampil maksimal yuk! 💼🌟',
      'Good luck! 🤝😊'
    ];
    return arr[Math.floor(Math.random() * arr.length)];
  }
  if (lower.includes('pulang') || lower.includes('pergi') || lower.includes('berangkat')) {
    const arr = [
      'Jangan lupa barang-barangmu! 👜😊',
      'Hati-hati di jalan! 🚗💙',
      'Semoga lancar perjalanannya! 🛣️✨',
      'Jangan sampai ketinggalan! ⏰🚶‍♀️'
    ];
    return arr[Math.floor(Math.random() * arr.length)];
  }
  if (lower.includes('makan') || lower.includes('sarapan') || lower.includes('minum') || lower.includes('beli')) {
    const arr = [
      'Tubuh butuh nutrisi! 🍽️😊',
      'Isi energi biar tetap prima! 🍽️⚡',
      'Pilih yang sehat ya! 🥗✨',
      'Jangan skip meal ya! 🍽️😊'
    ];
    return arr[Math.floor(Math.random() * arr.length)];
  }
  if (lower.includes('istirahat') || lower.includes('tidur') || lower.includes('break')) {
    const arr = [
      'Tubuh butuh istirahat cukup! 😴💤',
      'Recharge energy ya! 🔋😊',
      'Self-care itu penting! 💆‍♀️✨',
      'Rest well! 🌙💫'
    ];
    return arr[Math.floor(Math.random() * arr.length)];
  }
  const arr = [
    'Semangat menjalani hari! 🌟😊',
    'Kamu pasti bisa! 💪✨',
    'Jangan lupa ya! 😊🎯',
    'Keep going, you got this! 🚀💫',
    'Gas terus! 🔥😄'
  ];
  return arr[Math.floor(Math.random() * arr.length)];
}

/** =========== Helpers khusus extract =========== */
function detectTimeOnly(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = (message || '').toLowerCase();

  const m = text.match(/(\d+)\s*menit/i);
  const h = text.match(/(\d+)\s*jam\b/i);
  const s = text.match(/(\d+)\s*detik/i);
  const d = text.match(/(\d+)\s*hari/i);
  const hhmm = text.match(/\bjam\s*(\d{1,2})(?:[:.](\d{2}))?\b/i);
  const besok = text.includes('besok');
  const lusa = text.includes('lusa');

  // Jika ada indikasi aktivitas, bukan time-only
  const activityHints = /(makan|minum|beli|jemput|meeting|rapat|obat|olahraga|kopi|nescafe)/i;
  if (activityHints.test(text)) return null;

  let dueAtWIB = null;
  let timeType = 'relative';

  if (m) dueAtWIB = nowWIB.plus({ minutes: parseInt(m[1], 10) }).toISO();
  else if (h) dueAtWIB = nowWIB.plus({ hours: parseInt(h[1], 10) }).toISO();
  else if (s) dueAtWIB = nowWIB.plus({ seconds: parseInt(s[1], 10) }).toISO();
  else if (d) dueAtWIB = nowWIB.plus({ days: parseInt(d[1], 10) }).toISO();
  else if (hhmm) {
    const hh = parseInt(hhmm[1], 10);
    const mm = hhmm[2] ? parseInt(hhmm[2], 10) : 0;
    dueAtWIB = nowWIB.set({ hour: hh, minute: mm, second: 0 }).toISO();
    timeType = 'absolute';
  } else if (besok) {
    dueAtWIB = nowWIB.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
    timeType = 'absolute';
  } else if (lusa) {
    dueAtWIB = nowWIB.plus({ days: 2 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
    timeType = 'absolute';
  }

  if (!dueAtWIB) return null;
  return { dueAtWIB, timeType };
}

function isGenericTimeWord(title) {
  if (!title) return true;
  const t = title.trim().toLowerCase();
  const stop = new Set([
    'lagi','nanti','besok','lusa','hari','jam','menit','detik','pukul','sekarang',
    'week','minggu','bulan','hari ini','malam','siang','pagi'
  ]);
  if (stop.has(t)) return true;
  if (/^\d+$/.test(t)) return true;   // angka doang
  if (t.length <= 3) return true;     // 1-kata pendek generik
  return false;
}

module.exports = {
  extract,
  generateReply,
  extractTitleFromText,
  generateConversationalResponse,
  generateReminderList
};
  