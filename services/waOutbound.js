// controllers/waController.js
import { DateTime } from "luxon";
import { Op } from "sequelize";
import db from "../models/index.js";
import { extractReminderData, generateAIResponse } from "../services/ai.js";
import { scheduleReminder, cancelReminder as cancelJob } from "../services/scheduler.js";
import { sendReminder } from "../services/waOutbound.js";

const WIB_TZ = "Asia/Jakarta";
const pendingActivityByUser = new Map(); // user.id -> { activity, at }
const lastListByUser = new Map();        // user.id -> [reminderIds]

// --- Helpers ---

function parseInbound(req) {
  if (req.body?.From && req.body?.Body) {
    return {
      from: String(req.body.From).replace(/^whatsapp:/, ""),
      text: String(req.body.Body || "").trim(),
      isTwilio: true
    };
  }
  return {
    from: String(req.body.from || "").trim(),
    text: String(req.body.text || "").trim(),
    isTwilio: false
  };
}

function formatWIB(date) {
  return DateTime.fromJSDate(date).setZone(WIB_TZ).toFormat("dd/MM/yyyy HH:mm 'WIB'");
}

function parseNaturalTimeWIB(raw, now = DateTime.now().setZone(WIB_TZ)) {
  if (!raw || typeof raw !== "string") return null;
  const text = raw.toLowerCase().trim();

  // ISO
  const iso = DateTime.fromISO(text, { zone: WIB_TZ });
  if (iso.isValid) return iso.toUTC().toJSDate();

  let m;
  // detik/menit/jam lagi
  if ((m = text.match(/(\d+)\s*detik(?:\s*lagi)?/i))) return now.plus({ seconds: Number(m[1]) }).toUTC().toJSDate();
  if ((m = text.match(/(\d+)\s*menit(?:\s*lagi)?/i))) return now.plus({ minutes: Number(m[1]) }).toUTC().toJSDate();
  if ((m = text.match(/(\d+)\s*jam(?:\s*lagi)?/i)))   return now.plus({ hours: Number(m[1]) }).toUTC().toJSDate();

  // besok/lusa [jam]
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

  // jam HH:mm / pukul HH / HH.mm / HH:MM
  if ((m = text.match(/(?:jam|pukul)\s*(\d{1,2})(?::|\.?)(\d{2})?/i)) || (m = text.match(/^(\d{1,2})(?::|\.)(\d{2})$/))) {
    const hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    let candidate = now.set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate <= now) candidate = candidate.plus({ days: 1 }); // kalau lewat → besok
    return candidate.toUTC().toJSDate();
  }

  return null;
}

function normalizeActivity(act, fallback) {
  if (!act || !act.trim()) return fallback || "";
  const bad = new Set(["lagi","ini","itu","oke","sip","ok","ya"]);
  const clean = act.trim().toLowerCase();
  if (bad.has(clean)) return fallback || "";
  return act.trim();
}

function sendText(from, text) {
  return sendReminder(from, text, null);
}

// --- Cancel/List commands ---

function isListCmd(t) {
  const s = t.toLowerCase();
  return s === "list" || s === "list reminder" || s === "tampilkan reminder";
}
function isKeywordCmd(t) {
  return /^--reminder\s+.+/i.test(t.trim());
}
function getKeyword(t) {
  const m = t.trim().match(/^--reminder\s+(.+)$/i);
  return m ? m[1].trim() : "";
}
function isStopNumberCmd(t) {
  return /^stop\s*\(\s*\d+\s*\)\s*$/i.test(t.trim());
}
function getStopIndex(t) {
  const m = t.trim().match(/^stop\s*\(\s*(\d+)\s*\)\s*$/i);
  return m ? Number(m[1]) : null;
}

// --- Controller ---

