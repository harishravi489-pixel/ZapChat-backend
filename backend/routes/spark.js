const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');

router.post('/profile', authenticate, async (req, res) => {
  const { interests, mood, age_range, looking_for } = req.body;
  const { data, error } = await supabase
    .from('spark_profiles')
    .upsert({
      user_id: req.user.id,
      interests: interests || [],
      mood: mood || 'chill',
      age_range: age_range || '18-25',
      looking_for: looking_for || 'friendship',
      is_active: true,
    }, { onConflict: 'user_id' })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.get('/profile', authenticate, async (req, res) => {
  const { data } = await supabase
    .from('spark_profiles')
    .select('*')
    .eq('user_id', req.user.id)
    .single();
  res.json(data || null);
});

router.post('/find', authenticate, async (req, res) => {
  const { data: existing } = await supabase
    .from('spark_matches')
    .select('*')
    .or(`user1_id.eq.${req.user.id},user2_id.eq.${req.user.id}`)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .limit(1)
    .single();
  if (existing) return res.json({ match: existing, already_matched: true });

  const { data: waiting } = await supabase
    .from('spark_matches')
    .select('*')
    .eq('status', 'waiting')
    .neq('user1_id', req.user.id)
    .limit(1)
    .single();

  if (waiting) {
    const { data: match } = await supabase
      .from('spark_matches')
      .update({ user2_id: req.user.id, status: 'active' })
      .eq('id', waiting.id)
      .select()
      .single();
    return res.json({ match, just_matched: true });
  }

  const { data: newMatch } = await supabase
    .from('spark_matches')
    .insert({
      user1_id: req.user.id,
      status: 'waiting',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single();
  res.json({ match: newMatch, waiting: true });
});

router.get('/match', authenticate, async (req, res) => {
  const { data } = await supabase
    .from('spark_matches')
    .select('*')
    .or(`user1_id.eq.${req.user.id},user2_id.eq.${req.user.id}`)
    .in('status', ['active', 'waiting'])
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  res.json({ match: data || null });
});

router.post('/message', authenticate, async (req, res) => {
  const { match_id, text } = req.body;
  if (!match_id || !text?.trim()) return res.status(400).json({ error: 'match_id and text required' });
  const { data, error } = await supabase
    .from('spark_messages')
    .insert({ match_id, sender_id: req.user.id, text: text.trim() })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.get('/messages/:matchId', authenticate, async (req, res) => {
  const { data } = await supabase
    .from('spark_messages')
    .select('*')
    .eq('match_id', req.params.matchId)
    .order('created_at', { ascending: true });
  res.json(data || []);
});

router.post('/reveal', authenticate, async (req, res) => {
  const { match_id } = req.body;
  const { data: match } = await supabase
    .from('spark_matches')
    .select('*')
    .eq('id', match_id)
    .single();
  if (!match) return res.status(404).json({ error: 'Match not found' });

  const isUser1 = match.user1_id === req.user.id;
  const updateField = isUser1 ? 'user1_revealed' : 'user2_revealed';
  const otherRevealed = isUser1 ? match.user2_revealed : match.user1_revealed;
  const bothRevealed = otherRevealed === true;

  const { data: updated } = await supabase
    .from('spark_matches')
    .update({ [updateField]: true, both_revealed: bothRevealed, status: bothRevealed ? 'revealed' : 'active' })
    .eq('id', match_id)
    .select()
    .single();
  res.json({ match: updated, both_revealed: bothRevealed });
});

router.post('/skip', authenticate, async (req, res) => {
  await supabase
    .from('spark_matches')
    .update({ status: 'skipped' })
    .or(`user1_id.eq.${req.user.id},user2_id.eq.${req.user.id}`)
    .in('status', ['active', 'waiting']);
  res.json({ message: 'Skipped' });
});

module.exports = router;