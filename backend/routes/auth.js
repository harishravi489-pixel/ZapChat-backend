const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const admin = require('firebase-admin');
const supabase = require('../supabase');

// Initialize Firebase Admin using environment variables (no JSON file needed)
if (!admin.apps.length) {
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const projectId = process.env.FIREBASE_PROJECT_ID;

    if (privateKey && clientEmail && projectId) {
      admin.initializeApp({
        credential: admin.credential.cert({ privateKey, clientEmail, projectId }),
      });
      console.log('Firebase Admin initialized successfully');
    } else {
      console.warn('Firebase Admin: missing env vars (FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL, FIREBASE_PROJECT_ID)');
    }
  } catch (err) {
    console.warn('Firebase Admin init failed:', err.message);
  }
}

// Initialize Twilio Verify
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ─── Helpers ──────────────────────────────────────────────
function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// ─── SEND OTP to phone ────────────────────────────────────
router.post('/send-phone-otp', async (req, res) => {
  const { phone } = req.body;
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

// ─── GOOGLE sign-in ────────────────────────────────────────
router.post('/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decoded;

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

// ─── SIGN UP ───────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  const { email, phone, username, password, display_name } = req.body;
  if (!email || !phone || !username || !password) {
    return res.status(400).json({ error: 'email, phone, username and password are required' });
  }

  try {
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

// ─── LOG IN ────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
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

// ─── CHECK USERNAME ────────────────────────────────────────
router.get('/check-username/:username', async (req, res) => {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('username', req.params.username.toLowerCase())
    .single();

  res.json({ available: !data });
});

module.exports = router;
