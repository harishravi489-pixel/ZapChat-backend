const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');

// ─── CREATE post ──────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  const { media_url, media_type, caption, thumbnail_url } = req.body;
  if (!media_url) return res.status(400).json({ error: 'media_url is required' });

  const { data, error } = await supabase
    .from('posts')
    .insert({
      user_id: req.user.id,
      media_url,
      media_type: media_type || 'image',
      caption: caption || '',
      thumbnail_url,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// ─── GET feed (posts from people I follow) ────────────────
router.get('/feed', authenticate, async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = 10;

  // Get IDs of people I follow
  const { data: follows } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', req.user.id);

  const followingIds = (follows || []).map(f => f.following_id);
  followingIds.push(req.user.id); // include my own posts

  if (followingIds.length === 0) return res.json([]);

  const { data, error } = await supabase
    .from('posts')
    .select(`
      *,
      user:user_id(id, username, display_name, avatar_url, is_private),
      likes:post_likes(count),
      comments:comments(count)
    `)
    .in('user_id', followingIds)
    .order('created_at', { ascending: false })
    .range(page * limit, (page + 1) * limit - 1);

  if (error) return res.status(500).json({ error: error.message });

  // For each post, check if current user liked it
  const postIds = data.map(p => p.id);
  const { data: myLikes } = await supabase
    .from('post_likes')
    .select('post_id')
    .eq('user_id', req.user.id)
    .in('post_id', postIds);

  const likedSet = new Set((myLikes || []).map(l => l.post_id));
  const posts = data.map(p => ({ ...p, liked_by_me: likedSet.has(p.id) }));

  res.json(posts);
});

// ─── GET posts by user (respects privacy) ─────────────────
router.get('/user/:userId', authenticate, async (req, res) => {
  const { data: profile } = await supabase
    .from('users')
    .select('is_private')
    .eq('id', req.params.userId)
    .single();

  if (!profile) return res.status(404).json({ error: 'User not found' });

  // Check privacy
  if (profile.is_private && req.params.userId !== req.user.id) {
    const { data: followRow } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_id', req.user.id)
      .eq('following_id', req.params.userId)
      .single();

    if (!followRow) return res.status(403).json({ error: 'This account is private', private: true });
  }

  const { data } = await supabase
    .from('posts')
    .select('*, likes:post_likes(count), comments:comments(count)')
    .eq('user_id', req.params.userId)
    .order('created_at', { ascending: false });

  res.json(data || []);
});

// ─── LIKE / UNLIKE post ───────────────────────────────────
router.post('/:postId/like', authenticate, async (req, res) => {
  const { error } = await supabase
    .from('post_likes')
    .insert({ post_id: req.params.postId, user_id: req.user.id });

  if (error?.code === '23505') {
    await supabase.from('post_likes')
      .delete().eq('post_id', req.params.postId).eq('user_id', req.user.id);
    return res.json({ liked: false });
  }
  res.json({ liked: true });
});

// ─── GET comments ─────────────────────────────────────────
router.get('/:postId/comments', authenticate, async (req, res) => {
  const { data } = await supabase
    .from('comments')
    .select('*, user:user_id(id, username, display_name, avatar_url)')
    .eq('post_id', req.params.postId)
    .order('created_at', { ascending: true });
  res.json(data || []);
});

// ─── ADD comment ──────────────────────────────────────────
router.post('/:postId/comments', authenticate, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Comment text required' });

  const { data, error } = await supabase
    .from('comments')
    .insert({ post_id: req.params.postId, user_id: req.user.id, text: text.trim() })
    .select('*, user:user_id(id, username, display_name, avatar_url)')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// ─── DELETE post ──────────────────────────────────────────
router.delete('/:postId', authenticate, async (req, res) => {
  const { error } = await supabase
    .from('posts')
    .delete()
    .eq('id', req.params.postId)
    .eq('user_id', req.user.id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Post deleted' });
});

module.exports = router;
