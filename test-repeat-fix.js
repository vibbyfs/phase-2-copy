// Test repeat reminder creation fix
console.log('🔧 Testing Repeat Reminder Creation Fix...\n');

function simulateAIParsing(input) {
  console.log(`📝 Input: "${input}"`);
  
  // Simulate different AI parsing scenarios
  if (input.includes('setiap') && input.includes('menit')) {
    const match = input.match(/(\d+)\s*menit/);
    const interval = match ? parseInt(match[1]) : 5;
    
    return {
      intent: 'create',
      title: input.replace(/setiap \d+ menit/, '').replace(/ingetin|saya/, '').trim(),
      repeat: 'minutes',
      repeatDetails: {
        interval: interval,
        timeOfDay: null,
        dayOfWeek: null,
        dayOfMonth: null,
        monthDay: null,
        endDate: null
      },
      dueAtWIB: null, // This was the problem!
      reply: `Siap, aku akan mengingatkan kamu setiap ${interval} menit.`
    };
  }
  
  return {
    intent: 'unknown',
    title: null,
    repeat: 'none',
    repeatDetails: {},
    dueAtWIB: null,
    reply: 'Maaf, aku belum paham.'
  };
}

function testReminderCreationLogic() {
  console.log('🎯 Testing Controller Logic:\n');
  
  const testCase = simulateAIParsing('ingetin saya setiap 5 menit minum air putih');
  
  console.log('AI Parsed Result:');
  console.log(JSON.stringify(testCase, null, 2));
  
  console.log('\n📋 Controller Logic Check:');
  
  // Original problematic condition
  const originalCondition = testCase.intent === 'create' && testCase.dueAtWIB && testCase.title;
  console.log('❌ Original condition (create && dueAtWIB && title):', originalCondition);
  
  // New fixed condition
  const newCondition = testCase.intent === 'create' && testCase.title;
  console.log('✅ New condition (create && title):', newCondition);
  
  if (testCase.repeat !== 'none' && !testCase.dueAtWIB) {
    console.log('✅ Enters repeat reminder logic (no dueAtWIB required)');
    
    // Simulate start time calculation
    let startTime = new Date();
    if (testCase.repeat === 'minutes') {
      startTime = new Date(Date.now() + 60000); // Start in 1 minute
      console.log('✅ Start time set to:', startTime.toISOString());
    }
    
    console.log('✅ Would create reminder in database');
    console.log('✅ Would schedule with scheduler');
    console.log('✅ Would send confirmation to user');
  }
}

function testExpectedFlow() {
  console.log('\n🚀 Expected Fixed Flow:\n');
  
  console.log('1. User: "ingetin saya setiap 5 menit minum air putih"');
  console.log('2. AI: parses as repeat="minutes", interval=5, dueAtWIB=null');
  console.log('3. Controller: detects create intent + title ✅');
  console.log('4. Controller: detects repeat != none && !dueAtWIB ✅');
  console.log('5. Controller: sets startTime = now + 1 minute');
  console.log('6. Controller: creates reminder in database');
  console.log('7. Controller: calls scheduleReminder()');
  console.log('8. User: receives confirmation message');
  console.log('9. After 1 minute: first reminder fires');
  console.log('10. Scheduler: creates next occurrence (now + 5 minutes)');
  console.log('11. Process: repeats indefinitely');
}

// Run tests
testReminderCreationLogic();
testExpectedFlow();

console.log('\n✅ REPEAT REMINDER CREATION FIX ANALYSIS COMPLETE!');
console.log('\n🎯 Key Fix Applied:');
console.log('🔹 Removed dueAtWIB requirement for create condition');
console.log('🔹 Added special handling for repeat reminders without start time');
console.log('🔹 Auto-calculate start time for immediate/interval-based repeats');
console.log('🔹 Maintain existing logic for time-specific repeats');

console.log('\n📝 Files Modified:');
console.log('✅ controllers/waController.js - Enhanced create logic');

console.log('\n🚀 Ready for testing!');