export async function inbound(req, res) {
  try {
    const { from, text, isTwilio } = parseInbound(req);
    if (!from || !text) return res.sendStatus(400);

    console.log("[WA] inbound from:", from, "text:", text);

    // User
    const user = await db.User.findOne({ where: { phone: from } });
    if (!user) {
      await sendText(from, "Nomormu belum terdaftar di sistem. Silakan daftar dulu ya 😊");
      return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
    }

    // 1) LIST semua reminder aktif
    if (isListCmd(text)) {
      const items = await db.Reminder.findAll({
        where: { UserId: user.id, status: "scheduled" },
        order: [["dueAt", "ASC"]],
        limit: 20
      });
      if (!items.length) {
        await sendText(from, "Belum ada pengingat aktif 😊");
        return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
      }
      let msg = `📋 *Daftar Pengingat Aktif (${items.length}):*\n\n`;
      const ids = [];
      items.forEach((r, i) => {
        ids.push(r.id);
        msg += `${i + 1}. *${r.title}*\n   📅 ${formatWIB(r.dueAt)}\n\n`;
      });
      lastListByUser.set(user.id, ids);
      msg += "Ketik: `stop (1)` untuk membatalkan pengingat nomor 1.";
      await sendText(from, msg);
      return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
    }

    // 2) --reminder <keyword> → list filter
    if (isKeywordCmd(text)) {
      const keyword = getKeyword(text);
      const items = await db.Reminder.findAll({
        where: {
          UserId: user.id,
          status: "scheduled",
          title: { [Op.iLike]: `%${keyword}%` }
        },
        order: [["dueAt", "ASC"]],
        limit: 20
      });
      if (!items.length) {
        await sendText(from, `Tidak ada pengingat aktif terkait '${keyword}' nih. Mau cek semua reminder kamu? Ketik 'list reminder' ya 😊`);
        return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
      }
      let msg = `Berikut pengingat aktif terkait '${keyword}':\n`;
      const ids = [];
      items.forEach((r, i) => {
        ids.push(r.id);
        msg += `${i + 1}. ${r.title} - ${DateTime.fromJSDate(r.dueAt).setZone(WIB_TZ).toFormat("dd/MM HH:mm")} WIB\n`;
      });
      msg += `\nKirim pesan: \`stop (1)\` untuk membatalkan pengingat nomor 1, dan seterusnya.`;
      lastListByUser.set(user.id, ids);
      await sendText(from, msg);
      return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
    }

    // 3) stop (No)
    if (isStopNumberCmd(text)) {
      const idx = getStopIndex(text);
      const list = lastListByUser.get(user.id) || [];
      if (!idx || idx < 1 || idx > list.length) {
        await sendText(from, "Nomor yang kamu kirim belum cocok nih 😅 Coba cek lagi daftar reminder-nya ya.");
        return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
      }
      const reminderId = list[idx - 1];
      const rem = await db.Reminder.findByPk(reminderId);
      if (!rem || rem.status !== "scheduled" || rem.UserId !== user.id) {
        await sendText(from, "Pengingatnya sudah tidak aktif atau tidak ditemukan.");
        return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
      }
      // batalkan
      rem.status = "cancelled";
      await rem.save();
      cancelJob?.(rem.id);
      await sendText(from, `✅ Reminder nomor ${idx} sudah dibatalkan. Kalau kamu butuh pengingat baru, tinggal bilang aja ya 😊`);
      return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
    }

    // 4) Intent & dialog pembuatan reminder
    const extracted = await extractReminderData(text);
    const nowWIB = DateTime.now().setZone(WIB_TZ);
    let activity = normalizeActivity(extracted?.activity, pendingActivityByUser.get(user.id)?.activity);
    let timeStr = (extracted?.time || "").trim();
    let intent = extracted?.intent || "unknown";

    // potential_reminder
    if (intent === "potential_reminder") {
      await sendText(from, "Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?");
      // simpan judul kalau ada
      if (activity) pendingActivityByUser.set(user.id, { activity, at: Date.now() });
      return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
    }

    // need_time: ada aktivitas, belum ada waktu
    if (intent === "need_time" && activity) {
      pendingActivityByUser.set(user.id, { activity, at: Date.now() });
      await sendText(from, `Siap! Untuk '${activity}', kamu mau diingatkan kapan?`);
      return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
    }

    // need_content: ada waktu, belum ada aktivitas → pakai pending jika ada
    if (intent === "need_content" && !activity) {
      const pending = pendingActivityByUser.get(user.id);
      if (pending && nowWIB.toMillis() - pending.at < 15 * 60 * 1000) {
        activity = pending.activity;
        intent = "create";
      } else {
        await sendText(from, "Noted jamnya! Kamu mau diingatkan tentang apa ya?");
        return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
      }
    }

    // create
    if (intent === "create" && activity) {
      let dueAt = parseNaturalTimeWIB(timeStr, nowWIB);
      if (!dueAt) {
        pendingActivityByUser.set(user.id, { activity, at: Date.now() });
        await sendText(from, `Waktunya belum aku dapat nih untuk '${activity}'. Kamu mau diingatkan jam berapa?`);
        return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
      }

      // jika waktu mundur, geser +1 menit
      if (dueAt <= nowWIB.toUTC().toJSDate()) {
        dueAt = nowWIB.plus({ minutes: 1 }).toUTC().toJSDate();
      }

      // simpan DB
      const reminder = await db.Reminder.create({
        UserId: user.id,
        RecipientId: user.id,
        title: activity,
        dueAt,
        repeat: "none",
        status: "scheduled",
        formattedMessage: `Halo ${user.username || "kamu"}, ini pengingatmu untuk '${activity}'. Semoga harimu berjalan lancar ya ✨🙏`
      });

      // jadwalkan
      await scheduleReminder(reminder);

      // konfirmasi sesuai contoh
      const timeDesc = (() => {
        const sched = DateTime.fromJSDate(dueAt).setZone(WIB_TZ);
        const diffMin = Math.round(sched.diff(nowWIB, "minutes").minutes);
        if (diffMin < 60) return `${diffMin} menit lagi`;
        if (sched.hasSame(nowWIB, "day")) return `hari ini jam ${sched.toFormat("HH:mm")} WIB`;
        if (sched.hasSame(nowWIB.plus({ days: 1 }), "day")) return `besok jam ${sched.toFormat("HH:mm")} WIB`;
        return sched.toFormat("dd/MM/yyyy HH:mm 'WIB'");
      })();

      await sendText(from, `✅ Siap, ${user.username || "kamu"}! Aku akan ingatkan kamu untuk '${activity}' ${timeDesc}. 😊`);
      pendingActivityByUser.delete(user.id);
      return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
    }

    // fallback ramah
    // (contoh greet / tidak jelas)
    await sendText(from,
      "Aku bisa bantu bikin pengingat biar nggak lupa. 😊\nTulis: \"ingatkan saya <aktivitas> <waktu>\".\nContoh: \"ingatkan saya makan malam jam 20.00\" atau \"ingatkan saya minum obat 30 menit lagi\"."
    );
    return res.status(200).type("text/xml").send(isTwilio ? "<Response/>" : "OK");
  } catch (err) {
    console.error("[WA Controller] Fatal error:", err);
    try {
      const { from } = parseInbound(req);
      if (from) await sendText(from, "Maaf, ada kendala di sistem. Coba lagi ya 🙏");
    } catch {}
    return res.sendStatus(500);
  }
}
