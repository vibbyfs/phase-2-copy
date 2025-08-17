const axios = require('axios');

async function testWhatsAppEndToEnd() {
  console.log('🧪 Testing WhatsApp End-to-End Self vs Multi-Recipient\n');

  const baseURL = 'http://localhost:3000';
  const testPhone = '+6281234567899'; // testuser phone

  // Simulate WhatsApp webhook payload
  const createWebhookPayload = (message, from = testPhone) => ({
    Body: message,
    From: `whatsapp:${from}`,
    To: 'whatsapp:+14155238886' // Twilio sandbox number
  });

  const testCases = [
    {
      name: 'Self Reminder - Relative Time',
      message: 'ingatkan aku minum air dalam 30 menit',
      expected: 'self reminder'
    },
    {
      name: 'Self Reminder - Absolute Time', 
      message: 'ingatkan aku meeting besok jam 2 siang',
      expected: 'self reminder'
    },
    {
      name: 'Self Reminder - Daily Repeat',
      message: 'ingatkan aku setiap hari jam 8 pagi untuk sarapan',
      expected: 'self reminder with repeat'
    },
    {
      name: 'Multi-Recipient Reminder',
      message: 'ingatkan @john @jane meeting penting besok jam 3',
      expected: 'multi-recipient reminder'
    },
    {
      name: 'List Reminders',
      message: 'list',
      expected: 'show all reminders with recipient info'
    }
  ];

  try {
    console.log('1️⃣ Testing Self Reminder Messages:');
    
    for (const testCase of testCases.slice(0, 3)) { // Only self reminders
      console.log(`\n   Testing: ${testCase.name}`);
      console.log(`   Message: "${testCase.message}"`);
      
      try {
        const response = await axios.post(`${baseURL}/wa/webhook`, createWebhookPayload(testCase.message), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000
        });
        
        if (response.status === 200) {
          console.log('   ✅ Request successful');
        } else {
          console.log(`   ⚠️  Unexpected status: ${response.status}`);
        }
      } catch (error) {
        if (error.code === 'ECONNREFUSED') {
          console.log('   ❌ Server not running. Please start the app first.');
        } else {
          console.log(`   ❌ Error: ${error.message}`);
        }
      }
      
      // Wait a bit between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('\n2️⃣ Testing Multi-Recipient Message:');
    
    const multiRecipientTest = testCases[3];
    console.log(`   Testing: ${multiRecipientTest.name}`);
    console.log(`   Message: "${multiRecipientTest.message}"`);
    
    try {
      const response = await axios.post(`${baseURL}/wa/webhook`, createWebhookPayload(multiRecipientTest.message), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });
      
      if (response.status === 200) {
        console.log('   ✅ Request successful');
      } else {
        console.log(`   ⚠️  Unexpected status: ${response.status}`);
      }
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        console.log('   ❌ Server not running. Please start the app first.');
      } else {
        console.log(`   ❌ Error: ${error.message}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('\n3️⃣ Testing List Command:');
    
    const listTest = testCases[4];
    console.log(`   Testing: ${listTest.name}`);
    console.log(`   Message: "${listTest.message}"`);
    
    try {
      const response = await axios.post(`${baseURL}/wa/webhook`, createWebhookPayload(listTest.message), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });
      
      if (response.status === 200) {
        console.log('   ✅ Request successful');
      } else {
        console.log(`   ⚠️  Unexpected status: ${response.status}`);
      }
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        console.log('   ❌ Server not running. Please start the app first.');
      } else {
        console.log(`   ❌ Error: ${error.message}`);
      }
    }

    console.log('\n📋 End-to-End Test Summary:');
    console.log('   📱 Self reminder messages tested');
    console.log('   👥 Multi-recipient message tested');
    console.log('   📋 List command tested');
    console.log('\n💡 Check PM2 logs to see the actual processing:');
    console.log('   pm2 logs --lines 20');
    console.log('\n🔍 Expected behaviors:');
    console.log('   - Self reminders should set RecipientId = UserId');
    console.log('   - Multi-recipient should create ReminderRecipients entries');
    console.log('   - List should show both types with proper labels');

  } catch (error) {
    console.error('❌ End-to-end test failed:', error.message);
  }
}

// Run the test
testWhatsAppEndToEnd().then(() => {
  console.log('\n🏁 End-to-end test completed');
  process.exit(0);
}).catch(err => {
  console.error('❌ End-to-end test failed:', err);
  process.exit(1);
});
