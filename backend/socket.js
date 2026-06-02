// socket.js
// ZapChat - Socket.io signaling server for Zap Rooms WebRTC + real-time events
// Add this to your server.js: require('./socket')(server)

const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = (server) => {
  const io = require('socket.io')(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'https://zap-chat-frontend-phi.vercel.app',
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Auth middleware for socket
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) return next(new Error('No token'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      socket.username = decoded.username;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`[Rooms] User connected: ${socket.userId}`);

    // ── JOIN ROOM ──────────────────────────────────────────────────────────
    socket.on('room:join', async ({ roomId, role }) => {
      socket.join(`room:${roomId}`);
      socket.currentRoom = roomId;

      // Notify others
      socket.to(`room:${roomId}`).emit('room:user_joined', {
        userId: socket.userId,
        username: socket.username,
        role
      });

      // Send current participants to new joiner
      const { data: participants } = await supabase
        .from('room_participants')
        .select('*, user:users(id, username, avatar_url)')
        .eq('room_id', roomId)
        .is('left_at', null);

      socket.emit('room:participants', { participants });
    });

    // ── WEBRTC SIGNALING ───────────────────────────────────────────────────
    // SDP Offer (caller → callee)
    socket.on('rtc:offer', ({ roomId, targetUserId, offer }) => {
      io.to(`user:${targetUserId}`).emit('rtc:offer', {
        fromUserId: socket.userId,
        offer
      });
    });

    // SDP Answer (callee → caller)
    socket.on('rtc:answer', ({ roomId, targetUserId, answer }) => {
      io.to(`user:${targetUserId}`).emit('rtc:answer', {
        fromUserId: socket.userId,
        answer
      });
    });

    // ICE Candidates
    socket.on('rtc:ice_candidate', ({ roomId, targetUserId, candidate }) => {
      io.to(`user:${targetUserId}`).emit('rtc:ice_candidate', {
        fromUserId: socket.userId,
        candidate
      });
    });

    // ── MODERATION REAL-TIME EVENTS ────────────────────────────────────────
    socket.on('mod:mute', ({ roomId, targetUserId }) => {
      io.to(`user:${targetUserId}`).emit('room:muted', { by: socket.userId });
      io.to(`room:${roomId}`).emit('room:participant_updated', {
        userId: targetUserId, is_muted: true
      });
    });

    socket.on('mod:unmute', ({ roomId, targetUserId }) => {
      io.to(`user:${targetUserId}`).emit('room:unmuted', { by: socket.userId });
      io.to(`room:${roomId}`).emit('room:participant_updated', {
        userId: targetUserId, is_muted: false
      });
    });

    socket.on('mod:invite_stage', ({ roomId, targetUserId }) => {
      io.to(`user:${targetUserId}`).emit('room:invited_to_stage', {
        roomId, by: socket.userId
      });
      io.to(`room:${roomId}`).emit('room:participant_updated', {
        userId: targetUserId, role: 'speaker'
      });
    });

    socket.on('mod:pull_stage', ({ roomId, targetUserId }) => {
      io.to(`user:${targetUserId}`).emit('room:pulled_from_stage', { roomId });
      io.to(`room:${roomId}`).emit('room:participant_updated', {
        userId: targetUserId, role: 'listener'
      });
    });

    socket.on('mod:kick', ({ roomId, targetUserId }) => {
      io.to(`user:${targetUserId}`).emit('room:kicked', { roomId });
      io.to(`room:${roomId}`).emit('room:user_removed', { userId: targetUserId, reason: 'kicked' });
    });

    socket.on('mod:ban', ({ roomId, targetUserId, ban_type }) => {
      io.to(`user:${targetUserId}`).emit('room:banned', { roomId, ban_type });
      io.to(`room:${roomId}`).emit('room:user_removed', { userId: targetUserId, reason: 'banned' });
    });

    socket.on('mod:end_room', ({ roomId }) => {
      io.to(`room:${roomId}`).emit('room:ended', { by: socket.userId });
    });

    // ── LISTENER ACTIONS ───────────────────────────────────────────────────
    socket.on('listener:raise_hand', ({ roomId }) => {
      socket.to(`room:${roomId}`).emit('room:hand_raised', {
        userId: socket.userId,
        username: socket.username
      });
    });

    socket.on('listener:lower_hand', ({ roomId }) => {
      socket.to(`room:${roomId}`).emit('room:hand_lowered', {
        userId: socket.userId
      });
    });

    socket.on('listener:react', ({ roomId, emoji }) => {
      io.to(`room:${roomId}`).emit('room:reaction', {
        userId: socket.userId,
        username: socket.username,
        emoji
      });
    });

    // ── COMMENTS (live chat) ───────────────────────────────────────────────
    socket.on('room:comment', ({ roomId, message }) => {
      io.to(`room:${roomId}`).emit('room:new_comment', {
        userId: socket.userId,
        username: socket.username,
        message,
        created_at: new Date().toISOString()
      });
    });

    // ── PERSONAL ROOM (for direct targeting) ──────────────────────────────
    socket.on('register', () => {
      socket.join(`user:${socket.userId}`);
    });

    // ── DISCONNECT ─────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      if (socket.currentRoom) {
        socket.to(`room:${socket.currentRoom}`).emit('room:user_left', {
          userId: socket.userId
        });

        // Update DB
        await supabase
          .from('room_participants')
          .update({ left_at: new Date().toISOString() })
          .eq('room_id', socket.currentRoom)
          .eq('user_id', socket.userId);
      }
      console.log(`[Rooms] User disconnected: ${socket.userId}`);
    });
  });

  return io;
};
