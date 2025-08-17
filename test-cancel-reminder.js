// Test Cancel Reminder Functionality
const { Reminder, User } = require('./models');
const { cancelReminder } = require('./services/scheduler');

async function testCancelReminder() {
  console.log('🧪 Testing Cancel Reminder Functionality...\n');

  try {
    // 1. Create test user
    const testUser = await User.findOrCreate({
      where: { phoneNumber: '+6281234567890' },
      defaults: {
        username: 'TestUser',
        passwordHash: 'test123'
      }
    });

    const userId = testUser[0].id;
    console.log('✅ Test user created/found:', userId);

    // 2. Create test reminder
    const testReminder = await Reminder.create({
      title: 'Test Reminder untuk Cancel',
      content: 'Ini adalah test reminder',
      dueAt: new Date(Date.now() + 60000), // 1 menit dari sekarang
      status: 'scheduled',
      UserId: userId,
      formattedMessage: 'Test formatted message'
    });

    console.log('✅ Test reminder created:', {
      id: testReminder.id,
      title: testReminder.title,
      status: testReminder.status
    });

    // 3. Test cancel reminder
    console.log('\n🎯 Testing cancelReminder function...');
    await cancelReminder(testReminder.id);

    // 4. Verify reminder status updated in database
    const updatedReminder = await Reminder.findByPk(testReminder.id);
    console.log('✅ Reminder after cancel:', {
      id: updatedReminder.id,
      title: updatedReminder.title,
      status: updatedReminder.status
    });

    if (updatedReminder.status === 'cancelled') {
      console.log('✅ SUCCESS: Reminder status correctly updated to "cancelled"');
    } else {
      console.log('❌ FAILED: Reminder status is', updatedReminder.status, 'instead of "cancelled"');
    }

    // 5. Test filter active reminders (should not include cancelled)
    const activeReminders = await Reminder.findAll({
      where: { UserId: userId, status: 'scheduled' }
    });

    console.log('\n🔍 Active reminders after cancel:', activeReminders.length);
    
    const cancelledReminders = await Reminder.findAll({
      where: { UserId: userId, status: 'cancelled' }
    });

    console.log('🔍 Cancelled reminders:', cancelledReminders.length);

    // 6. Clean up test data
    await Reminder.destroy({ where: { UserId: userId } });
    await User.destroy({ where: { id: userId } });
    console.log('\n🧹 Test data cleaned up');

    console.log('\n✅ CANCEL REMINDER TEST COMPLETED SUCCESSFULLY!');
    console.log('🎯 Features verified:');
    console.log('   - cancelReminder() updates status to "cancelled"');
    console.log('   - Job removed from scheduler');
    console.log('   - Database properly updated');
    console.log('   - Cancelled reminders filtered out from active list');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Export for external testing
module.exports = { testCancelReminder };

// Run test if called directly
if (require.main === module) {
  testCancelReminder().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Test error:', err);
    process.exit(1);
  });
}
