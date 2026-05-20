const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const admin = require('firebase-admin');
const supabase = require('../supabase');

// Initialize Firebase Admin once
if (!admin.apps.length) {
  try {
    const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (err) {
    console.warn('Firebase service account not loaded:', err.message);
  }
}
// Initialize Twilio Verify
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ─── Helpers ──────────────────────────────────────────────
function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// ─── SEND OTP to phone ────────────────────────────────────
// POST /api/auth/send-phone-otp
router.post('/send-phone-otp', async (req, res) => {
  const { phone } = req.body; // e.g. "+971501234567"
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  try {
    await twilioClient.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: 'sms' });

    res.json({ message: 'OTP sent to phone' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send OTP. Check phone number format.' });
  }
});

// ─── VERIFY phone OTP ─────────────────────────────────────
// POST /api/auth/verify-phone-otp
router.post('/verify-phone-otp', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

  try {
    const result = await twilioClient.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: phone, code });

    if (result.status !== 'approved') {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    res.json({ verified: true });
  } catch (err) {
    res.status(400).json({ error: 'OTP verification failed' });
  }
});

// ─── GOOGLE sign-in (verify Firebase ID token) ────────────
// POST /api/auth/google
router.post('/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decoded;

    // Upsert user in Supabase
    const { data: user, error } = await supabase
      .from('users')
      .upsert({ firebase_uid: uid, email, display_name: name, avatar_url: picture },
               { onConflict: 'firebase_uid' })
      .select()
      .single();

    if (error) throw error;
    res.json({ token: signToken(user.id), user });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// ─── SIGN UP (email + phone, after both OTPs verified) ────
// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { email, phone, username, password, display_name } = req.body;
  if (!email || !phone || !username || !password) {
    return res.status(400).json({ error: 'email, phone, username and password are required' });
  }

  try {
    // Check username availability
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('username', username.toLowerCase())
      .single();

    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const password_hash = await bcrypt.hash(password, 12);

    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email,
        phone,
        username: username.toLowerCase(),
        display_name: display_name || username,
        password_hash,
        is_private: false,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Email or phone already registered' });
      throw error;
    }

    res.status(201).json({ token: signToken(user.id), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// ─── LOG IN ───────────────────────────────────────────────
// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { identifier, password } = req.body; // identifier = username or email
  if (!identifier || !password) return res.status(400).json({ error: 'Credentials required' });

  try {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .or(`username.eq.${identifier.toLowerCase()},email.eq.${identifier}`)
      .single();

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    // Check if banned
    const { data: ban } = await supabase
      .from('bans')
      .select('*')
      .eq('user_id', user.id)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const { password_hash, ...safeUser } = user;
    res.json({ token: signToken(user.id), user: safeUser, ban: ban || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── CHECK USERNAME availability ─────────────────────────
// GET /api/auth/check-username/:username
router.get('/check-username/:username', async (req, res) => {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('username', req.params.username.toLowerCase())
    .single();

  res.json({ available: !data });
});

module.exports = router;
