// controllers/waController.js
import { DateTime } from "luxon";
import { extractReminderData, generateAIResponse } from "../services/ai.js";
import { scheduleReminder, listReminders, cancelAllReminders, cancelReminder } from "../services/scheduler.js";
import { sendMessage } from "../services/waOutbound.js";
import db from "../models/index.js";

const WIB_TZ = "Asia/Jakarta";

// Simpan konteks sementara per-user agar "1 menit lagi" menempel ke aktivitas sebelumnya.
// Catatan: in-memory per-proses (restart/scale-out akan reset). Cukup untuk alur chat ringan.
const pendingActivityByUser = new Map(); // key: user.id, val: { activity, at: number }

// --- Helper: ambil (from, text) dari Twilio / generic body ---
function extractFromBody(req) {
  if (req.body && req.body.From && req.body.Body) {
    return {
      from: String(req.body.From).replace(/^whatsapp:/, ""),
      text: String(req.body.Body || "").trim(),
    };
  }
  return {
    from: String(req.body.from || "").trim(),
    text: String(req.body.text || "").trim(),
  };
}

// --- Helper: format tanggal WIB cantik ---
function formatWIB(dt) {
  return DateTime.fromJSDate(dt).setZone(WIB_TZ).toFormat("dd/MM/yyyy HH:mm 'WIB'");
}

// --- Helper: parsing waktu natural (WIB) → Date ---
// Mendukung: "1 menit lagi", "2 jam lagi", "detik", "jam 20:00", "20:30", "besok [jam HH:mm]",
// "lusa [jam HH:mm]", ISO (YYYY-MM-DDTHH:mm:ss)
function parseNaturalTimeWIB(raw, now = DateTime.now().setZone(WIB_TZ)) {
  if (!raw || typeof raw !== "string") return null;
  const text = raw.toLowerCase().trim();

  // ISO / tanggal eksplisit
  let iso = DateTime.fromISO(text, { zone: WIB_TZ });
  if (iso.isValid) return iso.toUTC().toJSDate();

  // Relative: detik/menit/jam lagi
  let m;
  if ((m = text.match(/(\d+)\s*detik(?:\s*lagi)?/i))) {
    return now.plus({ seconds: Number(m[1]) }).toUTC().toJSDate();
  }
  if ((m = text.match(/(\d+)\s*menit(?:\s*lagi)?/i))) {
    return now.plus({ minutes: Number(m[1]) }).toUTC().toJSDate();
  }
  if ((m = text.match(/(\d+)\s*jam(?:\s*lagi)?/i))) {
    return now.plus({ hours: Number(m[1]) }).toUTC().toJSDate();
  }

  // "besok" / "lusa" (+ optional jam)
  const timePattern = /(?:jam|pukul)?\s*(\d{1,2})(?::|\.?)(\d{2})?/i;

  if (text.includes("besok")) {
    const base = now.plus({ days: 1 }).startOf("day");
    const mt = text.match(timePattern);
    const hour = mt ? Number(mt[1]) : 9;
    const minute = mt && mt[2] ? Number(mt[2]) : 0;
    return base.set({ hour, minute, second: 0, millisecond: 0 }).toUTC().toJSDate();
  }

  if (text.includes("lusa")) {
    const base = now.plus({ days: 2 }).startOf("day");
    const mt = text.match(timePattern);
    const hour = mt ? Number(mt[1]) : 9;
    const minute = mt && mt[2] ? Number(mt[2]) : 0;
    return base.set({ hour, minute, second: 0, millisecond: 0 }).toUTC().toJSDate();
  }

  // Absolute: "jam 14:00" / "pukul 9" / "20:15"
  if ((m = text.match(/(?:jam|pukul)\s*(\d{1,2})(?::|\.?)(\d{2})?/i)) || (m = text.match(/^(\d{1,2})(?::|\.)(\d{2})$/))) {
    const hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    let candidate = now.set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate <= now) candidate = candidate.plus({ days: 1 }); // kalau sudah lewat, pakai besok
    return candidate.toUTC().toJSDate();
  }

  return null; // tidak dikenal
}

// --- Helper: normalisasi activity dari tekstual follow-up (hindari "lagi", "ini", dst) ---
function normalizeActivity(activity, fallbackActivity) {
  if (!activity || !activity.trim()) return fallbackActivity || "";
  const bad = new Set(["lagi", "ini", "itu", "oke", "sip", "ok", "ya"]);
  const clean = activity.trim().toLowerCase();
  if (bad.has(clean)) return fallbackActivity || "";
  return activity;
}

