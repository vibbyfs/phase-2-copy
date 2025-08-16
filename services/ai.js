const { DateTime } = require('luxon');
const OpenAI = require('openai');

const WIB_TZ = 'Asia/Jakarta';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Enhanced AI service untuk reminder dengan parsing waktu yang fleksibel:
 * 1. Relative time: "in 52 minutes", "2 hours later", "tomorrow"
 * 2. Absolute time: "at 2 PM", "Monday 9 AM", "2025-08-12T14:00:00"
 * 3. Recurring time: "daily at 8 AM", "weekly on Monday", "monthly on 1st"
 */

async function extract(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  
  const systemMsg = `
Kamu adalah asisten pribadi WhatsApp yang hangat dan natural. Kamu ahli mendeteksi niat pembuatan reminder bahkan tanpa kata eksplisit "ingatkan" atau "reminder".

CURRENT TIME: ${nowWIB.toFormat('yyyy-MM-dd HH:mm:ss')} WIB (${WIB_TZ})

TUGAS: Analisis pesan dan keluarkan JSON dengan struktur:
{
  "intent": "create/potential_reminder/need_time/need_content/cancel/list/stop_number/cancel_keyword/unknown",
  "title": "judul singkat aktivitas (≤5 kata, tanpa 'pengingat'/'reminder'/'setiap')",
  "recipientUsernames": ["array @username jika ada"],
  "timeType": "relative/absolute/recurring",
  "dueAtWIB": "waktu ISO format zona ${WIB_TZ}",
  "repeat": "none/hourly/daily/weekly/monthly",
  "repeatDetails": {
    "dayOfWeek": "senin/selasa/rabu/kamis/jumat/sabtu/minggu atau null", 
    "timeOfDay": "HH:mm format atau null",
    "dayOfMonth": "1-31 atau null untuk monthly"
  },
  "cancelKeyword": "keyword untuk cancel reminder tertentu",
  "stopNumber": "nomor untuk stop (1), stop (2), dll",
  "conversationalResponse": "respons hangat dan personal sesuai intent"
}

DETECTION RULES - INTENT:

1. INTENT "potential_reminder" - Deteksi kalimat yang BERPOTENSI reminder tanpa kata eksplisit:
   Kalimat perintah: "jemput John nanti", "meeting jam 3", "minum obat sore"
   Kalimat reflektif: "aku suka lupa minum air", "besok ada rapat penting"  
   Kalimat harapan: "semoga aku nggak lupa jemput John"
   
   Respons: "Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?"

2. INTENT "need_time" - Ada aktivitas tapi belum ada waktu:
   "ingatkan saya minum obat" (ada title, belum ada time)
   Respons: "Siap! Untuk '[title]', kamu mau diingatkan kapan?"

3. INTENT "need_content" - Ada waktu tapi belum ada aktivitas:
   "ingatkan saya jam 3" (ada time, belum ada title)
   Respons: "Noted jamnya! Kamu mau diingatkan tentang apa ya?"

4. INTENT "create" - Lengkap ada title dan waktu:
   "ingatkan saya minum obat jam 3"
   Respons: "✅ Siap, [username]! Aku akan ingatkan kamu untuk '[title]' [waktu]. 😊"

5. INTENT "cancel_keyword" - Format "--reminder [keyword]":
   "--reminder makan" 
   Respons: List reminder yang cocok dengan keyword

6. INTENT "stop_number" - Format "stop (angka)":
   "stop (1)", "stop (2)"
   Respons: Batalkan reminder nomor tersebut dan konfirmasi

7. INTENT "list" - Minta lihat daftar:
   "list reminder", "tampilkan pengingat"

8. PARSING RULES - WAKTU:

1. RELATIVE TIME (timeType: "relative"):
   Hitung dari waktu sekarang (${nowWIB.toFormat('yyyy-MM-dd HH:mm:ss')} WIB):
   - "5 menit lagi" → +5 minutes
   - "2 jam lagi" → +2 hours  
   - "30 detik lagi" → +30 seconds
   - "besok" → tomorrow 9 AM
   - "lusa" → day after tomorrow 9 AM
   - "minggu depan" → next week same day
   
   Contoh: "52 menit lagi" → dueAtWIB: "${nowWIB.plus({minutes: 52}).toISO()}"

2. ABSOLUTE TIME (timeType: "absolute"):
   Waktu spesifik:
   - "jam 14:00" → today 14:00 WIB
   - "pukul 2 siang" → today 14:00 WIB  
   - "jam 9 pagi" → today 09:00 WIB
   - "besok jam 8" → tomorrow 08:00 WIB
   - "Senin jam 10" → next Monday 10:00 WIB
   - "tanggal 15 jam 16:30" → this month 15th 16:30 WIB
   
   EXAMPLES DARI INSTRUKSI:
   - "1 menit lagi" → "Siap! Aku akan ingatkan kamu 1 menit dari sekarang 😊"
   - "15 menit lagi" → "Noted! Reminder akan dikirim 15 menit dari sekarang"
   - "besok" → "Besok jam berapa ya kamu mau diingatkan?"
   - "besok jam 2 siang" → "✅ Reminder dijadwalkan besok jam 14.00"
   - "rabu minggu depan jam 3" → "Reminder akan dikirim Rabu minggu depan jam 15.00"
   
   Format: "YYYY-MM-DDTHH:mm:ss+07:00"

3. RECURRING TIME (timeType: "recurring"):
   Jadwal berulang dengan detail:
   - "setiap hari jam 8" → repeat: "daily", repeatDetails: {"timeOfDay": "08:00"}
   - "setiap Senin jam 9" → repeat: "weekly", repeatDetails: {"dayOfWeek": "senin", "timeOfDay": "09:00"}
   - "setiap tanggal 1 jam 10" → repeat: "monthly", repeatDetails: {"dayOfMonth": "1", "timeOfDay": "10:00"}
   - "setiap jam" → repeat: "hourly", repeatDetails: {"timeOfDay": null}

PARSING RULES - REPEAT:
- "setiap jam" → "hourly"
- "setiap hari"/"daily"/"harian" → "daily"
- "setiap minggu"/"weekly"/"mingguan" → "weekly"
- "setiap bulan"/"monthly"/"bulanan" → "monthly"
- default → "none"

PARSING RULES - TITLE:
Ekstrak aktivitas utama, hilangkan kata: "pengingat", "reminder", "setiap", "ingatkan", "ingetin"
- "ingetin saya minum air putih" → "Minum Air Putih"
- "reminder meeting zoom setiap hari" → "Meeting Zoom"
- "setiap pagi olahraga" → "Olahraga"

PARSING RULES - USERNAME:
- Ekstrak semua @username: "@john meeting besok" → recipientUsernames: ["@john"]
- Jika ada @username, set repeat: "none" (reminder sekali saja)

PARSING RULES - CANCEL:
- "stop/batal/cancel reminder" → intent: "cancel"
- "stop/batal semua" → intent: "cancel_all"  
- "stop reminder [keyword]" → intent: "cancel_specific", cancelKeyword: "[keyword]"
- "list/tampilkan reminder" → intent: "list"

CONTOH PARSING LENGKAP:

Input: "jemput John nanti" (potential reminder)
Output: {
  "intent": "potential_reminder",
  "title": "Jemput John",
  "conversationalResponse": "Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?"
}

Input: "ingatkan saya minum obat" (need time)
Output: {
  "intent": "need_time", 
  "title": "Minum Obat",
  "conversationalResponse": "Siap! Untuk 'Minum Obat', kamu mau diingatkan kapan?"
}

Input: "ingatkan saya jam 3" (need content)
Output: {
  "intent": "need_content",
  "dueAtWIB": "${nowWIB.set({hour: 15, minute: 0}).toISO()}",
  "conversationalResponse": "Noted jamnya! Kamu mau diingatkan tentang apa ya?"
}

Input: "ingatkan saya minum obat 1 menit lagi" (complete)
Output: {
  "intent": "create",
  "title": "Minum Obat", 
  "timeType": "relative",
  "dueAtWIB": "${nowWIB.plus({minutes: 1}).toISO()}",
  "repeat": "none",
  "conversationalResponse": "✅ Siap! Aku akan ingatkan kamu untuk 'Minum Obat' 1 menit dari sekarang 😊"
}

Input: "--reminder makan" (cancel keyword)
Output: {
  "intent": "cancel_keyword",
  "cancelKeyword": "makan",
  "conversationalResponse": "Mencari pengingat terkait 'makan'..."
}

Input: "stop (1)" (stop number)
Output: {
  "intent": "stop_number",
  "stopNumber": "1", 
  "conversationalResponse": "Membatalkan reminder nomor 1..."
}

Analisis pesan dengan teliti dan berikan JSON yang valid. Pastikan dueAtWIB selalu dalam zona ${WIB_TZ}.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: `Pesan: "${message}"` }
      ],
      temperature: 0.1,
      max_tokens: 400
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty AI response');

    const parsed = JSON.parse(content);
    
    // Enhanced validation dan enrichment
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

    // Fallback validation untuk dueAtWIB jika AI gagal
    if (!result.dueAtWIB && result.intent === 'create') {
      result.dueAtWIB = fallbackTimeParser(message);
    }

    return result;
  } catch (error) {
    console.error('[AI] Extract error:', error);
    // Complete fallback parsing
    return fallbackParser(message);
  }
}

/**
 * Fallback parser when AI fails - dengan support untuk conversational flow
 */
function fallbackParser(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = message.toLowerCase();
  
  // Check for cancel keyword pattern --reminder [keyword]
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

  // Check for stop number pattern stop (1), stop (2), etc
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
  
  // Check for other cancel intents
  if (text.includes('stop') || text.includes('batal') || text.includes('cancel')) {
    if (text.includes('semua') || text.includes('all')) {
      return { intent: 'cancel_all', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, conversationalResponse: null };
    }
    return { intent: 'cancel', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, conversationalResponse: null };
  }
  
  if (text.includes('list') || text.includes('tampilkan')) {
    return { intent: 'list', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, stopNumber: null, conversationalResponse: null };
  }

  // Potential reminder detection (natural language without explicit keywords)
  const potentialKeywords = ['nanti', 'besok', 'jemput', 'meeting', 'minum obat', 'lupa', 'semoga', 'rapat', 'penting'];
  const hasPotentialKeyword = potentialKeywords.some(keyword => text.includes(keyword));
  const hasExplicitKeyword = text.includes('ingatkan') || text.includes('reminder') || text.includes('pengingat');
  
  if (hasPotentialKeyword && !hasExplicitKeyword) {
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
      conversationalResponse: "Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?"
    };
  }

  // Parse time - relative patterns
  let dueAtWIB = null;
  let repeat = 'none';
  let timeType = 'relative';
  let repeatDetails = {};

  // Relative time patterns
  const minuteMatch = text.match(/(\d+)\s*menit/i);
  const hourMatch = text.match(/(\d+)\s*jam/i);
  const secondMatch = text.match(/(\d+)\s*detik/i);
  
  if (minuteMatch) {
    dueAtWIB = nowWIB.plus({ minutes: parseInt(minuteMatch[1]) }).toISO();
  } else if (hourMatch) {
    dueAtWIB = nowWIB.plus({ hours: parseInt(hourMatch[1]) }).toISO();
  } else if (secondMatch) {
    dueAtWIB = nowWIB.plus({ seconds: parseInt(secondMatch[1]) }).toISO();
  } else if (text.includes('besok')) {
    timeType = 'absolute';
    dueAtWIB = nowWIB.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
  } else if (text.includes('lusa')) {
    timeType = 'absolute';
    dueAtWIB = nowWIB.plus({ days: 2 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
  }

  // Recurring patterns
  if (text.includes('setiap')) {
    timeType = 'recurring';
    if (text.includes('jam') && !text.includes('hari') && !text.includes('minggu') && !text.includes('bulan')) {
      repeat = 'hourly';
    } else if (text.includes('hari')) {
      repeat = 'daily';
      const timeMatch = text.match(/jam\s*(\d{1,2})/i);
      if (timeMatch) {
        repeatDetails.timeOfDay = timeMatch[1].padStart(2, '0') + ':00';
        dueAtWIB = nowWIB.plus({ days: 1 }).set({ hour: parseInt(timeMatch[1]), minute: 0, second: 0 }).toISO();
      }
    } else if (text.includes('minggu')) {
      repeat = 'weekly';
    } else if (text.includes('bulan')) {
      repeat = 'monthly';
    }
  }

  // Check if we have content but no time (need_time) or time but no content (need_content)
  const hasReminderKeyword = text.includes('ingatkan') || text.includes('reminder') || text.includes('pengingat');
  const title = extractTitleFromText(message);
  const hasTimeInfo = minuteMatch || hourMatch || secondMatch || text.includes('besok') || text.includes('lusa') || text.includes('jam');
  const hasContentInfo = title && title !== 'Reminder' && title.length > 0;

  if (hasReminderKeyword) {
    if (hasContentInfo && !hasTimeInfo) {
      return {
        intent: 'need_time',
        title: title,
        recipientUsernames: extractUsernames(message),
        timeType: 'relative',
        dueAtWIB: null,
        repeat: 'none',
        repeatDetails: {},
        cancelKeyword: null,
        stopNumber: null,
        conversationalResponse: `Siap! Untuk '${title}', kamu mau diingatkan kapan?`
      };
    } else if (hasTimeInfo && !hasContentInfo) {
      let dueAtWIB = null;
      if (minuteMatch) {
        dueAtWIB = nowWIB.plus({ minutes: parseInt(minuteMatch[1]) }).toISO();
      } else if (hourMatch) {
        dueAtWIB = nowWIB.plus({ hours: parseInt(hourMatch[1]) }).toISO();
      } else if (text.includes('besok')) {
        dueAtWIB = nowWIB.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
      }
      
      return {
        intent: 'need_content',
        title: '',
        recipientUsernames: extractUsernames(message),
        timeType: hasTimeInfo ? 'absolute' : 'relative',
        dueAtWIB: dueAtWIB,
        repeat: 'none',
        repeatDetails: {},
        cancelKeyword: null,
        stopNumber: null,
        conversationalResponse: "Noted jamnya! Kamu mau diingatkan tentang apa ya?"
      };
    }
  }

  // Default fallback
  if (!dueAtWIB) {
    dueAtWIB = nowWIB.plus({ minutes: 5 }).toISO();
  }

  return {
    intent: 'create',
    title: extractTitleFromText(message),
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
  
  // Try relative time first
  const patterns = [
    { regex: /(\d+)\s*menit/i, unit: 'minutes' },
    { regex: /(\d+)\s*jam/i, unit: 'hours' },
    { regex: /(\d+)\s*detik/i, unit: 'seconds' },
    { regex: /(\d+)\s*hari/i, unit: 'days' }
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      const value = parseInt(match[1]);
      return nowWIB.plus({ [pattern.unit]: value }).toISO();
    }
  }
  
  // Try absolute time
  if (text.includes('besok')) {
    return nowWIB.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
  }
  
  // Default: 5 minutes from now
  return nowWIB.plus({ minutes: 5 }).toISO();
}

/**
 * Extract usernames from message
 */
function extractUsernames(message) {
  const usernameRegex = /@(\w+)/g;
  const matches = message.match(usernameRegex);
  return matches || [];
}

/**
 * Fallback title extraction tanpa AI
 */
function extractTitleFromText(text) {
  const t = text.toLowerCase();
  
  // Remove common words
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
 * Generate AI reply untuk konfirmasi atau reminder dengan tone hangat dan personal
 */
async function generateReply(type, context = {}) {
  const systemMsg = type === 'confirm' 
    ? `Kamu asisten WhatsApp yang ramah dan personal seperti teman dekat. Buat konfirmasi pembuatan reminder yang hangat dan natural dalam bahasa Indonesia. 

GAYA BAHASA:
- Gunakan kata "kamu" atau nama user jika ada
- Santai dan ramah seperti asisten pribadi yang peduli
- Tambahkan emoji yang kontekstual (😊✨🙏)
- Nada hangat, bukan formal atau kaku
- Sisipkan motivasi ringan yang relevan

STRUKTUR KONFIRMASI:
✅ Siap, [nama/kamu]! Aku akan ingatkan kamu untuk '[title]' [waktu]. [motivasi] [emoji]

CONTOH:
- ✅ Siap! Aku akan ingatkan kamu untuk 'Minum Obat' 1 menit dari sekarang 😊
- ✅ Noted! Reminder akan dikirim 15 menit dari sekarang ✨
- ✅ Reminder dijadwalkan besok jam 14.00 �`
    : `Kamu asisten WhatsApp yang ramah dan komunikatif seperti teman yang mengingatkan dengan hangat. Buat pesan reminder yang natural dan personal dalam bahasa Indonesia.

GAYA BAHASA:
- Gunakan kata "kamu" atau nama user
- Natural dan komunikatif seperti teman dekat
- Sisipkan pesan motivasi ringan yang relevan
- Gunakan emoji kontekstual (✨🙏😊)
- Hindari nada formal

STRUKTUR REMINDER:
Halo [nama/kamu], ini pengingatmu untuk '[title]'. [motivasi ringan] [emoji]

CONTOH:
- Halo Vibbyfs, ini pengingatmu untuk 'Jemput John'. Semoga harimu makin teratur dan tenang ��✨
- Halo kamu, waktunya 'Minum Obat' nih! Jangan lupa jaga kesehatan ya �😊
- Ini pengingatmu untuk 'Meeting'. Semoga berjalan lancar ya ✨🙏`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: JSON.stringify(context) }
      ],
      temperature: 0.8,
      max_tokens: 150
    });

    const aiResponse = completion.choices[0]?.message?.content?.trim();
    
    if (aiResponse && aiResponse.length > 10) {
      return aiResponse;
    }
    
    // Fallback dengan template yang lebih personal dan hangat
    if (type === 'confirm') {
      const name = context.userName || context.recipients || 'kamu';
      const timeInfo = context.timeType === 'relative' 
        ? `${context.relativeTime}` 
        : `pada ${context.dueTime}`;
      
      return `✅ Siap, ${name}! Aku akan ingatkan kamu untuk '${context.title}' ${timeInfo}. ${getMotivationalMessage(context.title)} 😊`;
    } else {
      const name = context.userName || 'kamu';
      
      // Jika reminder untuk teman, SELALU sertakan identitas pengirim
      if (context.isForFriend) {
        const senderName = context.senderName || context.senderUsername || 'temanmu';
        return `Halo ${name}! Ada reminder dari ${senderName}: ini pengingatmu untuk '${context.title}'. ${getMotivationalMessage(context.title)} ✨🙏`;
      } else {
        return `Halo ${name}, ini pengingatmu untuk '${context.title}'. ${getMotivationalMessage(context.title)} ✨🙏`;
      }
    }
  } catch (error) {
    console.error('[AI] Generate reply error:', error);
    
    // Enhanced fallback
    if (type === 'confirm') {
      const name = context.userName || context.recipients || 'kamu';
      return `✅ Siap, ${name}! Pengingat '${context.title}' sudah dijadwalkan. Aku akan ingetin kamu tepat waktu! 😊`;
    } else {
      const name = context.userName || 'kamu';
      
      // Enhanced fallback untuk reminder ke teman - SELALU sertakan pengirim
      if (context.isForFriend) {
        const senderName = context.senderName || context.senderUsername || 'temanmu';
        return `Halo ${name}! Ada reminder dari ${senderName}: ini pengingatmu untuk '${context.title}'. ${getMotivationalMessage(context.title)} ✨🙏`;
      } else {
        return `Halo ${name}, ini pengingatmu untuk '${context.title}'. ${getMotivationalMessage(context.title)} ✨🙏`;
      }
    }
  }
}

/**
 * Generate conversational response untuk berbagai skenario
 */
function generateConversationalResponse(intent, context = {}) {
  const { title, userName, cancelKeyword, stopNumber, timeInfo } = context;
  const name = userName || 'kamu';

  switch (intent) {
    case 'potential_reminder':
      return "Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?";
    
    case 'need_time':
      return `Siap! Untuk '${title}', kamu mau diingatkan kapan?`;
    
    case 'need_content':
      return "Noted jamnya! Kamu mau diingatkan tentang apa ya?";
    
    case 'create':
      return `✅ Siap, ${name}! Aku akan ingatkan kamu untuk '${title}' ${timeInfo}. 😊`;
    
    case 'cancel_keyword':
      return `Untuk membatalkan reminder, kirim pesan seperti ini: \`--reminder ${cancelKeyword}\`\nNanti aku tampilkan daftar pengingat aktif yang cocok.`;
    
    case 'time_ambiguous':
      return "Maksudnya 'nanti' itu jam berapa ya? Biar aku bisa pasin pengingatnya 😊";
    
    case 'time_passed':
      return "Waktunya udah lewat nih 😅 Mau dijadwalkan ulang?";
    
    case 'user_cancelled':
      return "Oke, pengingatnya aku batalin ya. Kalau butuh lagi tinggal bilang aja 😊";
    
    case 'stop_success':
      return `✅ Reminder nomor ${stopNumber} sudah dibatalkan. Kalau kamu butuh pengingat baru, tinggal bilang aja ya 😊`;
    
    case 'stop_invalid':
      return "Nomor yang kamu kirim belum cocok nih 😅 Coba cek lagi daftar reminder-nya ya.";
    
    case 'missing_time':
      return "Aku belum dapat jamnya nih. Kamu mau diingatkan jam berapa?";
    
    default:
      return "Maaf, aku belum paham maksudmu. Bisa dijelaskan lagi? 😊";
  }
}

