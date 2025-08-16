const { extract, generateConversationalResponse, generateReminderList } = require('./services/ai.js');

async function testAI() {
  console.log('🧪 Testing AI Service Updates...\n');

  // Test 1: Potential reminder detection (natural language)
  console.log('1. Testing potential reminder detection:');
  try {
    const result1 = await extract("jemput John nanti");
    console.log('Input: "jemput John nanti"');
    console.log('Output:', JSON.stringify(result1, null, 2));
    console.log('---\n');
  } catch (error) {
    console.log('Error:', error.message);
    console.log('---\n');
  }

  // Test 2: Need time scenario
  console.log('2. Testing need time scenario:');
  try {
    const result2 = await extract("ingatkan saya minum obat");
    console.log('Input: "ingatkan saya minum obat"');
    console.log('Output:', JSON.stringify(result2, null, 2));
    console.log('---\n');
  } catch (error) {
    console.log('Error:', error.message);
    console.log('---\n');
  }

  // Test 3: Cancel keyword pattern
  console.log('3. Testing cancel keyword pattern:');
  try {
    const result3 = await extract("--reminder makan");
    console.log('Input: "--reminder makan"');
    console.log('Output:', JSON.stringify(result3, null, 2));
    console.log('---\n');
  } catch (error) {
    console.log('Error:', error.message);
    console.log('---\n');
  }

  // Test 4: Stop number pattern
  console.log('4. Testing stop number pattern:');
  try {
    const result4 = await extract("stop (1)");
    console.log('Input: "stop (1)"');
    console.log('Output:', JSON.stringify(result4, null, 2));
    console.log('---\n');
  } catch (error) {
    console.log('Error:', error.message);
    console.log('---\n');
  }

  // Test 5: Conversational responses
  console.log('5. Testing conversational responses:');
  const responses = [
    generateConversationalResponse('potential_reminder'),
    generateConversationalResponse('need_time', { title: 'Minum Obat' }),
    generateConversationalResponse('need_content'),
    generateConversationalResponse('stop_success', { stopNumber: '1' })
  ];
  
  responses.forEach((response, index) => {
    console.log(`Response ${index + 1}:`, response);
  });
  console.log('---\n');

  // Test 6: Reminder list generation
  console.log('6. Testing reminder list generation:');
  const mockReminders = [
    { title: 'Makan siang', dueAt: new Date().toISOString() },
    { title: 'Makan malam', dueAt: new Date(Date.now() + 3600000).toISOString() }
  ];
  const listResponse = generateReminderList(mockReminders, 'makan');
  console.log('Reminder List Response:');
  console.log(listResponse);

  console.log('\n✅ All tests completed!');
}

testAI().catch(console.error);
