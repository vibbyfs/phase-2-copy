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
Kamu adalah AI ekstraksi WhatsApp yang ahli dalam parsing waktu natural. 

CURRENT TIME: ${nowWIB.toFormat('yyyy-MM-dd HH:mm:ss')} WIB (${WIB_TZ})

Tugas kamu: Analisis pesan dan keluarkan JSON dengan struktur:
{
  "intent": "create/cancel/cancel_all/cancel_specific/list/unknown",
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
  "formattedMessage": "pesan reminder yang ramah"
}

PARSING RULES - WAKTU:

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

CONTOH PARSING:
Input: "ingetin saya 52 menit lagi minum obat"
Output: {
  "intent": "create",
  "title": "Minum Obat", 
  "timeType": "relative",
  "dueAtWIB": "${nowWIB.plus({minutes: 52}).toISO()}",
  "repeat": "none"
}

Input: "setiap hari jam 8 pagi sarapan"
Output: {
  "intent": "create",
  "title": "Sarapan",
  "timeType": "recurring", 
  "dueAtWIB": "${nowWIB.plus({days: 1}).set({hour: 8, minute: 0}).toISO()}",
  "repeat": "daily",
  "repeatDetails": {"timeOfDay": "08:00"}
}

Input: "meeting besok jam 2 siang"
Output: {
  "intent": "create",
  "title": "Meeting",
  "timeType": "absolute",
  "dueAtWIB": "${nowWIB.plus({days: 1}).set({hour: 14, minute: 0}).toISO()}",
  "repeat": "none"
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
      formattedMessage: parsed.formattedMessage || null
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
 * Fallback parser when AI fails
 */
function fallbackParser(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = message.toLowerCase();
  
  // Check for cancel intents
  if (text.includes('stop') || text.includes('batal') || text.includes('cancel')) {
    if (text.includes('semua') || text.includes('all')) {
      return { intent: 'cancel_all', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, formattedMessage: null };
    }
    return { intent: 'cancel', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, formattedMessage: null };
  }
  
  if (text.includes('list') || text.includes('tampilkan')) {
    return { intent: 'list', title: '', recipientUsernames: [], timeType: 'relative', dueAtWIB: null, repeat: 'none', repeatDetails: {}, cancelKeyword: null, formattedMessage: null };
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
    formattedMessage: null
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
 * Generate AI reply untuk konfirmasi atau reminder
 */
async function generateReply(type, context = {}) {
  const systemMsg = type === 'confirm' 
    ? `Kamu asisten WhatsApp yang ramah dan personal seperti teman dekat. Buat konfirmasi pembuatan reminder yang hangat dan natural dalam bahasa Indonesia. 

GAYA BAHASA:
- Gunakan kata "kamu" atau nama user jika ada
- Santai dan ramah seperti asisten pribadi
- Tambahkan kalimat motivasional yang relevan dengan konteks
- Gunakan emoji yang sesuai

STRUKTUR:
✅ [Konfirmasi siap] [nama/kamu]! [Detail reminder] [kalimat motivasional/hangat] [emoji]

CONTOH:
- ✅ Siap, Vinny! Aku akan ingetin kamu buat beli Kopi Fore 1 menit lagi. Jangan lupa nikmati aromanya yang bikin mood naik! ☕✨
- ✅ Oke kamu! Pengingat olahraga sudah dijadwalkan setiap hari jam 7 pagi. Semangat jaga kesehatan! 💪🌅`
    : `Kamu asisten WhatsApp yang ramah dan komunikatif seperti teman yang mengingatkan dengan hangat. Buat pesan reminder yang natural dan tidak formal dalam bahasa Indonesia.

GAYA BAHASA:
- Gunakan kata "kamu" atau nama user
- Natural dan komunikatif seperti teman dekat
- Bisa sedikit humor atau dorongan positif
- Tidak terlalu formal

STRUKTUR:
Jika untuk diri sendiri:
⏰ [Sapaan + nama/kamu], [pesan pengingat natural] [motivasi/humor ringan] [emoji]

Jika untuk teman (ada context.isForFriend = true):
⏰ Hei [nama]! Ada reminder dari ${context.senderName || 'temanmu'}: [pesan pengingat] [motivasi/humor ringan] [emoji]

CONTOH:
- ⏰ Hei Vinny, waktunya beli Kopi Fore nih! Jangan sampai kehabisan ya—kopi enak nggak nungguin 😄☕
- ⏰ Hei Dimas! Ada reminder dari Vinny: waktunya tidur siang! Istirahat yang cukup ya, biar segar lagi nanti 😴💤
- ⏰ Kamu, jangan lupa olahraganya! Tubuh sehat, pikiran fresh! 💪😊`;

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
    
    // Fallback dengan template yang lebih personal
    if (type === 'confirm') {
      const name = context.userName || context.recipients || 'kamu';
      const timeInfo = context.timeType === 'relative' 
        ? `${context.relativeTime}` 
        : `pada ${context.dueTime}`;
      
      return `✅ Siap, ${name}! Aku akan ingetin kamu buat ${context.title} ${timeInfo}. ${getMotivationalMessage(context.title)}`;
    } else {
      const name = context.userName || 'kamu';
      
      // Jika reminder untuk teman, sertakan identitas pengirim
      if (context.isForFriend && context.senderName) {
        return `⏰ Hei ${name}! Ada reminder dari ${context.senderName}: waktunya ${context.title}! ${getMotivationalMessage(context.title)}`;
      } else {
        return `⏰ Hei ${name}, waktunya ${context.title} nih! ${getMotivationalMessage(context.title)}`;
      }
    }
  } catch (error) {
    console.error('[AI] Generate reply error:', error);
    
    // Enhanced fallback
    if (type === 'confirm') {
      const name = context.userName || context.recipients || 'kamu';
      return `✅ Siap, ${name}! Pengingat ${context.title} sudah dijadwalkan. Aku akan ingetin kamu tepat waktu! 😊`;
    } else {
      const name = context.userName || 'kamu';
      
      // Enhanced fallback untuk reminder ke teman
      if (context.isForFriend && context.senderName) {
        return `⏰ ${name}, ada reminder dari ${context.senderName}: waktunya ${context.title}! ${getMotivationalMessage(context.title)}`;
      } else {
        return `⏰ ${name}, waktunya ${context.title}! ${getMotivationalMessage(context.title)}`;
      }
    }
  }
}

/**
 * Generate motivational message based on activity context
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

module.exports = { extract, generateReply, extractTitleFromText };
