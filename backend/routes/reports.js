const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');

// ─── SUBMIT report ────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  const { reported_user_id, reason, description, content_type, content_id } = req.body;
  if (!reported_user_id || !reason) {
    return res.status(400).json({ error: 'reported_user_id and reason required' });
  }

  const { data, error } = await supabase
    .from('reports')
    .insert({
      reporter_id: req.user.id,
      reported_user_id,
      reason,
      description: description || '',
      content_type: content_type || 'user',
      content_id: content_id || null,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: 'Report submitted. Our team will review it.', id: data.id });
});

// ─── ADMIN: get all pending reports ──────────────────────
// Protect with admin check in production
router.get('/admin/pending', authenticate, async (req, res) => {
  const { data } = await supabase
    .from('reports')
    .select(`
      *,
      reporter:reporter_id(id, username, avatar_url),
      reported_user:reported_user_id(id, username, avatar_url, strike_count)
    `)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  res.json(data || []);
});

// ─── ADMIN: take action on report ────────────────────────
router.post('/admin/:reportId/action', authenticate, async (req, res) => {
  const { action } = req.body; // 'warn', 'ban_3d', 'ban_permanent', 'dismiss'

  const { data: report } = await supabase
    .from('reports')
    .select('*')
    .eq('id', req.params.reportId)
    .single();

  if (!report) return res.status(404).json({ error: 'Report not found' });

  // Update report status
  await supabase.from('reports').update({ status: action === 'dismiss' ? 'dismissed' : 'actioned' }).eq('id', report.id);

  if (action === 'dismiss') return res.json({ message: 'Report dismissed' });

  const userId = report.reported_user_id;

  // Get current user
  const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newStrikeCount = (user.strike_count || 0) + 1;
  await supabase.from('users').update({ strike_count: newStrikeCount }).eq('id', userId);

  // Issue strike record
  await supabase.from('strikes').insert({
    user_id: userId,
    reason: report.reason,
    report_id: report.id,
    strike_number: newStrikeCount,
  });

  // Issue ban
  if (action === 'ban_3d' || action === 'ban_permanent' || newStrikeCount >= 2) {
    const expires_at = action === 'ban_permanent'
      ? null
      : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    await supabase.from('bans').insert({
      user_id: userId,
      reason: report.reason,
      is_permanent: action === 'ban_permanent' || newStrikeCount >= 3,
      expires_at,
    });
  }

  res.json({ message: `Action taken: ${action}`, strike_count: newStrikeCount });
});

// ─── GET my ban status ────────────────────────────────────
router.get('/my-ban', authenticate, async (req, res) => {
  const { data } = await supabase
    .from('bans')
    .select('*')
    .eq('user_id', req.user.id)
    .or('is_permanent.eq.true,expires_at.gt.' + new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  res.json({ ban: data || null });
});

module.exports = router;
