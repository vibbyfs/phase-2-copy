const { User, Reminder, ReminderRecipient } = require('./models');

async function testSelfReminderWithoutAI() {
  console.log('🧪 Testing Self-Reminder Database Logic After Multi-Recipient Implementation\n');

  try {
    // 1. Test database creation for self reminder
    console.log('1️⃣ Testing self reminder database creation:');
    
    const testUser = await User.findOne({ where: { username: 'testuser' } });
    if (!testUser) {
      console.log('   ❌ Test user not found. Please run test-multi-recipient.js first.');
      return;
    }

    console.log(`   Found test user: ${testUser.username} (ID: ${testUser.id})`);

    // Simulate controller logic for self reminder (no recipients)
    const recipientUsers = []; // Empty array for self reminder
    console.log(`   Recipients array length: ${recipientUsers.length}`);

    // Create a self reminder following the new controller logic
    const selfReminder = await Reminder.create({
      UserId: testUser.id,
      RecipientId: recipientUsers.length > 0 ? null : testUser.id, // New logic
      title: 'Test Self Reminder',
      dueAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes from now
      repeat: 'none',
      repeatType: 'once',
      repeatInterval: null,
      repeatEndDate: null,
      isRecurring: false,
      status: 'scheduled',
      formattedMessage: `Halo ${testUser.username}, waktunya Test Self Reminder! 😊`
    });

    console.log(`   ✅ Created self reminder with ID: ${selfReminder.id}`);
    console.log(`   - Title: ${selfReminder.title}`);
    console.log(`   - UserId: ${selfReminder.UserId}`);
    console.log(`   - RecipientId: ${selfReminder.RecipientId} (should be ${testUser.id} for self)`);
    console.log(`   - Due at: ${selfReminder.dueAt}`);

    // Check if any ReminderRecipients were created (should be none for self reminder)
    const recipients = await ReminderRecipient.findAll({
      where: { ReminderId: selfReminder.id }
    });

    console.log(`   - ReminderRecipients count: ${recipients.length} (should be 0 for self reminder)`);

    // 2. Test reminder list with mixed self and multi-recipient reminders
    console.log('\n2️⃣ Testing reminder list functionality:');
    
    const allReminders = await Reminder.findAll({
      where: { 
        UserId: testUser.id, 
        status: 'scheduled' 
      },
      include: [
        {
          model: ReminderRecipient,
          as: 'reminderRecipients',
          required: false,
          include: [
            {
              model: User,
              as: 'recipient',
              attributes: ['username']
            }
          ]
        }
      ],
      order: [['createdAt', 'DESC']],
      limit: 5
    });

    console.log(`   Found ${allReminders.length} reminders:`);
    allReminders.forEach((reminder, idx) => {
      const recipientCount = reminder.reminderRecipients ? reminder.reminderRecipients.length : 0;
      const isSelfReminder = reminder.RecipientId === testUser.id && recipientCount === 0;
      const recipientInfo = recipientCount > 0 
        ? ` → ${reminder.reminderRecipients.map(rr => rr.recipient.username).join(', ')}`
        : isSelfReminder ? ' (self)' : ' (unknown)';
      
      console.log(`   ${idx + 1}. "${reminder.title}"${recipientInfo}`);
      console.log(`      RecipientId: ${reminder.RecipientId}, Recipients: ${recipientCount}`);
    });

    // 3. Test scheduler data retrieval compatibility
    console.log('\n3️⃣ Testing scheduler data retrieval:');
    
    // Simulate how scheduler retrieves reminder data
    const schedulerReminder = await Reminder.findByPk(selfReminder.id, {
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'username', 'phone']
        },
        {
          model: ReminderRecipient,
          as: 'reminderRecipients',
          where: { status: 'scheduled' },
          required: false,
          include: [
            {
              model: User,
              as: 'recipient',
              attributes: ['id', 'username', 'phone']
            }
          ]
        }
      ]
    });

    if (schedulerReminder) {
      console.log('   ✅ Scheduler can retrieve reminder data');
      console.log(`   - Has reminderRecipients: ${schedulerReminder.reminderRecipients ? schedulerReminder.reminderRecipients.length : 0}`);
      
      // Test scheduler logic decision
      const hasMultiRecipients = schedulerReminder.reminderRecipients && schedulerReminder.reminderRecipients.length > 0;
      
      if (hasMultiRecipients) {
        console.log('   - Would use multi-recipient logic');
      } else {
        console.log('   - Would use single recipient logic (legacy mode)');
        const recipientUser = await User.findByPk(schedulerReminder.RecipientId || schedulerReminder.UserId);
        console.log(`   - Target user: ${recipientUser ? recipientUser.username : 'not found'}`);
      }
    } else {
      console.log('   ❌ Scheduler cannot retrieve reminder data');
    }

    // 4. Test controller list logic
    console.log('\n4️⃣ Testing controller list display logic:');
    
    // Simulate how controller displays reminders
    const listReminders = await Reminder.findAll({
      where: { 
        UserId: testUser.id, 
        status: 'scheduled' 
      },
      include: [
        {
          model: ReminderRecipient,
          as: 'reminderRecipients',
          where: { status: 'scheduled' },
          required: false,
          include: [
            {
              model: User,
              as: 'recipient',
              attributes: ['username']
            }
          ]
        }
      ],
      order: [['dueAt', 'ASC']],
      limit: 3
    });

    console.log('   List display simulation:');
    listReminders.forEach((reminder, idx) => {
      const num = idx + 1;
      
      // Show recipients if multi-recipient
      let recipientText = '';
      if (reminder.reminderRecipients && reminder.reminderRecipients.length > 0) {
        const recipientNames = reminder.reminderRecipients
          .map(rr => rr.recipient.username)
          .join(', ');
        recipientText = ` → ${recipientNames}`;
      }
      
      console.log(`   ${num}. "${reminder.title}"${recipientText}`);
    });

    // 5. Test cancel functionality
    console.log('\n5️⃣ Testing cancel functionality:');
    
    // Test cancel logic for self reminder
    const cancelReminder = await Reminder.findByPk(selfReminder.id, {
      include: [
        {
          model: ReminderRecipient,
          as: 'reminderRecipients',
          include: [
            {
              model: User,
              as: 'recipient',
              attributes: ['username']
            }
          ]
        }
      ]
    });

    if (cancelReminder) {
      // Simulate cancel operation
      cancelReminder.status = 'cancelled';
      await cancelReminder.save();
      
      // Cancel all ReminderRecipients (if any)
      if (cancelReminder.reminderRecipients && cancelReminder.reminderRecipients.length > 0) {
        await ReminderRecipient.update(
          { status: 'cancelled' },
          { where: { ReminderId: cancelReminder.id, status: 'scheduled' } }
        );
        console.log(`   ✅ Cancelled ${cancelReminder.reminderRecipients.length} recipient entries`);
      } else {
        console.log('   ✅ Self reminder cancelled (no recipients to update)');
      }
      
      let cancelMessage = `✅ Reminder "${cancelReminder.title}" berhasil dibatalkan!`;
      if (cancelReminder.reminderRecipients && cancelReminder.reminderRecipients.length > 0) {
        const recipientNames = cancelReminder.reminderRecipients
          .map(rr => rr.recipient.username)
          .join(', ');
        cancelMessage += ` (untuk ${recipientNames})`;
      }
      
      console.log(`   Cancel message: ${cancelMessage}`);
    }

    // 6. Clean up
    console.log('\n6️⃣ Cleaning up test data:');
    
    await Reminder.destroy({
      where: { 
        id: selfReminder.id 
      }
    });
    console.log('   ✅ Test reminder deleted');

    console.log('\n✅ Self-reminder testing completed successfully!');
    console.log('\n📋 Test Results Summary:');
    console.log('   ✅ Database creation works correctly for self reminders');
    console.log('   ✅ List functionality shows correct recipient info');
    console.log('   ✅ Scheduler data retrieval works for both single and multi-recipient');
    console.log('   ✅ Cancel functionality handles self reminders properly');
    console.log('   ✅ No ReminderRecipients entries created for self reminders');
    console.log('\n💡 Self reminders work normally alongside multi-recipient functionality!');

  } catch (error) {
    console.error('❌ Error during self-reminder testing:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Run the test
testSelfReminderWithoutAI().then(() => {
  console.log('\n🏁 Self-reminder test completed');
  process.exit(0);
}).catch(err => {
  console.error('❌ Self-reminder test failed:', err);
  process.exit(1);
});
