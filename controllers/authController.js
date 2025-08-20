const { comparePassword } = require('../helpers/bcryptjs');
const { signToken } = require('../helpers/jwt')
const { User } = require('../models/')
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client();

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

    static async googleLogin(req, res, next) {
        const { id_token } = req.body

        try {
            const ticket = await client.verifyIdToken({
                idToken: id_token,
                audience: process.env.GOOGLE_CLIENT_ID,
            });

            const { name, email } = ticket.getPayload();

            let user = await User.findOne({ where: { email } })
            if (!user) {
                user = await User.create({
                    username: name,
                    email,
                    password: Math.random().toString(33).slice(-13)
                })
            }

            const access_token = signToken({ id: user.id })

            res.status(200).json({
                access_token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                }
            })
        } catch (err) {
            console.log("ERROR LOGIN WITH GOOGLE", err);
            next(err);
        }
    }

}

module.exports = AuthController