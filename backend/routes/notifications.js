const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');

router.post('/token', authenticate, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  await supabase
    .from('push_tokens')
    .upsert({ user_id: req.user.id, token }, { onConflict: 'user_id,token' });
  res.json({ message: 'Token saved' });
});

async function sendNotificationToUser(userId, title, body, data = {}) {
  try {
    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId);

    if (!tokens || tokens.length === 0) return;

    const serverKey = process.env.FCM_SERVER_KEY;
    if (!serverKey) return;

    const promises = tokens.map(({ token }) =>
      fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `key=${serverKey}`,
        },
        body: JSON.stringify({
          to: token,
          notification: { title, body },
          data: Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, String(v)])
          ),
        }),
      }).catch(() => {})
    );

    await Promise.allSettled(promises);
  } catch (e) {
    console.error('Notification error:', e.message);
  }
}

module.exports = router;
module.exports.sendNotificationToUser = sendNotificationToUser;