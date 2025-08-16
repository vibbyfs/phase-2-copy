// Test fallback parser tanpa API OpenAI
const { DateTime } = require('luxon');

// Import hanya utility functions dari ai.js
const fs = require('fs');
const path = require('path');

// Mock fallback parser dari ai.js
const WIB_TZ = 'Asia/Jakarta';

function extractUsernames(message) {
  const usernameRegex = /@(\w+)/g;
  const matches = message.match(usernameRegex);
  return matches || [];
}

function extractTitleFromText(text) {
  const t = text.toLowerCase();
  
  // Remove common words
  const cleaned = t
    .replace(/\b(tolong|mohon|bisa|minta|please|ingetin|ingatkan|reminder|pengingat|setiap|every)\b/gi, '')
    .replace(/\b(hari|jam|menit|bulan|minggu|daily|weekly|monthly|hourly)\b/gi, '')
    .replace(/\b(saya|aku|gue|gua|ane|i|me)\b/gi, '')
    .replace(/\d+/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length > 2);
  const title = words.slice(0, 3).join(' ');
  
  return title || 'Reminder';
}

function fallbackParser(message) {
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const text = message.toLowerCase();
  
  // Check for cancel keyword pattern --reminder [keyword]
  const cancelKeywordMatch = text.match(/--reminder\s+(.+)/i);
  if (cancelKeywordMatch) {
    return { 
      intent: 'cancel_keyword', 
      title: '', 
      recipientUsernames: [], 
      timeType: 'relative', 
      dueAtWIB: null, 
      repeat: 'none', 
      repeatDetails: {}, 
      cancelKeyword: cancelKeywordMatch[1].trim(),
      stopNumber: null,
      conversationalResponse: `Mencari pengingat terkait '${cancelKeywordMatch[1].trim()}'...`
    };
  }

  // Check for stop number pattern stop (1), stop (2), etc
  const stopNumberMatch = text.match(/stop\s*\((\d+)\)/i);
  if (stopNumberMatch) {
    return { 
      intent: 'stop_number', 
      title: '', 
      recipientUsernames: [], 
      timeType: 'relative', 
      dueAtWIB: null, 
      repeat: 'none', 
      repeatDetails: {}, 
      cancelKeyword: null,
      stopNumber: stopNumberMatch[1],
      conversationalResponse: `Membatalkan reminder nomor ${stopNumberMatch[1]}...`
    };
  }
  
  // Potential reminder detection (natural language without explicit keywords)
  const potentialKeywords = ['nanti', 'besok', 'jemput', 'meeting', 'minum obat', 'lupa', 'semoga', 'rapat', 'penting'];
  const hasPotentialKeyword = potentialKeywords.some(keyword => text.includes(keyword));
  const hasExplicitKeyword = text.includes('ingatkan') || text.includes('reminder') || text.includes('pengingat');
  
  if (hasPotentialKeyword && !hasExplicitKeyword) {
    return {
      intent: 'potential_reminder',
      title: extractTitleFromText(message),
      recipientUsernames: extractUsernames(message),
      timeType: 'relative',
      dueAtWIB: null,
      repeat: 'none',
      repeatDetails: {},
      cancelKeyword: null,
      stopNumber: null,
      conversationalResponse: "Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?"
    };
  }

  // Parse time - relative patterns
  let dueAtWIB = null;
  let repeat = 'none';
  let timeType = 'relative';
  let repeatDetails = {};

  // Relative time patterns
  const minuteMatch = text.match(/(\d+)\s*menit/i);
  const hourMatch = text.match(/(\d+)\s*jam/i);
  const secondMatch = text.match(/(\d+)\s*detik/i);
  
  // Check if we have content but no time (need_time) or time but no content (need_content)
  const hasReminderKeyword = text.includes('ingatkan') || text.includes('reminder') || text.includes('pengingat');
  const title = extractTitleFromText(message);
  const hasTimeInfo = minuteMatch || hourMatch || secondMatch || text.includes('besok') || text.includes('lusa') || text.includes('jam');
  const hasContentInfo = title && title !== 'Reminder' && title.length > 0;

  if (hasReminderKeyword) {
    if (hasContentInfo && !hasTimeInfo) {
      return {
        intent: 'need_time',
        title: title,
        recipientUsernames: extractUsernames(message),
        timeType: 'relative',
        dueAtWIB: null,
        repeat: 'none',
        repeatDetails: {},
        cancelKeyword: null,
        stopNumber: null,
        conversationalResponse: `Siap! Untuk '${title}', kamu mau diingatkan kapan?`
      };
    } else if (hasTimeInfo && !hasContentInfo) {
      let dueAtWIB = null;
      if (minuteMatch) {
        dueAtWIB = nowWIB.plus({ minutes: parseInt(minuteMatch[1]) }).toISO();
      } else if (hourMatch) {
        dueAtWIB = nowWIB.plus({ hours: parseInt(hourMatch[1]) }).toISO();
      } else if (text.includes('besok')) {
        dueAtWIB = nowWIB.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
      }
      
      return {
        intent: 'need_content',
        title: '',
        recipientUsernames: extractUsernames(message),
        timeType: hasTimeInfo ? 'absolute' : 'relative',
        dueAtWIB: dueAtWIB,
        repeat: 'none',
        repeatDetails: {},
        cancelKeyword: null,
        stopNumber: null,
        conversationalResponse: "Noted jamnya! Kamu mau diingatkan tentang apa ya?"
      };
    }
  }

  // Default parsing untuk create
  if (minuteMatch) {
    dueAtWIB = nowWIB.plus({ minutes: parseInt(minuteMatch[1]) }).toISO();
  } else if (hourMatch) {
    dueAtWIB = nowWIB.plus({ hours: parseInt(hourMatch[1]) }).toISO();
  } else if (secondMatch) {
    dueAtWIB = nowWIB.plus({ seconds: parseInt(secondMatch[1]) }).toISO();
  } else if (text.includes('besok')) {
    timeType = 'absolute';
    dueAtWIB = nowWIB.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
  } else if (text.includes('lusa')) {
    timeType = 'absolute';
    dueAtWIB = nowWIB.plus({ days: 2 }).set({ hour: 9, minute: 0, second: 0 }).toISO();
  }

  // Default fallback
  if (!dueAtWIB) {
    dueAtWIB = nowWIB.plus({ minutes: 5 }).toISO();
  }

  return {
    intent: 'create',
    title: extractTitleFromText(message),
    recipientUsernames: extractUsernames(message),
    timeType,
    dueAtWIB,
    repeat,
    repeatDetails,
    cancelKeyword: null,
    stopNumber: null,
    conversationalResponse: null
  };
}

