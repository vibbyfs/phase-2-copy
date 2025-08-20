const OpenAI = require('openai');

// Inisialisasi OpenAI client hanya jika API key tersedia
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// Util: aman parse JSON (ambil objek {...} pertama kalau output model kepanjangan)
function safeParseJSON(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (_) { }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try { return JSON.parse(slice); } catch (_) { }
  }
  return null;
}

// Panggil Responses API dengan format input terbaru
async function responsesText(system, user, extraMessages = []) {
  if (!openai) throw new Error('OpenAI API key not configured');

  // Bangun array input sesuai spesifikasi Responses API:
  // setiap item: { role, content: [{ type: 'input_text', text }] }
  const input = [
    { role: 'system', content: [{ type: 'input_text', text: system }] },
    ...extraMessages.map(m => ({
      role: m.role,
      content: [{ type: 'input_text', text: m.content }]
    })),
    { role: 'user', content: [{ type: 'input_text', text: user }] }
  ];

  let outText = '';
  try {
    const resp = await openai.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      input
    });
    // Cara ambil hasil yang paling stabil di Responses API
    outText = resp?.output_text || '';
    if (!outText && Array.isArray(resp?.output) && resp.output.length > 0) {
      const first = resp.output[0];
      const seg = first?.content?.[0];
      outText = seg?.text || '';
    }
  } catch (err) {
    console.error('[AI] API error:', err?.message || err);
    throw err;
  }
  return (outText || '').trim();
}

// Extractor: JSON-only untuk niat reminder + waktu + repeat + multi recipient
const EXTRACT_SYSTEM = `
Kamu asisten yang mengekstrak NIAT pengingat dari pesan WhatsApp Multi Bahasa.
KEMBALIKAN **JSON MURNI** saja (tanpa kalimat lain).

Skema:
{
  "intent": "unknown" | "potential_reminder" | "need_time" | "need_content" | "create" | "cancel_keyword" | "stop_number" | "list",
  "title": string | null,
  "recipientUsernames": string[],
  "timeType": "relative" | "absolute" | null,
  "dueAtWIB": string | null,                      
  "repeat": "none" | "minutes" | "hours" | "daily" | "weekly" | "monthly" | "yearly",
  "repeatDetails": {
    "interval": number | null,                    
    "timeOfDay": string | null,                   
    "dayOfWeek": string | null,                   
    "dayOfMonth": number | null,                  
    "monthDay": string | null,                    
    "endDate": string | null                      
  },
  "cancelKeyword": string | null,                 
  "stopNumber": number | null,                    
  "reply": string                                 
}

ATAURAN:
- Deteksi niat reminder walau tanpa kata "ingatkan" (contoh: "jemput John nanti", "aku suka lupa minum air", "semoga gak lupa jemput John").
- Ekstrak @username ke recipientUsernames (hapus '@'). Jika ada @username, title diambil dari sisa kalimat (tanpa mentions).
- Jika hanya waktu (mis. "2 menit lagi") tanpa isi → intent = "need_content".
- Jika hanya isi tanpa waktu → intent = "need_time".
- Jika ada keduanya → intent = "create".
- "--reminder <keyword>" → intent = "cancel_keyword", set cancelKeyword.
- "stop (N)" / "batal (N)" / angka yang dipilih setelah list → intent = "stop_number", set stopNumber.
- "list" → intent = "list".

REPEAT SEDERHANA:
- "setiap X menit/jam" → repeat="minutes"/"hours", interval=X
- "setiap hari jam X" → repeat="daily", timeOfDay="X"
- "setiap senin/selasa ... jam X" → repeat="weekly", dayOfWeek="senin", timeOfDay="X"
- "setiap tanggal X jam Y" → repeat="monthly", dayOfMonth=X, timeOfDay="Y"
- "setiap 12 Mei jam X" → repeat="yearly", monthDay="12 Mei", timeOfDay="X"
- "sampai 30 Sep" / "selama 3 bulan" → taruh di endDate (string apa adanya)

WAKTU (WIB):
- Pahami: "1/2/5/15 menit lagi", "jam 20.00", "20:30", "besok jam 2 siang", "rabu depan jam 3", "lusa", "pagi/siang/sore/malam".
- "dueAtWIB" harus ISO Asia/Jakarta (contoh "2025-08-17T14:00:00+07:00").
- Jika user bilang "setiap tanggal 1 jam 3 sore", itu BERULANG bulanan (repeat="monthly", dayOfMonth=1, timeOfDay="15:00"). Jangan dijadwalkan hari ini jam 3.
- Jangan mengatur ke masa lalu. Jika waktu absolut yang disebut sudah lewat hari ini, pilih waktu terdekat yang masuk akal (besok/pekan depan/dst).
- Jika hanya hari (mis. "besok") tanpa jam → intent "need_time" (minta jam).

"reply":
- SATU kalimat, hangat, natural, tidak kaku. Boleh emoji secukupnya.
- Menjawab konteks pesan terakhir; bila potensi reminder, tawarkan bantu atur waktu dengan lembut.
`;