/**
 * Generate reminder list untuk cancellation flow
 */
function generateReminderList(reminders, keyword) {
  if (!reminders || reminders.length === 0) {
    return `Tidak ada pengingat aktif terkait '${keyword}' nih. Mau cek semua reminder kamu? Ketik 'list reminder' ya 😊`;
  }

  let response = `Berikut pengingat aktif terkait '${keyword}':\n`;
  reminders.forEach((reminder, index) => {
    const time = new Date(reminder.dueAt).toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
    response += `${index + 1}. ${reminder.title} - ${time}\n`;
  });
  
  response += `\nKirim pesan: \`stop (1)\` untuk membatalkan pengingat nomor 1, dan seterusnya.`;
  
  return response;
}

/**
 * Enhanced motivational message dengan edge case handling
 */
function getMotivationalMessage(title) {
  const lowerTitle = title.toLowerCase();
  
  // Coffee/drink related
  if (lowerTitle.includes('kopi') || lowerTitle.includes('coffee')) {
    const coffeeMessages = [
      'Jangan lupa nikmati aromanya yang bikin mood naik! ☕✨',
      'Kopi enak nggak nungguin, buruan! ☕😄',
      'Biar harimu makin mantap dengan secangkir kopi! ☕🌟',
      'Saatnya boost energi dengan kopi favorit! ☕⚡'
    ];
    return coffeeMessages[Math.floor(Math.random() * coffeeMessages.length)];
  }
  
  // Exercise/workout related
  if (lowerTitle.includes('olahraga') || lowerTitle.includes('gym') || lowerTitle.includes('workout') || lowerTitle.includes('lari')) {
    const exerciseMessages = [
      'Semangat jaga kesehatan! 💪🌅',
      'Tubuh sehat, pikiran fresh! 💪😊',
      'Let\'s go, jangan sampai skip! 💪🔥',
      'Sehat itu investasi terbaik! 💪✨'
    ];
    return exerciseMessages[Math.floor(Math.random() * exerciseMessages.length)];
  }
  
  // Meeting/work related
  if (lowerTitle.includes('meeting') || lowerTitle.includes('rapat') || lowerTitle.includes('kerja')) {
    const workMessages = [
      'Jangan sampai telat ya! 📅⏰',
      'Sukses untuk meetingnya! 📋✨',
      'Siap-siap perform yang terbaik! 💼🌟',
      'Good luck untuk pertemuan ini! 🤝😊'
    ];
    return workMessages[Math.floor(Math.random() * workMessages.length)];
  }
  
  // Work departure/home related
  if (lowerTitle.includes('pulang') || lowerTitle.includes('pergi') || lowerTitle.includes('berangkat')) {
    const departureMessages = [
      'Jangan lupa barang-barangmu ya! 👜😊',
      'Hati-hati di jalan! 🚗💙',
      'Safe trip! Semoga lancar perjalanannya! 🛣️✨',
      'Waktunya berangkat, jangan sampai ketinggalan! ⏰🚶‍♀️',
      'Ayo berangkat sebelum macet! 🚗😄',
      'Time to go! Sampai jumpa di rumah! 🏠💕'
    ];
    return departureMessages[Math.floor(Math.random() * departureMessages.length)];
  }
  
  // Food/meal related
  if (lowerTitle.includes('makan') || lowerTitle.includes('sarapan') || lowerTitle.includes('minum') || lowerTitle.includes('beli')) {
    const foodMessages = [
      'Jangan sampai lupa ya, tubuh butuh nutrisi! 🍽️😊',
      'Saatnya isi perut biar energi tetap full! 🍽️⚡',
      'Makan yang sehat ya! 🥗✨',
      'Jangan skip meal, kesehatan nomor satu! 🍽️�'
    ];
    return foodMessages[Math.floor(Math.random() * foodMessages.length)];
  }
  
  // Rest/break related
  if (lowerTitle.includes('istirahat') || lowerTitle.includes('tidur') || lowerTitle.includes('break')) {
    const restMessages = [
      'Tubuh butuh istirahat yang cukup! 😴💤',
      'Recharge energy, besok semangat lagi! 🔋😊',
      'Self-care itu penting! 💆‍♀️✨',
      'Rest well, tomorrow is a new day! 🌙💫'
    ];
    return restMessages[Math.floor(Math.random() * restMessages.length)];
  }
  
  // Default motivational messages
  const defaultMessages = [
    'Semangat menjalani hari! 🌟😊',
    'Kamu pasti bisa! 💪✨',
    'Jangan lupa ya! 😊🎯',
    'Keep going, you got this! 🚀💫',
    'Ayo kita lakukan dengan semangat! 🔥😄'
  ];
  
  return defaultMessages[Math.floor(Math.random() * defaultMessages.length)];
}

module.exports = { 
  extract, 
  generateReply, 
  extractTitleFromText, 
  generateConversationalResponse, 
  generateReminderList 
};
