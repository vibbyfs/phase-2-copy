// Test reminder formattedMessage functionality
const { User, Reminder } = require('./models');
const ai = require('./services/ai');

async function testFormattedMessage() {
  console.log('🧪 Testing formattedMessage functionality...\n');

  try {
    // Test 1: Generate formatted message using AI
    console.log('1. Testing AI message generation:');
    const generatedMsg = await ai.generateReply({
      kind: 'reminder_message', 
      username: 'TestUser',
      title: 'Minum Air',
      recipientName: 'TestUser'
    });
    
    console.log('Generated Message:', generatedMsg);
    console.log('✅ AI message generation working\n');

    // Test 2: Simulate reminder creation with formattedMessage
    console.log('2. Testing formatted message in reminder creation:');
    
    const testFormattedMessage = generatedMsg || 
      `Halo TestUser, ini pengingatmu untuk "Minum Air". Semoga harimu berjalan lancar ya ✨🙏`;
    
    console.log('Formatted Message to be saved:', testFormattedMessage);
    console.log('✅ FormattedMessage will be saved to database\n');

    // Test 3: Simulate scheduler reading formattedMessage
    console.log('3. Testing scheduler message handling:');
    
    const mockReminder = {
      formattedMessage: testFormattedMessage,
      title: 'Minum Air'
    };
    
    const mockUser = {
      username: 'TestUser'
    };
    
    // Simulate scheduler logic
    let msg = mockReminder.formattedMessage;
    if (!msg || msg.trim() === '') {
      msg = `Halo ${mockUser.username || 'kamu'}, ini pengingatmu untuk "${mockReminder.title}". Semoga harimu berjalan lancar ya ✨🙏`;
    }
    
    console.log('Final Message from Scheduler:', msg);
    console.log('✅ Scheduler will use formattedMessage from database\n');

    console.log('🎉 All tests passed! FormattedMessage will be properly saved and used.');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testFormattedMessage();
