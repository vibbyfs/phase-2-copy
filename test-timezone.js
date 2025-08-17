// test-timezone.js - Test timezone conversion fix
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

function parseISOToUTC_OLD(isoString) {
  const dt = dayjs.tz(isoString, 'Asia/Jakarta');
  return dt.utc().toDate();
}

function parseISOToUTC_NEW(isoString) {
  const dt = dayjs(isoString);
  return dt.utc().toDate();
}

const testInput = '2025-08-17T15:27:43.894+07:00';

console.log('🧪 Testing Timezone Conversion Fix');
console.log('=====================================');
console.log(`Input: ${testInput}`);
console.log('');

console.log('❌ OLD Method (buggy):');
const oldResult = parseISOToUTC_OLD(testInput);
console.log(`UTC Result: ${oldResult.toISOString()}`);
console.log(`Expected: 2025-08-17T08:27:43.894Z (15:27 - 7 hours)`);
console.log('');

console.log('✅ NEW Method (fixed):');
const newResult = parseISOToUTC_NEW(testInput);
console.log(`UTC Result: ${newResult.toISOString()}`);
console.log(`Expected: 2025-08-17T08:27:43.894Z (15:27 - 7 hours)`);
console.log('');

const expectedUTC = '2025-08-17T08:27:43.894Z';
const isNewCorrect = newResult.toISOString() === expectedUTC;

console.log(`🎯 Fix Status: ${isNewCorrect ? 'SUCCESS ✅' : 'FAILED ❌'}`);

if (isNewCorrect) {
  console.log('');
  console.log('✅ Timezone conversion fixed!');
  console.log('✅ "2 menit lagi" reminders will now work properly');
  console.log('✅ Ready for PM2 restart');
}
