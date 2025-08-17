// services/ai.js
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.AI_MODEL || 'gpt-5-mini';

// --- Responses API call helper (tanpa 'max_tokens' & tanpa 'temperature' kustom)
async function callModel({ systemText, userText, maxTokens = 400 }) {
  const resp = await client.responses.create({
    model: MODEL,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemText || '' }] },
      { role: 'user',   content: [{ type: 'input_text', text: userText   || '' }] }
    ],
    max_completion_tokens: maxTokens
  });

  const text = (resp.output_text || '').trim();
  if (!text) throw new Error('Empty AI response');
  return text;
}

// --- Extractor: kembalikan struktur yang dipakai controller
async function extract({ username, text, tz = 'Asia/Jakarta' }) {
  const system = [
    'Kamu asisten WhatsApp yang natural & ramah (Indonesia).',
    'Deteksi niat reminder, parsing waktu (relative/absolute), pembatalan (--reminder <kw>, stop (n)).',
    'Kembalikan HANYA JSON valid sesuai schema. Tanpa penjelasan lain.'
  ].join(' ');

  const schema = {
    intent: 'unknown|potential_reminder|need_time|need_content|create|cancel_keyword|stop_number',
    title: 'string|null',
    recipientUsernames: ['string'],
    timeType: 'relative|absolute',
    dueAtWIB: 'ISO8601|null',
    repeat: 'none|daily|weekly|monthly',
    repeatDetails: { timeOfDay: 'HH:mm|null', dayOfWeek: '1-7|null', dayOfMonth: '1-31|null' },
    cancelKeyword: 'string|null',
    stopNumber: 'number|null',
    reply: 'string|null'
  };

  const user = [
    `User: ${username || 'pengguna'}`,
    `Timezone: ${tz}`,
    'Schema JSON:',
    JSON.stringify(schema, null, 2),
    'Catatan:',
    '- Jika pesan hanya waktu → intent=need_content.',
    '- Jika pesan hanya aktivitas → intent=need_time.',
    '- Jika keduanya ada → intent=create dan isi dueAtWIB (WIB).',
    '- Random/halo/curhat → intent=unknown & reply ramah yang membuka opsi reminder.',
    '- "--reminder <kw>" → intent=cancel_keyword & cancelKeyword=kw.',
    '- "stop (n)" → intent=stop_number & stopNumber=n.',
    '',
    `Pesan: """${text}"""`
  ].join('\n');

  const raw = await callModel({ systemText: system, userText: user, maxTokens: 500 });

  // Ambil blok JSON pertama agar tahan noise
  let parsed;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON found');
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('Empty AI response');
  }

  return {
    intent: parsed.intent || 'unknown',
    title: parsed.title ?? null,
    recipientUsernames: Array.isArray(parsed.recipientUsernames) ? parsed.recipientUsernames : [],
    timeType: parsed.timeType || 'absolute',
    dueAtWIB: parsed.dueAtWIB || null,
    repeat: parsed.repeat || 'none',
    repeatDetails: parsed.repeatDetails || { timeOfDay: null, dayOfWeek: null, dayOfMonth: null },
    cancelKeyword: parsed.cancelKeyword || null,
    stopNumber: parsed.stopNumber || null,
    reply: parsed.reply || null
  };
}

// --- Generator balasan singkat & natural (tanpa template kaku)
async function generateReply({ username, context, tz = 'Asia/Jakarta' }) {
  const system = [
    'Asisten WhatsApp yang hangat, singkat, natural.',
    'Maks 1–2 kalimat. Arahkan lembut ke fitur reminder bila relevan.',
    'Emoji secukupnya.'
  ].join(' ');
  const user = [
    `Nama: ${username || 'kamu'}`,
    `Timezone: ${tz}`,
    `Konteks: ${JSON.stringify(context)}`
  ].join('\n');

  return callModel({ systemText: system, userText: user, maxTokens: 120 });
}

function extractTitleFromText(text = '') {
  return (text || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

module.exports = { extract, generateReply, extractTitleFromText };
