# WhatsApp Reminder System - Simplified

Sistem pengingat WhatsApp yang disederhanakan dengan 3 fitur utama:

## 🎯 Fitur Utama

### 1. Personal Reminder (Untuk Diri Sendiri)
User dapat membuat reminder berulang untuk dirinya sendiri dengan pola:
- **Setiap jam** (hourly)
- **Setiap hari** (daily) 
- **Setiap minggu** (weekly)
- **Setiap bulan** (monthly)

**Contoh pesan:**
- "ingetin saya minum air setiap jam"
- "reminder olahraga setiap hari"
- "ingatkan meeting tim setiap minggu"
- "pengingat bayar listrik setiap bulan"

### 2. Friend Reminder (Sekali Kirim ke Teman)
User dapat mengirim reminder sekali (tidak berulang) ke teman yang sudah di-add dengan format `@username`.

**Contoh pesan:**
- "ingetin @john meeting besok jam 2"
- "reminder @jane @doe deadline project hari ini"

**Syarat:**
- User sudah saling berteman (status: accepted)
- Reminder ini sifatnya sekali saja (tidak berulang)

### 3. Stop Reminder dengan Natural Language
User dapat menghentikan reminder menggunakan bahasa natural:

**Contoh pesan:**
- "stop reminder" → Hentikan semua reminder berulang
- "stop semua reminder" → Hentikan SEMUA reminder
- "stop reminder minum air" → Hentikan reminder yang mengandung kata "minum air"
- "list reminder" → Tampilkan daftar reminder aktif

## 🤖 AI Response

### Konfirmasi Pembuatan
AI akan memberikan konfirmasi ramah saat reminder berhasil dibuat:
> "✅ Siap! Reminder Minum Air untuk diri sendiri sudah dijadwalkan pada 11/08/2025 14:30 WIB (setiap jam). Jaga kesehatan ya! 😊"

### Pesan Reminder
Saat waktunya reminder, AI akan mengirim pesan dengan menyebutkan nama dan topik:
> "Hay John 👋, waktunya untuk *Meeting Tim* pada jam 14:30 WIB! Jangan lupa ya 😊"

## 📝 Setup

1. Install dependencies:
```bash
npm install
```

2. Setup database:
```bash
npx sequelize-cli db:migrate
npx sequelize-cli db:seed:all
```

3. Set environment variables:
```env
# Database & Auth
DATABASE_URL=your_database_url
JWT_SECRET=your_jwt_secret

# OpenAI for AI processing
OPENAI_API_KEY=your_openai_key

# Twilio WhatsApp API
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

# Timezone
WIB_TZ=Asia/Jakarta
```

4. Configure Twilio Webhook:
   - Login to Twilio Console
   - Go to WhatsApp Sandbox settings
   - Set webhook URL to: `https://your-domain.com/api/wa/inbound`
   - Method: POST

5. Run the application:
```bash
npm start
```

## 🛠 API Endpoints

### Reminder Management
- `GET /api/reminders/active` - Get active reminders
- `DELETE /api/reminders/recurring/cancel` - Cancel recurring reminders
- `DELETE /api/reminders/all/cancel` - Cancel all reminders
- `POST /api/reminders/cancel-by-keyword` - Cancel by keyword

### WhatsApp Webhook
- `POST /api/wa/inbound` - Handle incoming WhatsApp messages

### Friend Management
- `GET /api/friends` - Get friends list
- `POST /api/friends` - Send friend request
- `PUT /api/friends/:id` - Accept/reject friend request

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user

## 🗄 Database Models

### User
- id, name, username, phone, password
- Relations: has many reminders, has many friends

### Reminder  
- id, UserId, RecipientId, title, dueAt, repeat, status, formattedMessage
- repeat: ENUM('none', 'hourly', 'daily', 'weekly', 'monthly')

### Friend
- id, UserId, FriendId, status
- status: ENUM('pending', 'accepted', 'rejected')

## 🎯 Simplified Features

Fitur yang **DIHAPUS** untuk mempersempit scope:
- ❌ Custom repeat intervals (setiap X menit/jam)
- ❌ Complex CRUD operations
- ❌ Pause/resume functionality
- ❌ Bulk operations UI
- ❌ Demo HTML interface
- ❌ Advanced scheduling options

Fitur yang **DIPERTAHANKAN**:
- ✅ Personal recurring reminders (hourly/daily/weekly/monthly)
- ✅ Friend tagging for one-time reminders (@username)
- ✅ Natural language stop commands
- ✅ AI confirmation and reminder messages
- ✅ Friend management system
