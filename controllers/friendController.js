const { Friend, User } = require('../models');
const { Op } = require('sequelize');

/**
 * FriendController menangani daftar teman, mengirim undangan, serta menerima/menolak undangan.
 */
class FriendController {

    /**
     * GET /api/friends
     * Mengembalikan daftar relasi teman bagi user login, termasuk status 'pending' dan 'accepted'.
     * Menampilkan semua entri di mana user sebagai pengirim atau penerima.
     */
    static async getFriends(req, res, next) {
        try {
            const userId = req.user.id;

            const friends = await Friend.findAll({
                where: {
                    [Op.or]: [
                        { UserId: userId },
                        { FriendId: userId }
                    ]
                },
                order: [['id', 'ASC']]
            });

            res.status(200).json(friends);
        } catch (err) {
            console.log('ERROR GET FRIENDS', err);
            next(err);
        }
    }

    /**
     * POST /api/friends
     * Membuat undangan pertemanan baru.
     * Body menerima `phone` (string) atau `friendId` (angka).
     */
    static async createFriend(req, res, next) {
        try {
            const userId = req.user.id;
            let { phone, friendId } = req.body;

            // Dapatkan friendId dari phone jika phone diberikan
            if (phone) {
                const target = await User.findOne({ where: { phone } });
                if (!target) {
                    throw { name: 'NotFound', message: 'User dengan nomor tersebut tidak ditemukan.' };
                }
                friendId = target.id;
            }

            if (!friendId) {
                throw { name: 'BadRequest', message: 'friendId atau phone wajib diisi.' };
            }

            if (friendId === userId) {
                throw { name: 'BadRequest', message: 'Tidak dapat mengundang diri sendiri.' };
            }

            // Cek apakah sudah ada relasi
            const existing = await Friend.findOne({
                where: {
                    UserId: userId,
                    FriendId: friendId
                }
            });

            if (existing) {
                throw { name: 'BadRequest', message: 'Undangan teman sudah pernah dibuat.' };
            }

            const newFriend = await Friend.create({
                UserId: userId,
                FriendId: friendId,
                status: 'pending'
            });

            res.status(201).json(newFriend);
        } catch (err) {
            console.log('ERROR CREATE FRIEND', err);
            next(err);
        }
    }

    /**
     * PUT /api/friends/:id
     * Menerima atau menolak undangan pertemanan.
     * Hanya penerima (FriendId) yang boleh mengeksekusi endpoint ini.
     * Body: { action: 'accept' | 'reject' }
     */
    static async updateFriend(req, res, next) {
        try {
            const userId = req.user.id;
            const { id } = req.params;
            const { action } = req.body;

            const friend = await Friend.findByPk(id);
            if (!friend) {
                throw { name: 'NotFound', message: 'Relasi teman tidak ditemukan.' };
            }

            // Pastikan user yang meng-accept adalah penerima undangan
            if (friend.FriendId !== userId) {
                throw { name: 'Forbidden', message: 'Anda tidak berhak memproses undangan ini.' };
            }

            if (friend.status !== 'pending') {
                throw { name: 'BadRequest', message: 'Undangan telah diproses sebelumnya.' };
            }

            if (action === 'accept') {
                // Update status menjadi accepted
                await friend.update({ status: 'accepted' });

                // Buat relasi balik jika belum ada
                const reciprocal = await Friend.findOne({
                    where: {
                        UserId: userId,
                        FriendId: friend.UserId
                    }
                });

                if (!reciprocal) {
                    await Friend.create({
                        UserId: userId,
                        FriendId: friend.UserId,
                        status: 'accepted'
                    });
                } else {
                    await reciprocal.update({ status: 'accepted' });
                }

                return res.status(200).json({ id: friend.id, status: 'accepted' });
            } else if (action === 'reject') {
                // Hapus undangan (tolak)
                await friend.destroy();
                return res.status(200).json({ id: friend.id, status: 'rejected' });
            } else {
                throw { name: 'BadRequest', message: 'Action tidak valid. Gunakan accept atau reject.' };
            }
        } catch (err) {
            console.log('ERROR UPDATE FRIEND', err);
            next(err);
        }
    }
}

module.exports = FriendController;
