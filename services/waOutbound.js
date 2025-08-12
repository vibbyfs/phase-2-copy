
// Lazy initialize Twilio client
function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return null;
  }
  
  const twilio = require('twilio');
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendReminder(to, text, reminderId) {
  try {
    const client = getTwilioClient();
    
    if (!client) {
      console.log('[TWILIO] DEMO MODE - Message would be sent:', {
        to: to,
        text: text,
        reminderId: reminderId
      });
      return {
        success: true,
        messageId: 'demo-' + Date.now(),
        status: 'demo'
      };
    }

    if (!process.env.TWILIO_WHATSAPP_FROM) {
      throw new Error('TWILIO_WHATSAPP_FROM is not set');
    }

    // Send WhatsApp message via Twilio
    const message = await client.messages.create({
      body: text,
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}` // Ensure 'to' has the whatsapp: prefix
    });

    console.log(`[TWILIO] Message sent successfully:`, {
      sid: message.sid,
      to: to,
      reminderId: reminderId,
      status: message.status
    });

    return {
      success: true,
      messageId: message.sid,
      status: message.status
    };
  } catch (error) {
    console.error('[TWILIO] Error sending message:', error);
    throw error;
  }
}

module.exports = { sendReminder };
