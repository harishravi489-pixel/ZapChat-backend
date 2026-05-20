const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');

// ─── GET my conversations ─────────────────────────────────
router.get('/conversations', authenticate, async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select(`
      id, created_at, text, media_url, media_type, is_view_once, is_opened, is_deleted,
      sender:sender_id(id, username, display_name, avatar_url),
      recipient:recipient_id(id, username, display_name, avatar_url)
    `)
    .or(`sender_id.eq.${req.user.id},recipient_id.eq.${req.user.id}`)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Group by conversation partner
  const convMap = new Map();
  data.forEach(msg => {
    const partner = msg.sender.id === req.user.id ? msg.recipient : msg.sender;
    if (!convMap.has(partner.id)) {
      convMap.set(partner.id, { partner, lastMessage: msg, unreadCount: 0 });
    }
    if (msg.recipient.id === req.user.id && !msg.read_at) {
      convMap.get(partner.id).unreadCount++;
    }
  });

  res.json([...convMap.values()]);
});

// ─── GET messages with a user ─────────────────────────────
router.get('/:userId', authenticate, async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = 30;

  const { data } = await supabase
    .from('messages')
    .select(`
      id, created_at, text, media_url, media_type, media_thumbnail, 
      is_view_once, is_opened, is_deleted, read_at,
      sender_id, recipient_id
    `)
    .or(
      `and(sender_id.eq.${req.user.id},recipient_id.eq.${req.params.userId}),and(sender_id.eq.${req.params.userId},recipient_id.eq.${req.user.id})`
    )
    .order('created_at', { ascending: false })
    .range(page * limit, (page + 1) * limit - 1);

  // Mark messages to me as read
  await supabase
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_id', req.user.id)
    .eq('sender_id', req.params.userId)
    .is('read_at', null);

  res.json((data || []).reverse());
});

// ─── SEND message ─────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  const { recipient_id, text, media_url, media_type, media_thumbnail, is_view_once } = req.body;
  if (!recipient_id) return res.status(400).json({ error: 'recipient_id required' });
  if (!text && !media_url) return res.status(400).json({ error: 'text or media required' });

  const { data, error } = await supabase
    .from('messages')
    .insert({
      sender_id: req.user.id,
      recipient_id,
      text: text || null,
      media_url: media_url || null,
      media_type: media_type || null,
      media_thumbnail: media_thumbnail || null,
      is_view_once: !!is_view_once,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// ─── OPEN view-once message (marks it as opened + deletes media) ──
router.post('/:messageId/open', authenticate, async (req, res) => {
  const { data: msg } = await supabase
    .from('messages')
    .select('*')
    .eq('id', req.params.messageId)
    .eq('recipient_id', req.user.id)
    .eq('is_view_once', true)
    .single();

  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.is_opened) return res.status(400).json({ error: 'Already opened' });

  // Mark as opened — media_url cleared so it's gone after viewing
  await supabase
    .from('messages')
    .update({ is_opened: true, media_url: null, opened_at: new Date().toISOString() })
    .eq('id', req.params.messageId);

  // Return the media URL ONE time before wiping it
  res.json({ media_url: msg.media_url, media_type: msg.media_type });
});

// ─── DELETE message for me (not for both — add that later) ─
router.delete('/:messageId', authenticate, async (req, res) => {
  const { error } = await supabase
    .from('messages')
    .update({ is_deleted: true })
    .eq('id', req.params.messageId)
    .eq('sender_id', req.user.id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Deleted' });
});

module.exports = router;
