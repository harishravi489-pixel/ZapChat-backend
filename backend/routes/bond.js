const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authenticate = require('../middleware/authenticate');

const DAILY_PROMPTS = [
  "What made you smile today?",
  "What's one thing you appreciate about your partner?",
  "Describe your perfect day together",
  "What's a memory you cherish most?",
  "What's something new you want to try together?",
  "What song reminds you of your relationship?",
  "What's the funniest moment you've shared?",
  "What's one thing your partner does that makes you feel loved?",
  "Where would your dream vacation be together?",
  "What's something you want to learn from your partner?",
  "What's your favourite thing to do together?",
  "What did you first notice about your partner?",
  "What's a goal you want to achieve together?",
  "How has your partner changed your life?",
  "What's one thing you wish your partner knew?",
]

router.post('/invite', authenticate, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const { data: partner } = await supabase.from('users').select('id, username, display_name, avatar_url').eq('username', username.toLowerCase()).single();
  if (!partner) return res.status(404).json({ error: 'User not found' });
  if (partner.id === req.user.id) return res.status(400).json({ error: "Can't bond with yourself" });
  const { data: existing } = await supabase.from('bonds').select('*').or(`and(user1_id.eq.${req.user.id},user2_id.eq.${partner.id}),and(user1_id.eq.${partner.id},user2_id.eq.${req.user.id})`).single();
  if (existing) return res.status(409).json({ error: 'Bond already exists', bond: existing });
  const { data, error } = await supabase.from('bonds').insert({ user1_id: req.user.id, user2_id: partner.id, status: 'pending' }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ bond: data, partner });
});

router.post('/accept/:bondId', authenticate, async (req, res) => {
  const { data, error } = await supabase.from('bonds').update({ status: 'active', started_at: new Date().toISOString() }).eq('id', req.params.bondId).eq('user2_id', req.user.id).select().single();
  if (error || !data) return res.status(400).json({ error: 'Could not accept bond' });
  res.json({ bond: data });
});

router.get('/mine', authenticate, async (req, res) => {
  const { data } = await supabase.from('bonds').select('*').or(`user1_id.eq.${req.user.id},user2_id.eq.${req.user.id}`).in('status', ['pending', 'active']).order('created_at', { ascending: false }).limit(1).single();
  if (!data) return res.json({ bond: null });
  const partnerId = data.user1_id === req.user.id ? data.user2_id : data.user1_id;
  const { data: partner } = await supabase.from('users').select('id, username, display_name, avatar_url').eq('id', partnerId).single();
  const daysTotal = data.started_at ? Math.floor((new Date() - new Date(data.started_at)) / (1000 * 60 * 60 * 24)) : 0;
  res.json({ bond: data, partner, daysTotal });
});

router.get('/prompt', authenticate, async (req, res) => {
  const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  res.json({ prompt: DAILY_PROMPTS[dayOfYear % DAILY_PROMPTS.length] });
});

router.post('/answer', authenticate, async (req, res) => {
  const { bond_id, prompt, answer } = req.body;
  if (!bond_id || !answer?.trim()) return res.status(400).json({ error: 'bond_id and answer required' });
  const { data, error } = await supabase.from('bond_entries').upsert({ bond_id, user_id: req.user.id, prompt, answer: answer.trim(), date: new Date().toISOString().split('T')[0] }, { onConflict: 'bond_id,user_id,date' }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.get('/entries/:bondId', authenticate, async (req, res) => {
  const { data } = await supabase.from('bond_entries').select('*, user:user_id(id, username, display_name, avatar_url)').eq('bond_id', req.params.bondId).order('created_at', { ascending: false }).limit(20);
  res.json(data || []);
});

router.post('/memory', authenticate, async (req, res) => {
  const { bond_id, title, note, media_url, memory_date } = req.body;
  if (!bond_id || !title?.trim()) return res.status(400).json({ error: 'bond_id and title required' });
  const { data, error } = await supabase.from('bond_memories').insert({ bond_id, user_id: req.user.id, title: title.trim(), note: note || '', media_url: media_url || null, memory_date: memory_date || new Date().toISOString().split('T')[0] }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.get('/memories/:bondId', authenticate, async (req, res) => {
  const { data } = await supabase.from('bond_memories').select('*').eq('bond_id', req.params.bondId).order('memory_date', { ascending: false });
  res.json(data || []);
});

router.post('/advice', authenticate, async (req, res) => {
  const { bond_id, question } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question required' });
  const { data, error } = await supabase.from('bond_advice').insert({ bond_id: bond_id || null, user_id: req.user.id, question: question.trim() }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.get('/advice', authenticate, async (req, res) => {
  const { data } = await supabase.from('bond_advice').select('*, replies:bond_advice_replies(count)').order('created_at', { ascending: false }).limit(20);
  res.json(data || []);
});

router.post('/advice/:adviceId/reply', authenticate, async (req, res) => {
  const { reply } = req.body;
  if (!reply?.trim()) return res.status(400).json({ error: 'Reply required' });
  const { data, error } = await supabase.from('bond_advice_replies').insert({ advice_id: req.params.adviceId, user_id: req.user.id, reply: reply.trim() }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.get('/advice/:adviceId/replies', authenticate, async (req, res) => {
  const { data } = await supabase.from('bond_advice_replies').select('*, user:user_id(id, username, display_name, avatar_url)').eq('advice_id', req.params.adviceId).order('created_at', { ascending: true });
  res.json(data || []);
});

router.post('/end', authenticate, async (req, res) => {
  const { bond_id } = req.body;
  await supabase.from('bonds').update({ status: 'ended' }).eq('id', bond_id).or(`user1_id.eq.${req.user.id},user2_id.eq.${req.user.id}`);
  res.json({ message: 'Bond ended' });
});

module.exports = router;