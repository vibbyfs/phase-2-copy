import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Proses teks dari user → kembalikan respon AI + instruksi reminder bila ada
 * @param {string} text - Input dari user
 * @param {object} user - Data user (misalnya {id, username, phone})
 * @returns {object} { reply, reminder }
 */
export async function processMessage(text, user = {}) {
  try {
    const prompt = `
Kamu adalah asisten ramah untuk WhatsApp.
Tugas:
1. Jika user hanya menyapa → balas hangat & arahkan contoh "ingatkan saya <aktivitas> <waktu>".
2. Jika user minta pengingat → ekstrak "aktivitas" dan "waktu".
   - Aktivitas: deskripsi singkat apa yang harus diingatkan.
   - Waktu: bisa format jam (20:00), besok, atau relatif (10 menit lagi).
3. Jawab dengan bahasa alami, pendek & tidak kaku.
4. Tutup jawaban dengan 1 kalimat motivasi singkat (tidak lebih dari 1 baris).
Output JSON:
{
  "reply": "<balasan ke user>",
  "reminder": {
    "activity": "<aktivitas atau kosong>",
    "time": "<waktu atau kosong>"
  }
}
`;

    const response = await client.chat.completions.create({
      model: "gpt-5-mini", // ✅ ganti model ke gpt-5-mini
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: text },
      ],
      max_tokens: 250,
    });

    const raw = response.choices[0]?.message?.content || "{}";
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error("[AI] Gagal parse JSON:", raw);
      data = { reply: "Maaf, coba ulangi lagi ya 😊", reminder: null };
    }

    return data;
  } catch (err) {
    console.error("[AI] Error:", err.message);
    return {
      reply: "Maaf, aku lagi ada kendala. Coba sebentar lagi ya 🙏",
      reminder: null,
    };
  }
}
