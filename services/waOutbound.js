import axios from "axios";

const WA_API_URL = process.env.WA_API_URL || "http://localhost:3000/wa"; 
const WA_API_KEY = process.env.WA_API_KEY || "secret";

/**
 * Kirim pesan WhatsApp ke nomor user
 * @param {string} to - Nomor tujuan (format internasional)
 * @param {string} text - Pesan teks
 */
export async function sendMessage(to, text) {
  if (!to || !text) {
    console.error("[WAOutbound] Nomor atau teks kosong, batal kirim.");
    return;
  }

  try {
    const res = await axios.post(
      `${WA_API_URL}/sendMessage`,
      { to, text },
      { headers: { Authorization: `Bearer ${WA_API_KEY}` } }
    );

    console.log(`[WAOutbound] Pesan terkirim ke ${to}: ${text}`);
    return res.data;
  } catch (err) {
    console.error("[WAOutbound] Gagal kirim pesan:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Kirim pesan balasan interaktif (opsional)
 * Bisa dipakai untuk quick reply di masa depan
 */
export async function sendInteractiveMessage(to, text, buttons = []) {
  try {
    const res = await axios.post(
      `${WA_API_URL}/sendInteractive`,
      { to, text, buttons },
      { headers: { Authorization: `Bearer ${WA_API_KEY}` } }
    );

    console.log(`[WAOutbound] Interactive message terkirim ke ${to}`);
    return res.data;
  } catch (err) {
    console.error("[WAOutbound] Gagal kirim interactive:", err.response?.data || err.message);
    throw err;
  }
}
