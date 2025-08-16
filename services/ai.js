// services/ai.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Ekstrak struktur reminder dari teks user.
 * Output selalu JSON: { activity: string, time: string, intent: "create"|"need_time"|"need_content"|"unknown" }
 * - Jangan pernah mengarang activity. Jika user hanya kirim waktu, activity = "".
 * - Jika hanya activity tanpa waktu → intent = "need_time".
 * - Jika hanya waktu tanpa activity → intent = "need_content".
 * - Jika lengkap → intent = "create".
 */
export async function extractReminderData(text) {
  try {
    const sys = `
Kamu mengekstrak pengingat dalam Bahasa Indonesia.
Balas SELALU sebagai JSON saja (tanpa teks lain) dengan schema:
{
  "activity": string,  // "" bila tidak ada
  "time": string,      // "" bila tidak ada (contoh valid: "20:00", "besok 08:00", "1 menit lagi")
  "intent": "create" | "need_time" | "need_content" | "unknown"
}
ATURAN:
- Jangan mengarang "activity". Jika pesan hanya menyebut waktu (mis. "1 menit lagi"), kembalikan activity: "" dan intent: "need_content".
- Jika ada aktivitas tapi tidak ada waktu → intent: "need_time".
- Jika keduanya ada → intent: "create".
- Jika ambigu → intent: "unknown".
`;

    const resp = await client.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text }
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 200
    });

    const raw = resp.choices?.[0]?.message?.content?.trim() || "";
    if (!raw) return { activity: "", time: "", intent: "unknown" };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { activity: "", time: "", intent: "unknown" };
    }

    return {
      activity: typeof parsed.activity === "string" ? parsed.activity.trim() : "",
      time: typeof parsed.time === "string" ? parsed.time.trim() : "",
      intent: ["create", "need_time", "need_content", "unknown"].includes(parsed.intent) ? parsed.intent : "unknown"
    };
  } catch (e) {
    console.error("[AI] extractReminderData error:", e?.message || e);
    return { activity: "", time: "", intent: "unknown" };
  }
}

/**
 * Balasan natural & ramah. Tambahkan penutup motivasional singkat, MAKS 1 kalimat (≤ 1 baris).
 */
export async function generateAIResponse(messages) {
  try {
    const sys = `Kamu asisten WhatsApp yang ramah (Bahasa Indonesia).
- Jawab natural, tidak kaku.
- Jika user belum menyebut waktu, tanyakan dengan contoh (mis. "jam 20.00", "1 jam lagi", "besok 08.00").
- Tutup jawaban dengan penutup motivasional singkat, hanya 1 kalimat pendek (maksimal 1 baris).`;

    const resp = await client.chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "system", content: sys }, ...messages],
      max_completion_tokens: 220
    });

    const content = resp.choices?.[0]?.message?.content?.trim();
    return content || "Maaf, bisa dijelaskan lagi ya? 🙂";
  } catch (e) {
    console.error("[AI] generateAIResponse error:", e?.message || e);
    return "Maaf, aku lagi ada kendala. Coba lagi sebentar ya 🙏";
  }
}
