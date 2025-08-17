const { User, Friend, Reminder, ReminderRecipient } = require('./models');
const { 
  parseUsernamesFromMessage, 
  validateAndGetRecipients, 
  generateMultiRecipientMessage 
} = require('./helpers/multiRecipient');

async function testMultiRecipient() {
  console.log('🧪 Testing Multi-Recipient Reminder Feature\n');

  try {
    // 1. Test username parsing
    console.log('1️⃣ Testing username parsing:');
    
    const testMessages = [
      "ingatkan @john @jane makan siang jam 12",
      "@bob jangan lupa rapat besok jam 2",
      "reminder untuk @alice dan @charlie: deadline project",
      "bikin reminder tanpa mention",
      "@invaliduser @john meeting important"
    ];

    testMessages.forEach(msg => {
      const result = parseUsernamesFromMessage(msg);
      console.log(`   "${msg}"`);
      console.log(`   → Usernames: [${result.usernames.join(', ')}]`);
      console.log(`   → Clean message: "${result.message}"`);
      console.log('');
    });

    // 2. Test database setup
    console.log('2️⃣ Testing database setup:');
    
    // Check if users exist for testing
    const testUsers = await User.findAll({
      where: { username: ['john', 'jane', 'bob', 'alice', 'charlie'] },
      attributes: ['id', 'username', 'phone']
    });
    
    console.log(`   Found ${testUsers.length} test users in database:`);
    testUsers.forEach(user => {
      console.log(`   - ${user.username} - ${user.phone || 'No phone'}`);
    });

    if (testUsers.length === 0) {
      console.log('   ⚠️  No test users found. Creating sample users...');
      
      const sampleUsers = [
        { username: 'john', phone: '+6281234567890', email: 'john@test.com', password: 'hashedpass123' },
        { username: 'jane', phone: '+6281234567891', email: 'jane@test.com', password: 'hashedpass123' },
        { username: 'bob', phone: '+6281234567892', email: 'bob@test.com', password: 'hashedpass123' }
      ];

      for (const userData of sampleUsers) {
        try {
          await User.create(userData);
          console.log(`   ✅ Created user: ${userData.username}`);
        } catch (err) {
          console.log(`   ❌ Failed to create user ${userData.username}: ${err.message}`);
        }
      }
    }

    // 3. Test friendship validation
    console.log('\n3️⃣ Testing friendship validation:');
    
    const currentUser = await User.findOne({ where: { username: 'testuser' } });
    if (!currentUser) {
      console.log('   ⚠️  No test user found. Creating testuser...');
      const newUser = await User.create({
        username: 'testuser',
        phone: '+6281234567899',
        email: 'test@test.com',
        password: 'hashedpass123'
      });
      console.log(`   ✅ Created testuser with ID: ${newUser.id}`);
    }

    const testUser = await User.findOne({ where: { username: 'testuser' } });
    const johnUser = await User.findOne({ where: { username: 'john' } });
    
    if (testUser && johnUser) {
      // Check if friendship exists
      const friendship = await Friend.findOne({
        where: { UserId: testUser.id, FriendId: johnUser.id }
      });
      
      if (!friendship) {
        console.log('   Creating friendship between testuser and john...');
        await Friend.create({
          UserId: testUser.id,
          FriendId: johnUser.id,
          status: 'accepted'
        });
        console.log('   ✅ Friendship created');
      } else {
        console.log(`   Friendship exists with status: ${friendship.status}`);
      }

      // Test validation
      const validation = await validateAndGetRecipients(testUser.id, ['john', 'jane', 'nonexistent']);
      console.log(`   Valid users: ${validation.validUsers.length}`);
      console.log(`   Invalid usernames: [${validation.invalidUsernames.join(', ')}]`);
      console.log(`   Not friends: [${validation.notFriends.join(', ')}]`);
    }

    // 4. Test message generation
    console.log('\n4️⃣ Testing message generation:');
    
    const recipients = await User.findAll({
      where: { username: ['john', 'jane'] },
      attributes: ['username']
    });
    
    const creator = await User.findOne({
      where: { username: 'testuser' },
      attributes: ['username']
    });

    if (recipients.length > 0 && creator) {
      const originalMessage = "Jangan lupa meeting penting hari ini! 📝";
      const formattedMessage = generateMultiRecipientMessage(originalMessage, recipients, creator);
      console.log('   Original message:', originalMessage);
      console.log('   Formatted message:');
      console.log('   ' + formattedMessage.split('\n').join('\n   '));
    }

    // 5. Test database tables
    console.log('\n5️⃣ Testing database tables:');
    
    const reminderCount = await Reminder.count();
    const reminderRecipientCount = await ReminderRecipient.count();
    
    console.log(`   Reminders table: ${reminderCount} records`);
    console.log(`   ReminderRecipients table: ${reminderRecipientCount} records`);

    // Check table structure
    console.log('\n   ReminderRecipients table structure:');
    const tableInfo = await ReminderRecipient.describe();
    Object.keys(tableInfo).forEach(field => {
      console.log(`   - ${field}: ${tableInfo[field].type}`);
    });

    console.log('\n✅ Multi-recipient testing completed!');
    console.log('\n📋 Next steps:');
    console.log('   1. Make sure you have test users with friendships');
    console.log('   2. Test with WhatsApp messages like: "ingatkan @john @jane makan siang jam 12"');
    console.log('   3. Check PM2 logs for multi-recipient reminder processing');
    console.log('   4. Test list and cancel commands for multi-recipient reminders');

  } catch (error) {
    console.error('❌ Error during testing:', error);
  }
}

// Run the test
testMultiRecipient().then(() => {
  console.log('\n🏁 Test execution completed');
  process.exit(0);
}).catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
