const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { Server } = require("socket.io");

// Route Imports
const authRoutes = require('./routes/auth.js');
const projectRoutes = require('./routes/projects.js');
const issueRoutes = require('./routes/issues.js');

// Initialization
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "*", // Use env variable for production
    methods: ["GET", "POST", "PATCH", "DELETE"],
    credentials: true
  }
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true
}));
app.use(express.json({ limit: '10mb' })); // Add size limit

// Middleware to attach io to each request
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Main Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/issues', issueRoutes);

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'SyncFlow API with Real-time Support is running!',
    status: 'healthy',
    version: '1.0.0'
  });
});

// Health check route (important for Render)
app.get('/health', async (req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$disconnect(); // ← CHANGE 1: Prevent memory leaks
    res.json({ 
      status: 'healthy', 
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      database: 'disconnected'
    });
  }
});

// Socket.IO connection logic
io.on('connection', (socket) => {
  console.log('✅ A user connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('❌ A user disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

// CHANGE 2: Graceful shutdown for Render
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  httpServer.close(() => {
    console.log('Process terminated');
  });
});

// Start the server
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});
