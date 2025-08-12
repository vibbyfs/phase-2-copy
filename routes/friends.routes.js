const express = require('express');
const router = express.Router();
const FriendController = require('../controllers/friendController');

router.get('/', FriendController.getFriends);
router.post('/', FriendController.createFriend);
router.put('/:id', FriendController.updateFriend);

module.exports = router;
