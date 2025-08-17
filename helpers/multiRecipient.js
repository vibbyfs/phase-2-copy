const { User, Friend } = require('../models');

/**
 * Parse usernames dari message text yang menggunakan @username syntax
 * @param {string} message - Pesan yang mengandung @username
 * @returns {object} - { message: cleanedMessage, usernames: extractedUsernames }
 */
function parseUsernamesFromMessage(message) {
  // Regex untuk mendeteksi @username (alphanumeric + underscore)
  const usernameRegex = /@([a-zA-Z0-9_]+)/g;
  const matches = [];
  let match;

  while ((match = usernameRegex.exec(message)) !== null) {
    matches.push(match[1]); // ambil username tanpa @
  }

  // Remove duplicates
  const uniqueUsernames = [...new Set(matches)];

  // Clean message dari @username mentions
  const cleanMessage = message.replace(usernameRegex, '').replace(/\s+/g, ' ').trim();

  return {
    message: cleanMessage,
    usernames: uniqueUsernames
  };
}

/**
 * Validasi dan ambil user IDs berdasarkan usernames dan friendship status
 * @param {number} creatorUserId - ID user yang membuat reminder
 * @param {string[]} usernames - Array username yang di-mention
 * @returns {object} - { validUsers: User[], invalidUsernames: string[], notFriends: string[] }
 */
async function validateAndGetRecipients(creatorUserId, usernames) {
  if (!usernames || usernames.length === 0) {
    return { validUsers: [], invalidUsernames: [], notFriends: [] };
  }

  const results = {
    validUsers: [],
    invalidUsernames: [],
    notFriends: []
  };

  for (const username of usernames) {
    try {
      // Cari user berdasarkan username
      const user = await User.findOne({
        where: { username: username },
        attributes: ['id', 'username', 'phone']
      });

      if (!user) {
        results.invalidUsernames.push(username);
        continue;
      }

      // Skip jika user mention dirinya sendiri
      if (user.id === creatorUserId) {
        continue;
      }

      // Cek friendship status
      const friendship = await Friend.findOne({
        where: {
          UserId: creatorUserId,
          FriendId: user.id,
          status: 'accepted'
        }
      });

      if (!friendship) {
        results.notFriends.push(username);
        continue;
      }

      results.validUsers.push(user);

    } catch (error) {
      console.error(`Error validating user ${username}:`, error);
      results.invalidUsernames.push(username);
    }
  }

  return results;
}

/**
 * Generate formatted message untuk multiple recipients
 * @param {string} originalMessage - Pesan asli
 * @param {User[]} recipients - Array recipient users
 * @param {User} creator - User yang membuat reminder
 * @returns {string} - Formatted message
 */
function generateMultiRecipientMessage(originalMessage, recipients, creator) {
  if (!recipients || recipients.length === 0) {
    return originalMessage;
  }

  const recipientNames = recipients.map(user => user.username).join(', ');
  
  return `📝 *Reminder untuk: ${recipientNames}*\n\n${originalMessage}\n\n_Dibuat oleh: ${creator.username}_`;
}

/**
 * Check apakah user memiliki permission untuk membuat reminder untuk recipients tertentu
 * @param {number} creatorUserId - ID user creator
 * @param {number[]} recipientIds - Array recipient user IDs
 * @returns {boolean} - True jika semua recipients adalah friends
 */
async function checkRecipientPermissions(creatorUserId, recipientIds) {
  if (!recipientIds || recipientIds.length === 0) {
    return true;
  }

  try {
    const friendCount = await Friend.count({
      where: {
        UserId: creatorUserId,
        FriendId: recipientIds,
        status: 'accepted'
      }
    });

    return friendCount === recipientIds.length;
  } catch (error) {
    console.error('Error checking recipient permissions:', error);
    return false;
  }
}

module.exports = {
  parseUsernamesFromMessage,
  validateAndGetRecipients,
  generateMultiRecipientMessage,
  checkRecipientPermissions
};
