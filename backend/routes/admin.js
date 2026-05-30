const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Middleware: verify admin JWT + admin role
const adminAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: user, error } = await supabase
      .from('users')
      .select('id, role')
      .eq('id', decoded.sub)
      .single();

    if (error || !user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.adminId = user.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ─── DASHBOARD STATS ────────────────────────────────────────────────────────
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const [users, posts, reports, bans] = await Promise.all([
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('posts').select('id', { count: 'exact', head: true }),
      supabase.from('reports').select('id, status', { count: 'exact' }),
      supabase.from('user_bans').select('id', { count: 'exact', head: true }).eq('active', true),
    ]);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count: newUsersWeek } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sevenDaysAgo);

    const pendingReports = reports.data?.filter(r => r.status === 'pending').length || 0;

    res.json({
      totalUsers: users.count || 0,
      totalPosts: posts.count || 0,
      totalReports: reports.count || 0,
      pendingReports,
      activeBans: bans.count || 0,
      newUsersThisWeek: newUsersWeek || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── USER MANAGEMENT ────────────────────────────────────────────────────────
router.get('/users', adminAuth, async (req, res) => {
  try {
    const { page = 1, search = '', filter = 'all' } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('users')
      .select('id, username, email, display_name, avatar_url, role, is_private, created_at, strike_count', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`username.ilike.%${search}%,email.ilike.%${search}%,display_name.ilike.%${search}%`);
    }

    if (filter === 'banned') {
      const { data: bannedIds } = await supabase
        .from('user_bans')
        .select('user_id')
        .eq('active', true);
      const ids = bannedIds?.map(b => b.user_id) || [];
      query = query.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    } else if (filter === 'struck') {
      query = query.gt('strike_count', 0);
    }

    const { data, count, error } = await query;
    if (error) throw error;

    const userIds = data.map(u => u.id);
    const { data: bans } = await supabase
      .from('user_bans')
      .select('user_id, reason, banned_until, permanent')
      .in('user_id', userIds)
      .eq('active', true);

    const banMap = {};
    bans?.forEach(b => { banMap[b.user_id] = b; });

    const enriched = data.map(u => ({ ...u, ban: banMap[u.id] || null }));

    res.json({ users: enriched, total: count, page: Number(page), limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/users/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [userRes, postsRes, reportsRes, banRes] = await Promise.all([
      supabase.from('users').select('id, username, email, display_name, avatar_url, role, is_private, created_at, strike_count, bio').eq('id', id).single(),
      supabase.from('posts').select('id, content, created_at, media_url').eq('user_id', id).order('created_at', { ascending: false }).limit(10),
      supabase.from('reports').select('id, reason, status, created_at, reporter_id').eq('reported_user_id', id).order('created_at', { ascending: false }),
      supabase.from('user_bans').select('*').eq('user_id', id).eq('active', true).maybeSingle(),
    ]);

    if (userRes.error) throw userRes.error;

    res.json({
      user: userRes.data,
      recentPosts: postsRes.data || [],
      reports: reportsRes.data || [],
      activeBan: banRes.data || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/strike', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data: user } = await supabase.from('users').select('strike_count').eq('id', id).single();
    const newCount = (user.strike_count || 0) + 1;

    await supabase.from('users').update({ strike_count: newCount }).eq('id', id);

    await supabase.from('admin_actions').insert({
      admin_id: req.adminId,
      target_user_id: id,
      action_type: 'strike',
      reason,
      metadata: { strike_number: newCount },
    });

    if (newCount >= 3) {
      await supabase.from('user_bans').upsert({
        user_id: id,
        reason: 'Auto-banned after 3 strikes',
        permanent: false,
        banned_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        active: true,
        banned_by: req.adminId,
      }, { onConflict: 'user_id' });
    }

    res.json({ success: true, newStrikeCount: newCount, autoBanned: newCount >= 3 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/ban', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, permanent = false, days = 7 } = req.body;
    const bannedUntil = permanent ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    await supabase.from('user_bans').upsert({
      user_id: id, reason, permanent,
      banned_until: bannedUntil, active: true, banned_by: req.adminId,
    }, { onConflict: 'user_id' });

    await supabase.from('admin_actions').insert({
      admin_id: req.adminId, target_user_id: id,
      action_type: 'ban', reason, metadata: { permanent, days },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/unban', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await supabase.from('user_bans').update({ active: false }).eq('user_id', id);
    await supabase.from('admin_actions').insert({
      admin_id: req.adminId, target_user_id: id,
      action_type: 'unban', reason: 'Manual unban by admin',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    await supabase.from('admin_actions').insert({
      admin_id: req.adminId, target_user_id: id,
      action_type: 'delete_account', reason,
    });
    await supabase.from('users').delete().eq('id', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REPORTS QUEUE ───────────────────────────────────────────────────────────
router.get('/reports', adminAuth, async (req, res) => {
  try {
    const { status = 'pending', page = 1 } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('reports')
      .select(`
        id, reason, description, status, created_at, content_type, content_id,
        reporter:reporter_id(id, username, avatar_url),
        reported_user:reported_user_id(id, username, avatar_url)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status !== 'all') query = query.eq('status', status);

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({ reports: data || [], total: count, page: Number(page), limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/reports/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_note } = req.body;

    await supabase.from('reports').update({ status }).eq('id', id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SPARK CONTENT MODERATION ────────────────────────────────────────────────
router.get('/spark/profiles', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('spark_profiles')
      .select(`
        id, interests, mood, age_range, looking_for, is_active, created_at, flag_count,
        user:user_id(id, username, avatar_url, strike_count)
      `)
      .order('flag_count', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ profiles: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/spark/profiles/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active, admin_note } = req.body;

    await supabase.from('spark_profiles').update({ is_active }).eq('id', id);

    await supabase.from('admin_actions').insert({
      admin_id: req.adminId,
      action_type: is_active ? 'spark_approve' : 'spark_reject',
      reason: admin_note,
      metadata: { spark_profile_id: id },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CONTENT MODERATION (Posts) ──────────────────────────────────────────────
router.get('/posts/flagged', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('posts')
      .select(`id, content, media_url, created_at, user:user_id(id, username, avatar_url)`)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ posts: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/posts/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const { data: post } = await supabase.from('posts').select('user_id').eq('id', id).single();
    await supabase.from('admin_actions').insert({
      admin_id: req.adminId, target_user_id: post?.user_id,
      action_type: 'delete_post', reason, metadata: { post_id: id },
    });
    await supabase.from('posts').delete().eq('id', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN ACTION LOG ────────────────────────────────────────────────────────
router.get('/actions', adminAuth, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const limit = 30;
    const offset = (page - 1) * limit;

    const { data, count, error } = await supabase
      .from('admin_actions')
      .select(`
        id, action_type, reason, created_at, metadata,
        admin:admin_id(id, username),
        target_user:target_user_id(id, username)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ actions: data || [], total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
