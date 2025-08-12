const { User } = require('../models')
const { verifyToken } = require('../helpers/jwt')

async function authentication(req, res, next) {
    try {

        const authorization = req.headers.authorization
        if (!authorization) {
            throw ({ name: 'Unauthorized', message: 'Invalid token' });
        }

        const rawToken = authorization.split(' ')
        const keyToken = rawToken[0]
        const valueToken = rawToken[1]

        if (keyToken !== 'Bearer' || !valueToken) {
            throw ({ name: 'Unauthorized', message: 'Invalid token' });
        }

        const result = verifyToken(valueToken)

        const user = await User.findByPk(result.id)
        if (!user) {
            throw ({ name: 'Unauthorized', message: 'Invalid token' })
        }

        req.user = { id: user.id, role: user.role }
        // console.log(req.user, "<<<<<<<<<<<<<<<<<<<<<<<<");

        next()
    } catch (err) {
        // console.log("ERROR AUTHENTICATION", err);
        next(err)
    }
}

module.exports = authentication