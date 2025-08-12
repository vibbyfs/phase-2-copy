const { DateTime } = require('luxon');
const OpenAI = require('openai');

const WIB_TZ = 'Asia/Jakarta';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Simplified AI service untuk fitur yang dipersempit:
 * 1. Extract reminder dengan pattern: hourly, daily, weekly, monthly
 * 2. Extract username tagging untuk reminder sekali @username
 * 3. Extract cancel intent dengan natural language
 */

async function extract(message) {
  const systemMsg = `
Kamu adalah AI ekstraksi WhatsApp yang ramah dan natural. Tugas kamu:

1. EKSTRAKSI DATA: Analisis pesan dan keluarkan JSON dengan struktur:
{
  "intent": "create/cancel/cancel_all/cancel_specific/list/unknown",
  "title": "judul singkat dari aktivitas yang akan diingatkan (≤5 kata, tanpa kata 'pengingat' atau 'setiap')",
  "recipientUsernames": ["array username dengan @, contoh: ['@john', '@jane']"],
  "timeType": "relative/absolute/recurring",
  "dueAtWIB": "waktu dalam ISO format zona ${WIB_TZ}",
  "repeat": "none/hourly/daily/weekly/monthly",
  "cancelKeyword": "keyword untuk cancel reminder tertentu",
  "formattedMessage": "pesan reminder yang ramah dan motivasional"
}

2. WAKTU - ANALISIS FLEKSIBEL:
   
   a) RELATIVE TIME (timeType: "relative"):
      - "5 menit lagi", "dalam 2 jam", "30 detik lagi" → hitung dari waktu sekarang
      - "besok", "lusa", "minggu depan" → relatif dari hari ini
      - Contoh: "52 menit lagi" → dueAtWIB: [52 menit dari sekarang]
      
   b) ABSOLUTE TIME (timeType: "absolute"):
      - "jam 14:00", "pukul 2 siang", "jam 9 pagi" → waktu spesifik hari ini
      - "besok jam 8", "Senin jam 10" → waktu spesifik hari tertentu
      - Format ISO: "2025-08-12T14:00:00+07:00"
      
   c) RECURRING TIME (timeType: "recurring"):
      - "setiap hari jam 8" → repeat: "daily", waktu: 08:00
      - "setiap Senin jam 9" → repeat: "weekly", waktu: 09:00 Senin
      - "setiap tanggal 1 jam 10" → repeat: "monthly", waktu: 10:00 tanggal 1

3. REPEAT: Deteksi pola pengulangan yang LEBIH FLEKSIBEL:
   - "setiap jam" → repeat: "hourly"
   - "setiap hari" / "daily" / "harian" → repeat: "daily"
   - "setiap minggu" / "weekly" / "mingguan" → repeat: "weekly"  
   - "setiap bulan" / "monthly" / "bulanan" → repeat: "monthly"
   - default → repeat: "none"

4. USERNAME TAGGING: Ekstrak @username dari pesan:
   - Contoh: "ingetin @john @jane meeting" → recipientUsernames: ["@john", "@jane"]
   - Jika ada @username, ini adalah reminder SEKALI (bukan recurring)

5. CANCEL INTENT: Deteksi berbagai jenis pembatalan:
   - "stop reminder", "batal reminder", "cancel reminder" → intent: "cancel" (cancel recurring)
   - "stop semua reminder", "batal semua", "cancel all" → intent: "cancel_all"
   - "stop reminder minum air", "batal reminder meeting" → intent: "cancel_specific", cancelKeyword: "minum air"/"meeting"
   - "list reminder", "tampilkan reminder" → intent: "list"

6. TITLE: Ekstrak aktivitas dari pesan, JANGAN gunakan kata "pengingat", "reminder", atau "setiap". 
   Contoh: "ingetin saya setiap jam minum air putih" → title: "Minum Air Putih"
   Contoh: "setiap hari ingatkan olahraga" → title: "Olahraga"
   Contoh: "tolong reminder meeting zoom setiap minggu" → title: "Meeting Zoom" 
   Contoh: "ingetin @john meeting besok" → title: "Meeting"

7. FORMATTED MESSAGE: Buat pesan yang ramah dengan nama user dan topik reminder.
   Contoh: "Hay [Nama] 👋, waktunya untuk *[Title]* ! Jangan lupa ya 😊"

CONTOH PARSING:
- "ingetin saya 30 menit lagi minum obat" → timeType: "relative", dueAtWIB: [30 menit dari sekarang], repeat: "none"
- "reminder meeting jam 2 siang" → timeType: "absolute", dueAtWIB: "2025-08-12T14:00:00+07:00", repeat: "none"  
- "setiap hari jam 8 pagi ingatkan sarapan" → timeType: "recurring", dueAtWIB: "2025-08-13T08:00:00+07:00", repeat: "daily"

Analisis dengan teliti dan keluarkan hanya JSON yang valid.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
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
    
    // Validasi dan default values
    return {
      intent: parsed.intent || 'unknown',
      title: parsed.title || 'Reminder',
      recipientUsernames: Array.isArray(parsed.recipientUsernames) ? parsed.recipientUsernames : [],
      dueAtWIB: parsed.dueAtWIB || null,
      repeat: ['none', 'hourly', 'daily', 'weekly', 'monthly'].includes(parsed.repeat) ? parsed.repeat : 'none',
      cancelKeyword: parsed.cancelKeyword || null,
      formattedMessage: parsed.formattedMessage || null
    };
  } catch (error) {
    console.error('[AI] Extract error:', error);
    return {
      intent: 'unknown',
      title: extractTitleFromText(message),
      recipientUsernames: [],
      dueAtWIB: null,
      repeat: 'none',
      cancelKeyword: null,
      formattedMessage: null
    };
  }
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
    ? `Kamu asisten WhatsApp yang ramah. Buat konfirmasi pembuatan reminder yang natural dan ramah dalam bahasa Indonesia. Format: "✅ Siap! Reminder [title] untuk [recipients] sudah dijadwalkan pada [dueTime][repeat]. [motivational message]"`
    : `Kamu asisten WhatsApp yang ramah. Buat pesan reminder yang natural dan motivasional dalam bahasa Indonesia. Format: "Hay [username] 👋, waktunya untuk *[title]*! [motivational message] 😊"`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: JSON.stringify(context) }
      ],
      temperature: 0.7,
      max_tokens: 150
    });

    return completion.choices[0]?.message?.content?.trim() || 
      (type === 'confirm' ? '✅ Reminder berhasil dibuat!' : '⏰ Waktunya reminder!');
  } catch (error) {
    console.error('[AI] Generate reply error:', error);
    return type === 'confirm' ? '✅ Reminder berhasil dibuat!' : '⏰ Waktunya reminder!';
  }
}

module.exports = { extract, generateReply, extractTitleFromText };
