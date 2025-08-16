import { generateAIResponse, extractReminderData } from "../services/ai.js";
import { scheduleReminder } from "../services/scheduler.js";
import { sendMessage } from "../services/waOutbound.js";
import db from "../models/index.js";

/**
 * Handler utama untuk pesan WhatsApp masuk
 */
export async function inbound(req, res) {
  try {
    const { from, text } = req.body;
    console.log("[WA] inbound from:", from, "text:", text);

    // Cek user di DB
    const user = await db.User.findOne({ where: { phone: from } });
    if (!user) {
      await sendMessage(
        from,
        "Halo! 😊 Kamu perlu registrasi dulu sebelum bisa pakai fitur pengingat."
      );
      return res.sendStatus(200);
    }

    // Coba ekstrak data reminder dari AI
    let extracted;
    try {
      extracted = await extractReminderData(text);
    } catch (err) {
      console.error("[AI] Extract error:", err);
      await sendMessage(from, "Maaf, aku agak bingung dengan maksudmu. Bisa diulangi?");
      return res.sendStatus(200);
    }

    let reply;

    if (extracted?.activity && extracted?.time) {
      // Jika lengkap → buat pengingat
      try {
        await scheduleReminder(user, extracted.activity, extracted.time);

        reply = `✅ Siap ${user.username || ""}! Aku sudah buat pengingat untuk *${extracted.activity}* pada *${extracted.time}*.`;
      } catch (err) {
        console.error("[Scheduler] Error:", err);
        reply = "⚠️ Maaf, ada masalah saat membuat pengingat. Coba lagi sebentar ya.";
      }
    } else {
      // Jika belum lengkap → AI yang arahkan
      try {
        reply = await generateAIResponse([
          { role: "system", content: "Kamu adalah asisten WhatsApp yang ramah." },
          {
            role: "system",
            content:
              "Tugasmu membantu user membuat pengingat. Jika aktivitas/waktu belum jelas, tanyakan dengan sopan. Akhiri jawaban dengan motivasi singkat maksimal 1 baris."
          },
          { role: "user", content: text }
        ]);
      } catch (err) {
        console.error("[AI] Generate error:", err);
        reply = "⚠️ Aku lagi error. Coba lagi sebentar ya 🙏";
      }
    }

    // Kirim balasan ke user
    await sendMessage(from, reply);
    res.sendStatus(200);
  } catch (err) {
    console.error("[WA Controller] Fatal error:", err);
    res.sendStatus(500);
  }
}
