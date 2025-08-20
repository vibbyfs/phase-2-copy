// helpers/multiRecipient.js (CommonJS)
const { Op } = require('sequelize');
const { User } = require('../models');

// Friend model opsional: kalau ada dipakai utk validasi relasi,
// kalau tidak ada, proses tetap jalan tanpa memblokir.
let Friend = null;
try {
  // Sesuaikan bila nama model berbeda (Friend / Friendship)
  ({ Friend } = require('../models'));
} catch (_) {
  // no-op, fallback tanpa cek friend
}

/**
 * Ambil daftar username dari teks dengan format @username
 * - hanya menangkap yang diawali '@'
 * - dedupe & pertahankan urutan kemunculan
 */
function parseUsernamesFromMessage(text = '') {
  const out = [];
  const seen = new Set();
  const re = /@([a-zA-Z0-9._-]{2,32})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const u = m[1].trim();
    const key = u.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}

/**
 * Validasi username -> return user rows yang valid,
 * kumpulkan yang tidak ditemukan / bukan teman.
 * @param {number} senderUserId
 * @param {string[]} usernames - daftar username (tanpa '@')
 */
async function validateAndGetRecipients(senderUserId, usernames = []) {
  const uniq = [];
  const seen = new Set();
  for (const u of usernames) {
    const key = String(u || '').toLowerCase();
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      uniq.push(u);
    }
  }

  if (uniq.length === 0) {
    return {
      validUsers: [],
      invalidUsernames: [],
      notFriends: [],
      selfMentions: []
    };
  }

  // Ambil user berdasarkan username (case-insensitive)
  const rows = await User.findAll({
    where: {
      username: {
        [Op.in]: uniq
      }
    },
    attributes: ['id', 'username', 'phone']
  });

  // Map untuk bandingkan case-insensitive
  const mapByLower = new Map((rows || []).map(u => [String(u.username).toLowerCase(), u]));
  const validUsers = [];
  const invalidUsernames = [];
  const selfMentions = [];

  for (const raw of uniq) {
    const low = raw.toLowerCase();
    const user = mapByLower.get(low);
    if (!user) {
      invalidUsernames.push(raw);
      continue;
    }
    if (user.id === senderUserId) {
      selfMentions.push(raw);
      // di-allow: tergantung kebutuhan. Di sini kita izinkan mention diri sendiri
      // untuk konsistensi, masukkan juga ke validUsers agar tidak hilang.
      validUsers.push(user);
    } else {
      validUsers.push(user);
    }
  }

  // Cek relasi pertemanan bila model Friend tersedia
  let notFriends = [];
  if (Friend && validUsers.length > 0) {
    const targetIds = validUsers.map(u => u.id);
    const friendships = await Friend.findAll({
      where: {
        status: 'accepted',
        [Op.or]: [
          { UserId: senderUserId, FriendId: { [Op.in]: targetIds } },
          { FriendId: senderUserId, UserId: { [Op.in]: targetIds } }
        ]
      },
      attributes: ['UserId', 'FriendId', 'status']
    });

    const okSet = new Set();
    for (const f of friendships) {
      // Tambahkan id lawan (temannya)
      if (f.UserId === senderUserId) okSet.add(f.FriendId);
      if (f.FriendId === senderUserId) okSet.add(f.UserId);
    }

    for (const u of validUsers) {
      if (u.id !== senderUserId && !okSet.has(u.id)) {
        notFriends.push(u.username);
      }
    }
  } else {
    // Jika tidak ada model Friend, asumsikan semua boleh (agar tidak memblokir alur)
    notFriends = [];
  }

  return {
    validUsers,
    invalidUsernames,
    notFriends,
    selfMentions
  };
}

/**
 * Template pesan multi-recipient untuk disimpan di Reminder.formattedMessage.
 * Scheduler akan mem-personalisasi saat kirim:
 * - Jika pesan mengandung {RECIPIENT_NAME}, scheduler replace namanya.
 * - Jika pesan mengandung {AI_MOTIVATIONAL}, scheduler minta AI bikin pesan motivasional
 *   yang sudah personal (berdasarkan title & nama).
 *
 * Catatan:
 * - Agar tidak terjadi duplikasi salam, template ini TIDAK menambahkan salam apa pun;
 *   biarkan AI yang menyusun salam & motivasi final.
 * - Kita tetap menyertakan {RECIPIENT_NAME} agar branch personalisasi scheduler terpakai.
 */
function generateMultiRecipientMessage(baseFormattedMessage, recipients = [], senderUser) {
  // baseFormattedMessage tidak dipakai langsung di multi-recipient agar konsisten & bebas duplikasi.
  // Template minimalis yang memicu kedua placeholder:
  // Hasil akhir akan menjadi output AI yang sudah personal (dengan salam & emotikon).
  const creator = senderUser?.username ? `@${senderUser.username}` : 'seorang teman';
  // Jika ingin menampilkan info pengirim secara halus, tambahkan satu baris kecil:
  // (gunakan baris kedua agar tidak bentrok dengan AI output)
  // Contoh akhir (setelah replace): 
  //   "Halo Rina, waktunya minum air! ... 💧"
  //   "\n— dari @vibbyfs"
  return `{AI_MOTIVATIONAL}\n— dari ${creator} untuk {RECIPIENT_NAME}`;
}

/**
 * Pemeriksaan izin tambahan (opsional).
 * Saat ini hanya membungkus hasil dari validateAndGetRecipients.
 */
async function checkRecipientPermissions(senderUserId, usernames = []) {
  const res = await validateAndGetRecipients(senderUserId, usernames);
  const allowed = res.invalidUsernames.length === 0 && res.notFriends.length === 0;
  return {
    allowed,
    ...res
  };
}

module.exports = {
  parseUsernamesFromMessage,
  validateAndGetRecipients,
  generateMultiRecipientMessage,
  checkRecipientPermissions
};
