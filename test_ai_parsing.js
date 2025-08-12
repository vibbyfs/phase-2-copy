const { extract } = require('./services/ai');

async function testTimeParsing() {
  const testMessages = [
    "ingetin saya 52 menit lagi minum obat",
    "reminder meeting jam 2 siang",
    "setiap hari jam 8 pagi ingatkan sarapan",
    "ingetin @john meeting besok jam 10",
    "setiap minggu jam 9 pagi ingatkan olahraga",
    "dalam 30 detik lagi cek email",
    "besok jam 14:00 meeting zoom",
    "setiap bulan tanggal 1 jam 10 pagi bayar tagihan"
  ];

  console.log('=== TEST AI PARSING dengan FLEXIBLE TIME ===\n');

  for (const message of testMessages) {
    try {
      console.log(`INPUT: "${message}"`);
      const result = await extract(message);
      console.log('OUTPUT:', JSON.stringify(result, null, 2));
      console.log('---');
    } catch (error) {
      console.error(`ERROR untuk "${message}":`, error.message);
      console.log('---');
    }
  }
}

testTimeParsing().catch(console.error);
