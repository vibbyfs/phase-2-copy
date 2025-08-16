// services/ai.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Ekstrak struktur reminder dari teks user.
 * Output JSON:
 * { activity: string, time: string, intent: "create"|"need_time"|"need_content"|"potential_reminder"|"unknown" }
 */
export async function extractReminderData(text) {
  try {
    const sys = `
Kamu mengekstrak pengingat Bahasa Indonesia.
Balas SELALU sebagai JSON saja (tanpa teks lain), schema:
{
  "activity": string,   // "" bila tidak ada
  "time": string,       // "" bila tidak ada (contoh valid: "20:00", "besok 08:00", "1 menit lagi")
  "intent": "create" | "need_time" | "need_content" | "potential_reminder" | "unknown"
}
ATURAN DETEKSI:
- Jika hanya waktu tanpa aktivitas → intent = "need_content".
- Jika hanya aktivitas tanpa waktu → intent = "need_time".
- Jika keduanya lengkap → intent = "create".
- Jika kalimat perintah/reflektif/harapan yang berpotensi reminder (tanpa waktu) → intent = "potential_reminder".
- Jika ambigu → "unknown".
- Jangan mengarang activity.
`;
    const resp = await client.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text }
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 160
    });

    const raw = resp.choices?.[0]?.message?.content?.trim() || "";
    if (!raw) return { activity: "", time: "", intent: "unknown" };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { activity: "", time: "", intent: "unknown" };
    }

    const intentValues = ["create","need_time","need_content","potential_reminder","unknown"];
    return {
      activity: typeof parsed.activity === "string" ? parsed.activity.trim() : "",
      time: typeof parsed.time === "string" ? parsed.time.trim() : "",
      intent: intentValues.includes(parsed.intent) ? parsed.intent : "unknown"
    };
  } catch (e) {
    console.error("[AI] extractReminderData error:", e?.message || e);
    return { activity: "", time: "", intent: "unknown" };
  }
}

/**
 * Balasan natural & ramah dengan penutup 1 kalimat pendek (≤ 1 baris).
 */
export async function generateAIResponse(messages) {
  try {
    const sys = `Kamu asisten WhatsApp yang ramah (Bahasa Indonesia).
- Jawab natural, hangat, personal, sebut nama jika ada.
- Jika waktu/aktivitas belum jelas, arahkan dengan contoh.
- Tutup jawaban dengan 1 kalimat motivasional singkat (maks 1 baris).`;

    const resp = await client.chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "system", content: sys }, ...messages],
      max_completion_tokens: 220
    });

    return resp.choices?.[0]?.message?.content?.trim() || "Maaf, bisa dijelaskan lagi ya? 🙂";
  } catch (e) {
    console.error("[AI] generateAIResponse error:", e?.message || e);
    return "Maaf, aku lagi ada kendala. Coba lagi sebentar ya 🙏";
  }
}