// --- Optional: basic commands untuk in-memory scheduler ---
function isListCommand(text) {
  const t = text.toLowerCase();
  return t === "list" || t === "list reminder" || t === "tampilkan reminder";
}
function isCancelAllCommand(text) {
  const t = text.toLowerCase();
  return t.includes("batal semua") || t.includes("cancel all") || t.includes("stop semua");
}
function isCancelByKeyword(text) {
  // format: stop <nama activity>
  return /^stop\s+.+/i.test(text.trim());
}
function extractCancelKeyword(text) {
  const m = text.trim().match(/^stop\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

/**
 * Handler utama untuk pesan WA masuk
 */
export async function inbound(req, res) {
  try {
    const { from, text } = extractFromBody(req);
    if (!from || !text) {
      console.log("[WA] Invalid payload:", req.body);
      return res.sendStatus(400);
    }
    console.log("[WA] inbound from:", from, "text:", text);

    // Cek user
    const user = await db.User.findOne({ where: { phone: from } });
    if (!user) {
      await sendMessage(from, "Nomormu belum terdaftar. Yuk daftar dulu ya 😊");
      return res.sendStatus(200);
    }

    // Basic in-memory commands (opsional)
    if (isListCommand(text)) {
      const items = listReminders(user.id);
      if (!items.length) {
        await sendMessage(from, "Belum ada pengingat aktif 😊");
        return res.sendStatus(200);
      }
      let msg = `📋 *Daftar Pengingat Aktif (${items.length})*\n\n`;
      items.forEach((r, i) => {
        msg += `${i + 1}. *${r.activity}*\n   📅 ${formatWIB(r.time)}\n\n`;
      });
      msg += "Ketik: `stop <nama aktivitas>` untuk membatalkan salah satu.";
      await sendMessage(from, msg);
      return res.sendStatus(200);
    }

    if (isCancelAllCommand(text)) {
      cancelAllReminders(user.id);
      await sendMessage(from, "✅ Semua pengingat aktif dibatalkan.");
      return res.sendStatus(200);
    }

    if (isCancelByKeyword(text)) {
      const key = extractCancelKeyword(text);
      if (!key) {
        await sendMessage(from, "Format: `stop <nama aktivitas>`");
        return res.sendStatus(200);
      }
      const ok = cancelReminder(user.id, key);
      await sendMessage(from, ok ? `✅ Pengingat "${key}" dibatalkan.` : `Tidak ada pengingat dengan nama mengandung "${key}".`);
      return res.sendStatus(200);
    }

    // Ekstrak intent dari AI
    const extracted = await extractReminderData(text);
    const nowWIB = DateTime.now().setZone(WIB_TZ);

    let activity = (extracted?.activity || "").trim();
    let timeStr = (extracted?.time || "").trim();
    let intent = extracted?.intent || "unknown";

    // Skenario follow-up: user hanya memberi waktu → pakai pending activity
    const pending = pendingActivityByUser.get(user.id);
    if (intent === "need_content" && !activity && pending && nowWIB.toMillis() - pending.at < 15 * 60 * 1000) {
      activity = pending.activity;
      intent = "create";
    }

    // Jika AI salah membaca activity jadi kata filler, perbaiki dengan pending
    activity = normalizeActivity(activity, pending?.activity);

    if (intent === "need_time" && activity) {
      // Simpan pending activity agar follow-up "1 menit lagi" nempel
      pendingActivityByUser.set(user.id, { activity, at: Date.now() });

      const reply = await generateAIResponse([
        { role: "user", content: `User ingin membuat pengingat untuk "${activity}" tapi belum menyebut waktu.` }
      ]);
      await sendMessage(from, reply);
      return res.sendStatus(200);
    }

    if (intent === "need_content" && !activity) {
      const reply = await generateAIResponse([
        { role: "user", content: "User menyebut waktu tanpa aktivitas. Tanyakan dengan ramah aktivitasnya apa." }
      ]);
      await sendMessage(from, reply);
      return res.sendStatus(200);
    }

    if (intent === "create" && activity) {
      // Pastikan kita punya waktu yang bisa diparse
      let dueAt = parseNaturalTimeWIB(timeStr, nowWIB);
      if (!dueAt) {
        // AI memberi activity lengkap, tapi waktu tidak jelas → minta waktu
        pendingActivityByUser.set(user.id, { activity, at: Date.now() });
        const reply = await generateAIResponse([
          { role: "user", content: `Aktivitas "${activity}" sudah jelas, tapi waktu belum jelas. Minta user menyebut waktu (contoh: "jam 20.00", "1 jam lagi", "besok 08.00").` }
        ]);
        await sendMessage(from, reply);
        return res.sendStatus(200);
      }

      // Jika waktu sudah lewat (edge), geser 1 menit ke depan
      const jsNow = nowWIB.toUTC().toJSDate();
      if (dueAt <= jsNow) {
        dueAt = DateTime.fromJSDate(jsNow).plus({ minutes: 1 }).toUTC().toJSDate();
      }

      // Jadwalkan
      await scheduleReminder(user, activity, dueAt);

      // Clear pending yg sama
      if (pendingActivityByUser.get(user.id)?.activity === activity) {
        pendingActivityByUser.delete(user.id);
      }

      // Konfirmasi natural (biarkan AI bikin penutup 1 baris)
      const wibStr = formatWIB(dueAt);
      const confirm = await generateAIResponse([
        { role: "user", content: `Konfirmasi singkat: pengingat untuk "${activity}" pada ${wibStr}. Tambahkan penutup positif 1 kalimat, maksimal 1 baris.` }
      ]);
      await sendMessage(from, confirm);
      return res.sendStatus(200);
    }

    // Fallback: minta AI arahkan user
    const fallback = await generateAIResponse([{ role: "user", content: text }]);
    await sendMessage(from, fallback);
    return res.sendStatus(200);
  } catch (err) {
    console.error("[WA Controller] Fatal error:", err);
    try {
      const { from } = extractFromBody(req);
      if (from) await sendMessage(from, "Maaf, ada kendala di sistem. Coba lagi ya 🙏");
    } catch {}
    return res.sendStatus(500);
  }
}
