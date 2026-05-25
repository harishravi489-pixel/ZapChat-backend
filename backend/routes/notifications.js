const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');
const admin = require('firebase-admin');

// ─── SAVE push token ──────────────────────────────────────
router.post('/token', authenticate, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  await supabase
    .from('push_tokens')
    .upsert({ user_id: req.user.id, token }, { onConflict: 'user_id,token' });

  res.json({ message: 'Token saved' });
});

// ─── Helper: send notification ────────────────────────────
async function sendNotificationToUser(userId, title, body, data = {}) {
  try {
    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId);

    if (!tokens || tokens.length === 0) return;

    const messaging = admin.messaging();

    const promises = tokens.map(({ token }) =>
      messaging.send({
        token,
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
        webpush: {
          notification: {
            title,
            body,
            icon: 'https://zap-chat-frontend-phi.vercel.app/icon.png',
          },
        },
      }).catch(err => {
        // Remove invalid tokens
        if (err.code === 'messaging/invalid-registration-token' ||
            err.code === 'messaging/registration-token-not-registered') {
          supabase.from('push_tokens').delete().eq('token', token);
        }
      })
    );

    await Promise.allSettled(promises);
  } catch (e) {
    console.error('Notification error:', e.message);
  }
}

module.exports = router;
module.exports.sendNotificationToUser = sendNotificationToUser;