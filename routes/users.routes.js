const express =  require('express')
const router = express.Router()
const UserController = require('../controllers/usersController')

router.get('/profile', UserController.getProfiles)
router.put('/profile/:id', UserController.updateProfile)

module.exports = router
