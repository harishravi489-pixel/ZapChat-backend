require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

// ── Route imports ──────────────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const postRoutes = require('./routes/posts');
const messageRoutes = require('./routes/messages');
const storyRoutes = require('./routes/stories');
const reportRoutes = require('./routes/reports');
const mediaRoutes = require('./routes/media');
const sparkRoutes = require('./routes/spark');
const bondRoutes = require('./routes/bond');
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');
const roomRoutes = require('./routes/rooms');           // ← NEW
const subscriptionRoutes = require('./routes/subscriptions'); // ← NEW

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://zap-chat-frontend-phi.vercel.app',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  credentials: true,
}));
app.use(morgan('dev'));

// ── IMPORTANT: Stripe webhook needs raw body BEFORE express.json ───────────
app.use('/api/subscriptions/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));

// ── Rate limiters ──────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 200,
  message: { error: 'Too many auth attempts, please wait.' },
});

app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/send-phone-otp', authLimiter);
app.use('/api/auth/verify-phone-otp', authLimiter);
app.use('/api/auth/google', authLimiter);

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/stories', storyRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/spark', sparkRoutes);
app.use('/api/bond', bondRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rooms', roomRoutes);                     // ← NEW
app.use('/api/subscriptions', subscriptionRoutes);     // ← NEW

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Create HTTP server + attach Socket.io ──────────────────────────────────
const server = http.createServer(app);
const initSocket = require('./socket');                // ← NEW
initSocket(server);                                    // ← NEW

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`ZapChat backend running on port ${PORT}`));
