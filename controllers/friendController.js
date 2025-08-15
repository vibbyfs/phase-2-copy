const { Friend, User } = require('../models');
const { Op } = require('sequelize');

class FriendController {

    static async getFriends(req, res, next) {
        try {
            const userId = req.user.id;
            const { search, status, direction, sort = 'DESC' } = req.query;

            const where = { [Op.or]: [{ UserId: userId }, { FriendId: userId }] };
            if (status) where.status = status;

            if (direction === 'incoming') {
                where.FriendId = userId;
                delete where[Op.or];
            } else if (direction === 'outgoing') {
                where.UserId = userId;
                delete where[Op.or];
            }

            const include = [
                { model: User, as: 'requester', attributes: ['id', 'username'] },
                { model: User, as: 'receiver', attributes: ['id', 'username'] },
            ];

            if (search) {
                include[0].where = { username: { [Op.iLike]: `%${search}%` } };
                include[1].where = { username: { [Op.iLike]: `%${search}%` } };
                include[0].required = false;
                include[1].required = false;
            }

            const rows = await Friend.findAll({
                where,
                include,
                order: [['createdAt', sort]],
            });

            const data = rows.map(f => {
                const isIncoming = f.FriendId === userId;
                const other = isIncoming ? f.requester : f.receiver;
                return {
                    id: f.id,
                    status: f.status,
                    direction: isIncoming ? 'incoming' : 'outgoing',
                    createdAt: f.createdAt,
                    otherUser: other ? { id: other.id, username: other.username } : null,
                };
            });

            res.status(200).json(data);
        } catch (err) {
            next(err);
        }
    }

    static async sendFriendRequest(req, res, next) {
        try {
            const userId = req.user.id;
            const { username } = req.body;

            if (!username) throw { name: 'BadRequest', message: 'Username wajib diisi.' };

            const target = await User.findOne({ where: { username } });
            if (!target) throw { name: 'NotFound', message: 'User tidak ditemukan.' };
            if (target.id === userId) throw { name: 'BadRequest', message: 'Tidak dapat mengundang diri sendiri.' };

            const exists = await Friend.findOne({ where: { UserId: userId, FriendId: target.id } });
            if (exists) throw { name: 'BadRequest', message: 'Permintaan sudah pernah dibuat.' };

            const created = await Friend.create({ UserId: userId, FriendId: target.id, status: 'pending' });
            res.status(201).json(created);
        } catch (err) {
            next(err);
        }
    }

    static async respondFriendRequest(req, res, next) {
        try {
            const userId = req.user.id;
            const { id } = req.params;
            const { action } = req.body;

            const friend = await Friend.findByPk(id);
            if (!friend) throw { name: 'NotFound', message: 'Undangan tidak ditemukan.' };
            if (friend.FriendId !== userId) throw { name: 'Forbidden', message: 'Tidak berhak memproses undangan ini.' };
            if (friend.status !== 'pending') throw { name: 'BadRequest', message: 'Undangan sudah diproses.' };

            if (action === 'accept') {
                await friend.update({ status: 'accepted' });

                const reciprocal = await Friend.findOne({
                    where: { UserId: userId, FriendId: friend.UserId },
                });

                if (!reciprocal) {
                    await Friend.create({
                        UserId: userId,
                        FriendId: friend.UserId,
                        status: 'accepted',
                    });
                } else if (reciprocal.status !== 'accepted') {
                    await reciprocal.update({ status: 'accepted' });
                }

                res.status(200).json({ id: friend.id, status: 'accepted' });
            } else if (action === 'reject') {
                await friend.destroy();
                res.status(200).json({ id: id, status: 'rejected' });
            } else {
                throw { name: 'BadRequest', message: 'Action tidak valid. Gunakan accept atau reject.' };
            }
        } catch (err) {
            next(err);
        }
    }

    static async deleteFriend(req, res, next) {
        try {
            const userId = req.user.id;
            const { id } = req.params;

            const friend = await Friend.findByPk(id);
            if (!friend) throw { name: 'NotFound', message: 'Relasi tidak ditemukan.' };
            if (friend.UserId !== userId && friend.FriendId !== userId)
                throw { name: 'Forbidden', message: 'Tidak berhak menghapus relasi ini.' };

            await friend.destroy();

            await Friend.destroy({
                where: { UserId: friend.FriendId, FriendId: friend.UserId },
            });

            res.status(200).json({ message: 'Relasi pertemanan dihapus.' });
        } catch (err) {
            next(err);
        }
    }
}

module.exports = FriendController;
