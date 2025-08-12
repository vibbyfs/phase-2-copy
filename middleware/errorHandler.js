
function errorHandler(err, req, res, next) {
    console.log("ERROR AT HANDLE ERROR", err);

    if (err.name === 'Unauthorized') {
        return res.status(401).json({ message: err.message })
    } else if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ message: 'Invalid token' })
    } else if (err.name === 'BadRequest') {
        return res.status(400).json({ message: err.message })
    } else if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
        return res.status(400).json({ message: err.errors[0].message })
    } else if (err.name === "Forbidden") {
        return res.status(403).json({ message: err.message })
    } else if (err.name === "NotFound") {
        return res.status(404).json({ message: err.message })
    } else {
        res.status(500).json({ message: 'Internal server error' })
    }
}

module.exports = errorHandler