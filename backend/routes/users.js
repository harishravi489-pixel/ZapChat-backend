const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');

// ─── GET my profile ───────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  const { data } = await supabase
    .from('users')
    .select('id, username, display_name, email, phone, bio, avatar_url, pinned_song, is_private, strike_count, created_at')
    .eq('id', req.user.id)
    .single();
  res.json(data);
});

// ─── UPDATE my profile ────────────────────────────────────
router.put('/me', authenticate, async (req, res) => {
  const allowed = ['display_name', 'bio', 'avatar_url', 'pinned_song', 'is_private',
                   'allow_messages_from', 'show_read_receipts', 'show_online_status'];
  const updates = {};
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', req.user.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ─── GET user by username ─────────────────────────────────
router.get('/:username', authenticate, async (req, res) => {
  const { data: profile } = await supabase
    .from('users')
    .select('id, username, display_name, bio, avatar_url, pinned_song, is_private, created_at')
    .eq('username', req.params.username.toLowerCase())
    .single();

  if (!profile) return res.status(404).json({ error: 'User not found' });

  // Check if viewer follows this user
  const { data: followRow } = await supabase
    .from('follows')
    .select('id')
    .eq('follower_id', req.user.id)
    .eq('following_id', profile.id)
    .single();

  const isFollowing = !!followRow;

  // Get follower/following counts
  const [{ count: followers }, { count: following }] = await Promise.all([
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', profile.id),
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', profile.id),
  ]);

  res.json({ ...profile, isFollowing, followerCount: followers, followingCount: following });
});

// ─── SEARCH users ─────────────────────────────────────────
router.get('/search/query', authenticate, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);

  const { data } = await supabase
    .from('users')
    .select('id, username, display_name, avatar_url, is_private')
    .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
    .limit(20);

  res.json(data || []);
});

// ─── FOLLOW a user ────────────────────────────────────────
router.post('/:userId/follow', authenticate, async (req, res) => {
  const following_id = req.params.userId;
  if (following_id === req.user.id) return res.status(400).json({ error: "Can't follow yourself" });

  const { error } = await supabase
    .from('follows')
    .insert({ follower_id: req.user.id, following_id });

  if (error?.code === '23505') return res.status(409).json({ error: 'Already following' });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Followed' });
});

// ─── UNFOLLOW a user ──────────────────────────────────────
router.delete('/:userId/follow', authenticate, async (req, res) => {
  await supabase
    .from('follows')
    .delete()
    .eq('follower_id', req.user.id)
    .eq('following_id', req.params.userId);
  res.json({ message: 'Unfollowed' });
});

// ─── GET followers/following lists ────────────────────────
router.get('/:userId/followers', authenticate, async (req, res) => {
  const { data } = await supabase
    .from('follows')
    .select('follower:follower_id(id, username, display_name, avatar_url)')
    .eq('following_id', req.params.userId);
  res.json(data?.map(r => r.follower) || []);
});

router.get('/:userId/following', authenticate, async (req, res) => {
  const { data } = await supabase
    .from('follows')
    .select('following:following_id(id, username, display_name, avatar_url)')
    .eq('follower_id', req.params.userId);
  res.json(data?.map(r => r.following) || []);
});

module.exports = router;
