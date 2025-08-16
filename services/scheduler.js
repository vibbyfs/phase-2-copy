import schedule from "node-schedule";
import { sendMessage } from "./waOutbound.js";

/**
 * Simpan jadwal reminder yang aktif
 * Struktur: { [userId]: [ { job, activity, time } ] }
 */
const reminders = {};

/**
 * Format waktu untuk ditampilkan ke user
 */
function formatDateTime(date) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "full",
    timeStyle: "short",
  }).format(date);
}

/**
 * Buat jadwal reminder
 */
export async function scheduleReminder(user, activity, time) {
  if (!user || !user.phone) {
    throw new Error("User tidak valid untuk membuat pengingat.");
  }

  let reminderTime;

  if (typeof time === "string" || typeof time === "number") {
    // Bisa berupa "in 5 minutes" atau timestamp
    reminderTime = new Date(time);
  } else if (time instanceof Date) {
    reminderTime = time;
  } else {
    throw new Error("Format waktu tidak dikenali.");
  }

  if (reminderTime < new Date()) {
    throw new Error("Waktu pengingat sudah lewat.");
  }

  // Buat job baru
  const job = schedule.scheduleJob(reminderTime, async () => {
    try {
      const message = `🔔 Hai ${user.username || "teman"}! Ini pengingatmu untuk *${activity}* sekarang. Semangat ya! ✨`;
      await sendMessage(user.phone, message);
    } catch (err) {
      console.error("[Scheduler] Gagal kirim pengingat:", err);
    }
  });

  // Simpan job ke daftar reminders
  if (!reminders[user.id]) reminders[user.id] = [];
  reminders[user.id].push({ job, activity, time: reminderTime });

  console.log(
    `[Scheduler] Reminder dibuat: ${activity} untuk ${user.phone} pada ${reminderTime}`
  );

  return {
    activity,
    time: formatDateTime(reminderTime),
  };
}

/**
 * Lihat semua reminder aktif untuk user
 */
export function listReminders(userId) {
  return reminders[userId] || [];
}

/**
 * Batalkan reminder tertentu
 */
export function cancelReminder(userId, activity) {
  if (!reminders[userId]) return false;
  reminders[userId] = reminders[userId].filter((rem) => {
    if (rem.activity === activity) {
      rem.job.cancel();
      return false;
    }
    return true;
  });
  return true;
}

/**
 * Batalkan semua reminder user
 */
export function cancelAllReminders(userId) {
  if (!reminders[userId]) return;
  reminders[userId].forEach((rem) => rem.job.cancel());
  reminders[userId] = [];
}
