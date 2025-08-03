const express = require('express');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const prisma = new PrismaClient();
const router = express.Router();

// ✅ Authentication middleware for protected routes
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'Access token is required' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// Configure Nodemailer
const transporter = nodemailer.createTransporter({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
    },
});

// SIGNUP ROUTE
router.post('/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ message: 'All fields are required.' });
        }
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ message: 'User with this email already exists.' });
        }
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const newUser = await prisma.user.create({
            data: { name, email, password_hash },
        });
        res.status(201).json({
            message: 'User created successfully!',
            user: { id: newUser.id, name: newUser.name, email: newUser.email },
        });
    } catch (error) {
        console.error('Signup Error:', error);
        res.status(500).json({ message: 'Server error during signup.' });
    }
});

// LOGIN ROUTE
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required.' });
        }
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            return res.status(400).json({ message: 'Invalid credentials.' });
        }
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid credentials.' });
        }
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );
        res.status(200).json({
            message: 'Logged in successfully!',
            token,
            user: { id: user.id, name: user.name, email: user.email },
        });
    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

// FORGOT PASSWORD ROUTE
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            return res.status(200).json({ message: 'If a user with that email exists, an OTP has been sent.' });
        }
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expires_at = new Date(Date.now() + 10 * 60 * 1000); // Expires in 10 minutes
        await prisma.otp.create({ data: { email, otp, expires_at } });
        const mailOptions = {
            from: process.env.GMAIL_USER,
            to: email,
            subject: 'Your Password Reset OTP',
            text: `Your OTP for password reset is: ${otp}. It will expire in 10 minutes.`,
            html: `<p>Your OTP for password reset is: <strong>${otp}</strong>. It will expire in 10 minutes.</p>`,
        };
        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: 'OTP sent to your email successfully.' });
    } catch (error) {
        console.error('Forgot Password Error:', error);
        res.status(500).json({ message: 'Server error while sending OTP.' });
    }
});

// VERIFY OTP & RESET PASSWORD ROUTE
router.post('/verify-otp', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        const otpRecord = await prisma.otp.findFirst({
            where: { email, otp, expires_at: { gt: new Date() } },
        });
        if (!otpRecord) {
            return res.status(400).json({ message: 'Invalid or expired OTP.' });
        }
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(newPassword, salt);
        await prisma.user.update({
            where: { email },
            data: { password_hash },
        });
        await prisma.otp.delete({ where: { id: otpRecord.id } });
        res.status(200).json({ message: 'Password has been reset successfully.' });
    } catch (error) {
        console.error('Verify OTP Error:', error);
        res.status(500).json({ message: 'Server error during password reset.' });
    }
});

// ===============================================
// ✅ NEW USER MANAGEMENT ENDPOINTS
// ===============================================

// GET ALL USERS (for user assignment)
router.get('/users', authenticateToken, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                name: true,
                email: true,
                createdAt: true
            }
        });
        
        console.log(`Retrieved ${users.length} users for assignment`);
        res.json(users);
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ message: 'Failed to fetch users' });
    }
});

// SEARCH USERS by name or email
router.get('/users/search', authenticateToken, async (req, res) => {
    try {
        const { q } = req.query;
        
        if (!q) {
            return res.status(400).json({ message: 'Search query is required' });
        }
        
        const users = await prisma.user.findMany({
            where: {
                OR: [
                    {
                        name: {
                            contains: q,
                            mode: 'insensitive'
                        }
                    },
                    {
                        email: {
                            contains: q,
                            mode: 'insensitive'
                        }
                    }
                ]
            },
            select: {
                id: true,
                name: true,
                email: true,
                createdAt: true
            }
        });
        
        console.log(`Search found ${users.length} users for query: "${q}"`);
        res.json(users);
    } catch (error) {
        console.error('Search users error:', error);
        res.status(500).json({ message: 'Failed to search users' });
    }
});

// FIND USER by exact email
router.get('/users/find-by-email', authenticateToken, async (req, res) => {
    try {
        const { email } = req.query;
        
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }
        
        const user = await prisma.user.findUnique({
            where: {
                email: email.toLowerCase()
            },
            select: {
                id: true,
                name: true,
                email: true,
                createdAt: true
            }
        });
        
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        console.log(`Found user by email: ${email}`, user.name);
        res.json(user);
    } catch (error) {
        console.error('Find user by email error:', error);
        res.status(500).json({ message: 'Failed to find user' });
    }
});

// FIND USERS by exact name
router.get('/users/find-by-name', authenticateToken, async (req, res) => {
    try {
        const { name } = req.query;
        
        if (!name) {
            return res.status(400).json({ message: 'Name is required' });
        }
        
        const users = await prisma.user.findMany({
            where: {
                name: {
                    equals: name,
                    mode: 'insensitive'
                }
            },
            select: {
                id: true,
                name: true,
                email: true,
                createdAt: true
            }
        });
        
        console.log(`Found ${users.length} users with name: "${name}"`);
        res.json(users);
    } catch (error) {
        console.error('Find user by name error:', error);
        res.status(500).json({ message: 'Failed to find user by name' });
    }
});

module.exports = router;
