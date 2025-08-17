// Debug test for "stop (1)" parsing
console.log('🔍 Testing "stop (1)" parsing...\n');

// Test direct pattern matching
const testTexts = [
  'stop (1)',
  'stop(1)', 
  'stop 1',
  'stop (2)',
  'cancel (1)',
  '1',
  'batal (1)'
];

console.log('📋 Testing pattern matching:\n');

testTexts.forEach(text => {
  // Test regex patterns that should detect stop number
  const patterns = [
    /stop\s*\(\s*(\d+)\s*\)/i,      // stop (1)
    /stop\s+(\d+)/i,                // stop 1  
    /batal\s*\(\s*(\d+)\s*\)/i,     // batal (1)
    /^\s*(\d+)\s*$/,                // just number
  ];
  
  let matched = false;
  let extractedNumber = null;
  
  patterns.forEach((pattern, idx) => {
    const match = text.match(pattern);
    if (match && !matched) {
      matched = true;
      extractedNumber = parseInt(match[1]);
      console.log(`✅ "${text}" → Pattern ${idx+1} → Number: ${extractedNumber}`);
    }
  });
  
  if (!matched) {
    console.log(`❌ "${text}" → No match`);
  }
});

console.log('\n🤖 Expected AI Response for "stop (1)":');
console.log(`{
  "intent": "stop_number",
  "stopNumber": 1,
  "conversationalResponse": "Membatalkan reminder nomor 1..."
}`);

console.log('\n🎯 Possible Issues:');
console.log('1. AI tidak mendeteksi pattern "stop (1)" dengan benar');
console.log('2. Fallback pattern tidak mencakup format ini');
console.log('3. Context lastListedIds tidak tersimpan dengan benar');
console.log('4. Session context terhapus setelah list');

console.log('\n💡 Solution:');
console.log('- Tambah fallback pattern matching di waController');
console.log('- Pastikan session context preserved');
console.log('- Improve AI system prompt untuk stop pattern');
