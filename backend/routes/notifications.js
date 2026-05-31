const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');

// ─── Save push token ──────────────────────────────────────
router.post('/token', authenticate, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const { error } = await supabase
    .from('push_tokens')
    .upsert({ user_id: req.user.id, token }, { onConflict: 'user_id,token' });

  if (error) console.error('Token save error:', error.message);
  res.json({ message: 'Token saved' });
});

// ─── Delete push token (logout) ───────────────────────────
router.delete('/token', authenticate, async (req, res) => {
  const { token } = req.body;
  if (token) {
    await supabase.from('push_tokens').delete().eq('user_id', req.user.id).eq('token', token);
  } else {
    await supabase.from('push_tokens').delete().eq('user_id', req.user.id);
  }
  res.json({ message: 'Token removed' });
});

// ─── Get OAuth2 access token from service account ─────────
async function getAccessToken() {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!privateKey || !clientEmail) {
    throw new Error('Missing Firebase credentials in environment variables');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;

  const { createSign } = require('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await response.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

// ─── Send notification to a user (all their devices) ──────
async function sendNotificationToUser(userId, title, body, data = {}) {
  try {
    const { data: tokens, error: tokenError } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId);

    if (tokenError) { console.error('Error fetching tokens:', tokenError.message); return; }
    if (!tokens || tokens.length === 0) { console.log(`No push tokens found for user ${userId}`); return; }

    console.log(`Sending notification to user ${userId}, ${tokens.length} device(s)`);

    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) { console.error('FIREBASE_PROJECT_ID not set'); return; }

    const accessToken = await getAccessToken();
    const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));

    const promises = tokens.map(({ token }) =>
      fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: stringData,
            android: {
              priority: 'high',
              notification: {
                channelId: 'zapchat_messages',
                defaultSound: true,
              },
            },
            apns: {
              payload: {
                aps: { alert: { title, body }, sound: 'default', badge: 1 },
              },
            },
            webpush: {
              notification: {
                title,
                body,
                icon: '/icons/icon-192x192.png',
                badge: '/icons/icon-72x72.png',
              },
              fcm_options: { link: data.url || '/feed' },
            },
          },
        }),
      })
        .then(r => r.json())
        .then(result => {
          if (result.error) {
            console.error('FCM error for token:', JSON.stringify(result.error));
            if (result.error.code === 404 || result.error.status === 'UNREGISTERED') {
              supabase.from('push_tokens').delete().eq('token', token).then(() => {});
            }
          } else {
            console.log('Notification sent successfully:', result.name);
          }
        })
        .catch(err => console.error('FCM fetch error:', err.message))
    );

    await Promise.allSettled(promises);
  } catch (e) {
    console.error('Notification error:', e.message);
  }
}

// ─── Test endpoint ────────────────────────────────────────
router.post('/test', authenticate, async (req, res) => {
  try {
    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', req.user.id);

    if (!tokens || tokens.length === 0) {
      return res.status(400).json({
        error: 'No push tokens found for your account. Make sure notifications are enabled in your browser/app.'
      });
    }

    await sendNotificationToUser(
      req.user.id,
      '⚡ ZapChat',
      'Push notifications are working!',
      { url: '/feed', tag: 'test' }
    );

    res.json({ message: 'Test notification sent!', devices: tokens.length });
  } catch (err) {
    console.error('Test notification error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.sendNotificationToUser = sendNotificationToUser;
