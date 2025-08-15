const express =  require('express')
const router = express.Router()
const UserController = require('../controllers/usersController')

router.get('/profile', UserController.getProfilesById)
router.put('/:id/update-profile', UserController.updateProfile)

module.exports = router
