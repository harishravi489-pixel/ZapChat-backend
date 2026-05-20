const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');

// ─── POST a story ─────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  const { media_url, media_type, caption } = req.body;
  if (!media_url) return res.status(400).json({ error: 'media_url required' });

  const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

  const { data, error } = await supabase
    .from('stories')
    .insert({ user_id: req.user.id, media_url, media_type: media_type || 'image', caption, expires_at })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// ─── GET stories feed (from people I follow) ─────────────
router.get('/feed', authenticate, async (req, res) => {
  const { data: follows } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', req.user.id);

  const ids = (follows || []).map(f => f.following_id);
  ids.push(req.user.id);

  const { data } = await supabase
    .from('stories')
    .select('*, user:user_id(id, username, display_name, avatar_url, is_private)')
    .in('user_id', ids)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  // Group by user
  const grouped = new Map();
  (data || []).forEach(story => {
    const uid = story.user.id;
    if (!grouped.has(uid)) grouped.set(uid, { user: story.user, stories: [] });
    grouped.get(uid).stories.push(story);
  });

  res.json([...grouped.values()]);
});

// ─── MARK story as viewed ─────────────────────────────────
router.post('/:storyId/view', authenticate, async (req, res) => {
  await supabase
    .from('story_views')
    .upsert({ story_id: req.params.storyId, viewer_id: req.user.id })
    .select();
  res.json({ ok: true });
});

// ─── DELETE my story ──────────────────────────────────────
router.delete('/:storyId', authenticate, async (req, res) => {
  await supabase.from('stories').delete().eq('id', req.params.storyId).eq('user_id', req.user.id);
  res.json({ message: 'Story deleted' });
});

module.exports = router;
