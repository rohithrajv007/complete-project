const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
    try {
        // Get the authorization header
        const authHeader = req.headers.authorization;

        // Check if authorization header exists and has Bearer format
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                message: 'Access denied. No token provided or invalid format.' 
            });
        }

        // Extract the token
        const token = authHeader.split(' ')[1];

        // Verify if token exists after splitting
        if (!token) {
            return res.status(401).json({ 
                message: 'Access denied. Token is missing.' 
            });
        }

        // Verify the token
        const payload = jwt.verify(token, process.env.JWT_SECRET);

        // Attach more complete user info to request
        req.user = { 
            id: payload.userId, 
            email: payload.email 
        };

        // Continue to next middleware/route
        next();

    } catch (error) {
        // Handle different types of JWT errors
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Token has expired.' });
        } else if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ message: 'Invalid token.' });
        } else {
            return res.status(500).json({ message: 'Token verification failed.' });
        }
    }
};

module.exports = authMiddleware;
