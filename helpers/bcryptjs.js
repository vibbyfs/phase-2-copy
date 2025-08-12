const bcryptjs = require('bcryptjs')

const hashedPassword = (password) => {
    const saltRounds = bcryptjs.genSaltSync(10)
    return bcryptjs.hashSync(password, saltRounds)
}

const comparePassword = (password, hashedPassword) => {
    return bcryptjs.compareSync(password, hashedPassword)
}

module.exports = {
    hashedPassword,
    comparePassword
}