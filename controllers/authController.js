const { comparePassword } = require('../helpers/bcryptjs');
const { signToken } = require('../helpers/jwt')
const { User } = require('../models/')

class AuthController {

    static async register(req, res, next) {
        try {
            const user = await User.create(req.body)

            const { password, ...userWithoutPassword } = user.toJSON() ? user.toJSON() : user;

            res.status(201).json(userWithoutPassword)

        } catch (err) {
            console.log("ERROR REGISTER", err);
            next(err)
        }
    }

    static async login(req, res, next) {
        try {
            const { email, password } = req.body

            if (!email) {
                throw ({ name: 'BadRequest', message: 'Email is required.' })
            }
            if (!password) {
                throw ({ name: 'BadRequest', message: 'Password is required.' })
            }

            const user = await User.findOne({
                where: { email }
            })
            if (!user) {
                throw ({ name: 'Unauthorized', message: 'Invalid email or password.' })
            }

            const isValidPassword = comparePassword(password, user.password)
            if (!isValidPassword) {
                throw ({ name: 'Unauthorized', message: 'Invalid email or password.' })
            }

            const access_token = signToken({ id: user.id })

            res.status(200).json({ access_token })
        } catch (err) {
            console.log("ERROR LOGIN", err);
            next(err)
        }
    }

}

module.exports = AuthController