function generateConversationalResponse(intent, context = {}) {
  const { title, userName, cancelKeyword, stopNumber, timeInfo } = context;
  const name = userName || 'kamu';

  switch (intent) {
    case 'potential_reminder':
      return "Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?";
    
    case 'need_time':
      return `Siap! Untuk '${title}', kamu mau diingatkan kapan?`;
    
    case 'need_content':
      return "Noted jamnya! Kamu mau diingatkan tentang apa ya?";
    
    case 'create':
      return `✅ Siap, ${name}! Aku akan ingatkan kamu untuk '${title}' ${timeInfo}. 😊`;
    
    case 'stop_success':
      return `✅ Reminder nomor ${stopNumber} sudah dibatalkan. Kalau kamu butuh pengingat baru, tinggal bilang aja ya 😊`;
    
    default:
      return "Maaf, aku belum paham maksudmu. Bisa dijelaskan lagi? 😊";
  }
}

function generateReminderList(reminders, keyword) {
  if (!reminders || reminders.length === 0) {
    return `Tidak ada pengingat aktif terkait '${keyword}' nih. Mau cek semua reminder kamu? Ketik 'list reminder' ya 😊`;
  }

  let response = `Berikut pengingat aktif terkait '${keyword}':\n`;
  reminders.forEach((reminder, index) => {
    const time = new Date(reminder.dueAt).toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
    response += `${index + 1}. ${reminder.title} - ${time}\n`;
  });
  
  response += `\nKirim pesan: \`stop (1)\` untuk membatalkan pengingat nomor 1, dan seterusnya.`;
  
  return response;
}

// Test cases
console.log('🧪 Testing AI Service Fallback Parser...\n');

const testCases = [
  {
    name: 'Potential reminder detection',
    input: 'jemput John nanti',
    expected: 'potential_reminder'
  },
  {
    name: 'Need time scenario',
    input: 'ingatkan saya minum obat',
    expected: 'need_time'
  },
  {
    name: 'Need content scenario', 
    input: 'ingatkan saya jam 3',
    expected: 'need_content'
  },
  {
    name: 'Cancel keyword pattern',
    input: '--reminder makan',
    expected: 'cancel_keyword'
  },
  {
    name: 'Stop number pattern',
    input: 'stop (1)',
    expected: 'stop_number'
  },
  {
    name: 'Complete reminder',
    input: 'ingatkan saya minum obat 30 menit lagi',
    expected: 'create'
  },
  {
    name: 'Natural language potential',
    input: 'besok ada rapat penting',
    expected: 'potential_reminder'
  }
];

testCases.forEach((testCase, index) => {
  console.log(`${index + 1}. ${testCase.name}:`);
  console.log(`Input: "${testCase.input}"`);
  
  const result = fallbackParser(testCase.input);
  console.log(`Intent: ${result.intent} (expected: ${testCase.expected})`);
  console.log(`Title: ${result.title}`);
  if (result.conversationalResponse) {
    console.log(`Response: ${result.conversationalResponse}`);
  }
  console.log(`✅ ${result.intent === testCase.expected ? 'PASS' : 'FAIL'}`);
  console.log('---\n');
});

// Test conversational responses
console.log('🗨️ Testing Conversational Responses:');
const responses = [
  generateConversationalResponse('potential_reminder'),
  generateConversationalResponse('need_time', { title: 'Minum Obat' }),
  generateConversationalResponse('need_content'),
  generateConversationalResponse('stop_success', { stopNumber: '1' })
];

responses.forEach((response, index) => {
  console.log(`${index + 1}. ${response}`);
});

// Test reminder list
console.log('\n📋 Testing Reminder List Generation:');
const mockReminders = [
  { title: 'Makan siang', dueAt: new Date().toISOString() },
  { title: 'Makan malam', dueAt: new Date(Date.now() + 3600000).toISOString() }
];
const listResponse = generateReminderList(mockReminders, 'makan');
console.log(listResponse);

console.log('\n✅ All fallback tests completed!');
