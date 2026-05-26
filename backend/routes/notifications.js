const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');

// ─── Save push token ──────────────────────────────────────
router.post('/token', authenticate, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  await supabase
    .from('push_tokens')
    .upsert({ user_id: req.user.id, token }, { onConflict: 'user_id,token' });

  res.json({ message: 'Token saved' });
});

// ─── Get OAuth2 access token from service account ─────────
async function getAccessToken() {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!privateKey || !clientEmail) {
    throw new Error('Missing Firebase credentials in environment variables');
  }

  // Create JWT for Google OAuth2
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  // Encode JWT header + payload
  const header = { alg: 'RS256', typ: 'JWT' };
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;

  // Sign with private key using Node.js crypto
  const { createSign } = require('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');

  const jwt = `${signingInput}.${signature}`;

  // Exchange JWT for access token
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
    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId);

    if (!tokens || tokens.length === 0) return;

    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) return;

    const accessToken = await getAccessToken();

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
            data: Object.fromEntries(
              Object.entries(data).map(([k, v]) => [k, String(v)])
            ),
            webpush: {
              notification: {
                title,
                body,
                icon: '/icon-192.png',
                badge: '/icon-192.png',
                click_action: data.url || '/',
              },
              fcm_options: {
                link: data.url || '/',
              },
            },
          },
        }),
      })
        .then(r => r.json())
        .then(result => {
          // Clean up invalid tokens
          if (result.error?.code === 404 || result.error?.status === 'UNREGISTERED') {
            supabase.from('push_tokens').delete().eq('token', token).then(() => {});
          }
        })
        .catch(() => {})
    );

    await Promise.allSettled(promises);
  } catch (e) {
    console.error('Notification error:', e.message);
  }
}

module.exports = router;
module.exports.sendNotificationToUser = sendNotificationToUser;