function buildExtractUserPrompt({ text, username, nowWIB, lastContext }) {
  const ctx = {
    text,
    username,
    nowWIB,
    lastContext: lastContext || null
  };
  return JSON.stringify(ctx);
}

// Generator: buat kalimat obrolan (1 baris) atau pesan pengingat / motivasi yang personal
const REPLY_SYSTEM = `
Kamu asisten WhatsApp berbahasa Indonesia: hangat, santai, dan personal.

Jika context.kind = "reminder_delivery" atau "motivational_reminder":
- Buat pesan pengingat yang personal dan memotivasi.
- Format ringkas: "Halo [nama], waktunya [aktivitas]! [motivasi singkat] [emoji]"
- Sesuaikan emoji: ☕ (kopi), 💪 (olahraga), 📚 (belajar), 💊 (obat), 🚗 (jemput), ✨ (semangat), 🙏 (doa), dll.
- Satu kalimat saja.

Selain itu:
- Jawab dalam SATU kalimat yang alami (maks satu baris), tidak kaku, boleh emoji secukupnya.
`;

async function extract({ text, userProfile = {}, sessionContext = {} }) {
  // Waktu sekarang dalam WIB (tanpa bergantung pada server TZ)
  const now = new Date();
  const offsetMs = 7 * 60 * 60 * 1000;
  const nowWIB = new Date(now.getTime() + offsetMs).toISOString().replace('Z', '+07:00');

  const system = EXTRACT_SYSTEM;
  const user = buildExtractUserPrompt({
    text,
    username: userProfile?.username || null,
    nowWIB,
    lastContext: sessionContext || null
  });

  let out;
  try {
    const raw = await responsesText(system, user);
    out = safeParseJSON(raw);
  } catch (_) {
    // Dibiarkan; fallback di bawah
  }

  // Fallback default jika parsing gagal / output kosong
  if (!out || typeof out !== 'object') {
    return {
      intent: 'unknown',
      title: (text || '').trim() || null,
      recipientUsernames: [],
      timeType: 'absolute',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {
        interval: null,
        timeOfDay: null,
        dayOfWeek: null,
        dayOfMonth: null,
        monthDay: null,
        endDate: null
      },
      cancelKeyword: null,
      stopNumber: null,
      reply: 'Aku di sini buat bantu kamu bikin pengingat biar nggak lupa. Mau diingatkan tentang apa, dan kapan? 😊'
    };
  }

  // Normalisasi ringan agar aman untuk controller/scheduler
  if (!Array.isArray(out.recipientUsernames)) out.recipientUsernames = [];
  out.repeat = out.repeat || 'none';
  if (!out.repeatDetails) {
    out.repeatDetails = {
      interval: null,
      timeOfDay: null,
      dayOfWeek: null,
      dayOfMonth: null,
      monthDay: null,
      endDate: null
    };
  }
  if (typeof out.reply !== 'string' || !out.reply.trim()) {
    out.reply = 'Siap. Ada yang mau kamu ingatkan?';
  }

  return out;
}

async function generateReply(context) {
  const user = JSON.stringify(context || {});
  try {
    const text = await responsesText(REPLY_SYSTEM, user);
    return (text || '').replace(/\s+/g, ' ').trim();
  } catch (err) {
    console.error('[AI] generateReply error:', err?.message || err);
    // Fallback kalimat tunggal supaya percakapan tetap hidup
    return 'Siap! Aku bantu atur semuanya, kabari aja detailnya ya 😊';
  }
}

module.exports = {
  extract,
  generateReply
};
