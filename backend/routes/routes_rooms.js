// routes/rooms.js
// ZapChat - Zap Rooms API routes
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const FREE_SESSION_LIMIT = 2;

// ─── GET /rooms ── List all live rooms ───────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rooms')
      .select(`
        *,
        host:users!rooms_host_id_fkey(id, username, avatar_url, is_pro)
      `)
      .eq('is_live', true)
      .order('listener_count', { ascending: false });

    if (error) throw error;
    res.json({ rooms: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /rooms/:id ── Get single room ───────────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { data: room, error } = await supabase
      .from('rooms')
      .select(`
        *,
        host:users!rooms_host_id_fkey(id, username, avatar_url, is_pro),
        participants:room_participants(
          id, role, is_muted, hand_raised, joined_at,
          user:users(id, username, avatar_url)
        )
      `)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!room) return res.status(404).json({ error: 'Room not found' });

    // Check if requesting user is banned
    const { data: ban } = await supabase
      .from('room_bans')
      .select('*')
      .eq('room_id', req.params.id)
      .eq('user_id', req.user.id)
      .in('ban_type', ['permanent_ban', 'temp_ban'])
      .single();

    if (ban) {
      if (ban.ban_type === 'permanent_ban') {
        return res.status(403).json({ error: 'You are permanently banned from this room.' });
      }
      if (ban.ban_type === 'temp_ban' && ban.expires_at && new Date(ban.expires_at) > new Date()) {
        return res.status(403).json({ error: 'You are temporarily banned from this room.', expires_at: ban.expires_at });
      }
    }

    res.json({ room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /rooms ── Create a room ────────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, description, room_type, is_permanent, max_speakers, cover_image } = req.body;
    const userId = req.user.id;

    // Fetch user to check pro status and session count
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('is_pro, pro_expires_at, sessions_created')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    // Check pro expiry
    const isPro = user.is_pro && (!user.pro_expires_at || new Date(user.pro_expires_at) > new Date());

    // Enforce free tier limit
    if (!isPro && user.sessions_created >= FREE_SESSION_LIMIT) {
      return res.status(403).json({
        error: 'free_limit_reached',
        message: 'You have used your 2 free sessions. Upgrade to Zap Rooms Pro for $2.99/month.',
        sessions_used: user.sessions_created
      });
    }

    // Permanent rooms require Pro
    if (is_permanent && !isPro) {
      return res.status(403).json({
        error: 'pro_required',
        message: 'Permanent rooms require Zap Rooms Pro.'
      });
    }

    // Create the room
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .insert({
        name,
        description,
        host_id: userId,
        room_type: room_type || 'stage',
        is_permanent: isPro ? (is_permanent || false) : false,
        is_live: true,
        max_speakers: max_speakers || 4,
        max_listeners: isPro ? 500 : 200,
        cover_image
      })
      .select()
      .single();

    if (roomError) throw roomError;

    // Add host as organizer participant
    await supabase.from('room_participants').insert({
      room_id: room.id,
      user_id: userId,
      role: 'organizer',
      is_muted: false
    });

    // Increment session count for free users
    if (!isPro) {
      await supabase
        .from('users')
        .update({ sessions_created: user.sessions_created + 1 })
        .eq('id', userId);
    }

    res.status(201).json({ room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /rooms/:id/join ── Join a room ─────────────────────────────────────
router.post('/:id/join', authMiddleware, async (req, res) => {
  try {
    const { role = 'listener' } = req.body;
    const userId = req.user.id;
    const roomId = req.params.id;

    // Check ban
    const { data: ban } = await supabase
      .from('room_bans')
      .select('*')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .in('ban_type', ['permanent_ban', 'temp_ban'])
      .maybeSingle();

    if (ban) {
      if (ban.ban_type === 'permanent_ban') {
        return res.status(403).json({ error: 'You are permanently banned from this room.' });
      }
      if (ban.expires_at && new Date(ban.expires_at) > new Date()) {
        return res.status(403).json({ error: 'You are temporarily banned.', expires_at: ban.expires_at });
      }
    }

    // Check room capacity
    const { data: room } = await supabase
      .from('rooms')
      .select('max_listeners, listener_count, max_speakers, speaker_count, is_live')
      .eq('id', roomId)
      .single();

    if (!room || !room.is_live) {
      return res.status(404).json({ error: 'Room is not live.' });
    }

    if (role === 'listener' && room.listener_count >= room.max_listeners) {
      return res.status(403).json({ error: 'Room is full.' });
    }

    // Upsert participant
    const { data: participant, error } = await supabase
      .from('room_participants')
      .upsert({
        room_id: roomId,
        user_id: userId,
        role,
        is_muted: role === 'listener',
        left_at: null
      }, { onConflict: 'room_id,user_id' })
      .select()
      .single();

    if (error) throw error;

    // Update counts
    const countField = role === 'listener' ? 'listener_count' : 'speaker_count';
    await supabase.rpc('increment_room_count', { room_id: roomId, field: countField });

    res.json({ participant });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /rooms/:id/leave ── Leave a room ───────────────────────────────────
router.post('/:id/leave', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = req.params.id;

    const { data: participant } = await supabase
      .from('room_participants')
      .select('role')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .single();

    await supabase
      .from('room_participants')
      .update({ left_at: new Date().toISOString() })
      .eq('room_id', roomId)
      .eq('user_id', userId);

    if (participant) {
      const countField = participant.role === 'listener' ? 'listener_count' : 'speaker_count';
      await supabase.rpc('decrement_room_count', { room_id: roomId, field: countField });
    }

    // If organizer leaves, end the room (unless permanent)
    const { data: room } = await supabase.from('rooms').select('host_id, is_permanent').eq('id', roomId).single();
    if (room && room.host_id === userId && !room.is_permanent) {
      await supabase.from('rooms').update({ is_live: false, ended_at: new Date().toISOString() }).eq('id', roomId);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /rooms/:id/moderate ── Moderation actions ─────────────────────────
router.post('/:id/moderate', authMiddleware, async (req, res) => {
  try {
    const { action, target_user_id, duration_hours, reason } = req.body;
    const moderatorId = req.user.id;
    const roomId = req.params.id;

    // Verify moderator is organizer or cohost
    const { data: moderator } = await supabase
      .from('room_participants')
      .select('role')
      .eq('room_id', roomId)
      .eq('user_id', moderatorId)
      .single();

    if (!moderator || !['organizer', 'cohost'].includes(moderator.role)) {
      return res.status(403).json({ error: 'Not authorized to moderate this room.' });
    }

    switch (action) {

      case 'mute':
        await supabase.from('room_participants')
          .update({ is_muted: true })
          .eq('room_id', roomId).eq('user_id', target_user_id);
        break;

      case 'unmute':
        await supabase.from('room_participants')
          .update({ is_muted: false })
          .eq('room_id', roomId).eq('user_id', target_user_id);
        break;

      case 'invite_to_stage':
        await supabase.from('room_participants')
          .update({ role: 'speaker', is_muted: false })
          .eq('room_id', roomId).eq('user_id', target_user_id);
        break;

      case 'pull_from_stage':
        await supabase.from('room_participants')
          .update({ role: 'listener', is_muted: true })
          .eq('room_id', roomId).eq('user_id', target_user_id);
        break;

      case 'assign_cohost':
        await supabase.from('room_participants')
          .update({ role: 'cohost' })
          .eq('room_id', roomId).eq('user_id', target_user_id);
        break;

      case 'kick':
        await supabase.from('room_participants')
          .update({ left_at: new Date().toISOString() })
          .eq('room_id', roomId).eq('user_id', target_user_id);
        await supabase.from('room_bans').upsert({
          room_id: roomId, user_id: target_user_id,
          banned_by: moderatorId, ban_type: 'kick', reason,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30min cooldown
        }, { onConflict: 'room_id,user_id,ban_type' });
        break;

      case 'temp_ban':
        await supabase.from('room_participants')
          .update({ left_at: new Date().toISOString() })
          .eq('room_id', roomId).eq('user_id', target_user_id);
        await supabase.from('room_bans').upsert({
          room_id: roomId, user_id: target_user_id,
          banned_by: moderatorId, ban_type: 'temp_ban', reason,
          expires_at: new Date(Date.now() + (duration_hours || 24) * 3600 * 1000).toISOString()
        }, { onConflict: 'room_id,user_id,ban_type' });
        break;

      case 'permanent_ban':
        await supabase.from('room_participants')
          .update({ left_at: new Date().toISOString() })
          .eq('room_id', roomId).eq('user_id', target_user_id);
        await supabase.from('room_bans').upsert({
          room_id: roomId, user_id: target_user_id,
          banned_by: moderatorId, ban_type: 'permanent_ban', reason,
          expires_at: null
        }, { onConflict: 'room_id,user_id,ban_type' });
        break;

      case 'comment_ban_temp':
        await supabase.from('room_bans').upsert({
          room_id: roomId, user_id: target_user_id,
          banned_by: moderatorId, ban_type: 'comment_ban_temp', reason,
          expires_at: new Date(Date.now() + (duration_hours || 1) * 3600 * 1000).toISOString()
        }, { onConflict: 'room_id,user_id,ban_type' });
        break;

      case 'comment_ban_permanent':
        await supabase.from('room_bans').upsert({
          room_id: roomId, user_id: target_user_id,
          banned_by: moderatorId, ban_type: 'comment_ban_permanent', reason,
          expires_at: null
        }, { onConflict: 'room_id,user_id,ban_type' });
        break;

      default:
        return res.status(400).json({ error: 'Unknown moderation action.' });
    }

    res.json({ success: true, action, target_user_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /rooms/:id/comment ── Send a comment ───────────────────────────────
router.post('/:id/comment', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    const userId = req.user.id;
    const roomId = req.params.id;

    // Check comment ban
    const { data: ban } = await supabase
      .from('room_bans')
      .select('*')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .in('ban_type', ['comment_ban_temp', 'comment_ban_permanent'])
      .maybeSingle();

    if (ban) {
      if (ban.ban_type === 'comment_ban_permanent') {
        return res.status(403).json({ error: 'You are banned from commenting in this room.' });
      }
      if (ban.expires_at && new Date(ban.expires_at) > new Date()) {
        return res.status(403).json({ error: 'You are temporarily banned from commenting.', expires_at: ban.expires_at });
      }
    }

    const { data: comment, error } = await supabase
      .from('room_comments')
      .insert({ room_id: roomId, user_id: userId, message })
      .select(`*, user:users(id, username, avatar_url)`)
      .single();

    if (error) throw error;
    res.status(201).json({ comment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /rooms/:id ── End a room ─────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { data: room } = await supabase
      .from('rooms').select('host_id').eq('id', req.params.id).single();

    if (!room || room.host_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can end this room.' });
    }

    await supabase.from('rooms')
      .update({ is_live: false, ended_at: new Date().toISOString() })
      .eq('id', req.params.id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
