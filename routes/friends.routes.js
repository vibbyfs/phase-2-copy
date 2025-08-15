const express = require('express');
const router = express.Router();
const FriendController = require('../controllers/friendController');

router.get('/', FriendController.getFriends);
router.post('/request', FriendController.sendFriendRequest);
router.put('/:id/respond', FriendController.respondFriendRequest);
router.delete('/:id/delete', FriendController.deleteFriend);

module.exports = router;
