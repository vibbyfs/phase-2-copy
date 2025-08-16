// services/ai.js
const { DateTime } = require('luxon');
const OpenAI = require('openai');

const WIB_TZ = 'Asia/Jakarta';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Enhanced AI service untuk reminder dengan parsing waktu yang fleksibel:
 * 1. Relative time
 * 2. Absolute time
 * 3. Recurring time
 */
async function extract(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);

  const systemMsg = `
Kamu adalah asisten WhatsApp yang hangat, natural, dan proaktif. Kamu ahli mendeteksi niat pembuatan reminder bahkan tanpa kata "ingatkan"/"reminder".

CURRENT TIME: ${nowWIB.toFormat('yyyy-MM-dd HH:mm:ss')} WIB (${WIB_TZ})

TUGAS: Analisis pesan dan keluarkan JSON valid **SAJA** (tanpa teks lain) dengan struktur:
{
  "intent": "create/potential_reminder/need_time/need_content/cancel/list/stop_number/cancel_keyword/cancel_all/unknown",
  "title": "judul singkat aktivitas (≤5 kata, tanpa 'pengingat'/'reminder'/'setiap')",
  "recipientUsernames": ["@username jika ada"],
  "timeType": "relative/absolute/recurring",
  "dueAtWIB": "ISO time zona ${WIB_TZ} atau null",
  "repeat": "none/hourly/daily/weekly/monthly",
  "repeatDetails": {
    "dayOfWeek": "senin/selasa/rabu/kamis/jumat/sabtu/minggu atau null",
    "timeOfDay": "HH:mm atau null",
    "dayOfMonth": "1-31 atau null"
  },
  "cancelKeyword": "string atau null",
  "stopNumber": "string atau null",
  "conversationalResponse": "respon hangat & deskriptif untuk langkah selanjutnya"
}

ATURAN INTENT & CONVERSATIONAL RESPONSE (HUMAN FRIENDLY):
- potential_reminder → "Sepertinya kamu ingin bikin pengingat [title]. Mau kujadwalkan? Jam berapa enaknya? 😊 Contoh: 'jam 20.00', '30 menit lagi', 'besok jam 9'."
- need_time (ada title, belum ada waktu) → "Baik, aku buat pengingat [title]. Jam berapa enaknya? 😊 Misal: 'jam 20.00', '1 jam lagi', 'besok jam 9'."
- need_content (ada waktu, belum ada title) → "Siap, jamnya aku catat. Pengingatnya tentang apa ya? 😊 Contoh: 'makan malam', 'minum obat', 'jemput anak'."
- create (lengkap) → "✅ Siap! Aku jadwalkan '[title]' [waktu natural]."
- unknown → "Aku bisa bantu bikin pengingat. Tulis: 'ingatkan saya <aktivitas> <waktu>'. Contoh: 'ingatkan saya makan malam jam 20.00' 😊"

ATURAN WAKTU:
- RELATIVE:
  - "5 menit/jam/detik lagi" → now + delta
  - "besok" → besok 09:00 WIB
  - "lusa" → lusa 09:00 WIB
- ABSOLUTE:
  - "jam 14:00" → hari ini 14:00 WIB
  - "pukul 2 siang" → 14:00 WIB
  - "besok jam 8" → besok 08:00 WIB
  - "Senin jam 10" → Monday 10:00 WIB berikutnya
  - "tanggal 15 jam 16:30" → tanggal 15 bulan ini 16:30 WIB
- RECURRING:
  - "setiap hari jam 8" → repeat: "daily", timeOfDay: "08:00"
  - "setiap Senin jam 9" → repeat: "weekly", dayOfWeek: "senin", timeOfDay: "09:00"
  - "setiap tanggal 1 jam 10" → repeat: "monthly", dayOfMonth: "1", timeOfDay: "10:00"
  - "setiap jam" → repeat: "hourly"

PARSING TITLE:
- Ambil aktivitas utama, hilangkan kata "pengingat/reminder/setiap/ingatkan/ingetin" dan pronoun.

PARSING USERNAME:
- Ekstrak semua @username. Jika ada, set repeat = "none".

PARSING CANCEL:
- "--reminder <keyword>" → cancel_keyword
- "stop (angka)" → stop_number
- "stop/batal semua" → cancel_all
- "stop/batal/cancel reminder" → cancel
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: `Pesan: "${message}"` }
      ],
      // HAPUS temperature: gpt-5-mini hanya terima default (1)
      max_completion_tokens: 400,
      response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty AI response');

    const parsed = JSON.parse(content);

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

    // Jika intent create tapi waktu kosong, coba fallback
    if (!result.dueAtWIB && result.intent === 'create') {
      result.dueAtWIB = fallbackTimeParser(message);
      if (!result.dueAtWIB) {
        // Jadikan need_time agar tidak salah jadwal
        result.intent = 'need_time';
        result.conversationalResponse = result.conversationalResponse ||
          `Baik, aku buat pengingat '${result.title}'. Jam berapa enaknya? 😊 Misal: "jam 20.00", "30 menit lagi".`;
      }
    }

    return result;
  } catch (error) {
    console.error('[AI] Extract error:', error);
    return fallbackParser(message);
  }
}

/**
 * Fallback parser (aman, tidak auto-create dari pesan ringan)
 */
function fallbackParser(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = message.toLowerCase();

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
  const potentialKeywords = ['nanti', 'besok', 'jemput', 'meeting', 'minum obat', 'lupa', 'semoga', 'rapat', 'penting'];
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

/**
 * Enhanced fallback time parser
 */
function fallbackTimeParser(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = message.toLowerCase();

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

  return null; // jangan paksa
}

function extractUsernames(message) {
  const usernameRegex = /@(\w+)/g;
  const matches = message.match(usernameRegex);
  return matches || [];
}

function extractTitleFromText(text) {
  const t = text.toLowerCase();
  const cleaned = t
    .replace(/\b(tolong|mohon|bisa|minta|please|ingetin|ingatkan|reminder|pengingat|setiap|every)\b/gi, '')
    .replace(/\b(hari|jam|menit|bulan|minggu|daily|weekly|monthly|hourly)\b/gi, '')
    .replace(/\b(saya|aku|gue|gua|ane|i|me)\b/gi, '')
    .replace(/\d+/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length > 2);
  const title = words.slice(0, 3).join(' ');
  return title || 'Reminder';
}

/**
 * Generate AI reply (hapus temperature)
 */
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

function getMotivationalMessage(title) {
  const lower = (title || '').toLowerCase();
  if (lower.includes('kopi') || lower.includes('coffee')) {
    const arr = [
      'Jangan lupa nikmati aromanya! ☕✨',
      'Kopi enak nggak nungguin, buruan! ☕😄',
      'Secangkir kopi biar makin semangat! ☕🌟',
      'Saatnya boost energi! ☕⚡'
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

module.exports = {
  extract,
  generateReply,
  extractTitleFromText,
  generateConversationalResponse,
  generateReminderList
};
