import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import db from './database';
import { verifyToken } from './utils/jwt';
import { containsBannedWord, maskContent } from './utils/contentFilter';
import {
  checkRoomAccess,
  addOnlineUser,
  removeOnlineUser,
  getOnlineCount,
  isUserMuted,
  getMuteInfo,
} from './services/roomAccess';

const roomSockets: Map<string, Set<string>> = new Map();
const socketRooms: Map<string, Set<string>> = new Map();

function hasJoinedRoom(socketId: string, roomId: string): boolean {
  return socketRooms.get(socketId)?.has(roomId) || false;
}

function markJoinedRoom(socketId: string, roomId: string): void {
  if (!socketRooms.has(socketId)) {
    socketRooms.set(socketId, new Set());
  }
  socketRooms.get(socketId)!.add(roomId);
}

function markLeftRoom(socketId: string, roomId: string): void {
  if (socketRooms.has(socketId)) {
    socketRooms.get(socketId)!.delete(roomId);
  }
}

function clearSocketRooms(socketId: string): void {
  const rooms = socketRooms.get(socketId);
  if (rooms) {
    for (const roomId of rooms) {
      if (roomSockets.has(roomId)) {
        roomSockets.get(roomId)!.delete(socketId);
      }
    }
  }
  socketRooms.delete(socketId);
}

function verifyRoomAccess(
  socket: Socket,
  roomId: string,
  user: any
): { allowed: boolean; reason?: string; code?: number } {
  if (!hasJoinedRoom(socket.id, roomId)) {
    return { allowed: false, reason: '您尚未进入直播间，请先进入后再操作', code: 403 };
  }
  const result = checkRoomAccess(roomId, user.userId, user.role);
  if (!result.allowed) {
    return { allowed: false, reason: result.reason, code: result.code };
  }
  return { allowed: true };
}

export function setupSocketIO(io: Server) {
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (!token) {
      return next(new Error('未授权'));
    }
    const payload = verifyToken(token as string);
    if (!payload) {
      return next(new Error('Token无效'));
    }
    (socket as any).user = payload;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).user;
    console.log(`用户连接: ${user.userId}`);

    socket.on('join_room', async ({ roomId, watchToken }: { roomId: string; watchToken?: string }) => {
      const accessResult = checkRoomAccess(roomId, user.userId, user.role, watchToken);
      if (!accessResult.allowed) {
        socket.emit('join_denied', {
          message: accessResult.reason || '无法进入直播间',
          code: accessResult.code || 400,
        });
        return;
      }

      socket.join(roomId);
      markJoinedRoom(socket.id, roomId);

      if (!roomSockets.has(roomId)) {
        roomSockets.set(roomId, new Set());
      }
      roomSockets.get(roomId)!.add(socket.id);

      const onlineCount = addOnlineUser(roomId, user.userId);

      io.to(roomId).emit('user_joined', {
        user_id: user.userId,
        username: user.username,
        online_count: onlineCount,
      });

      const dbUser = db.prepare('SELECT nickname, avatar FROM users WHERE id = ?').get(user.userId) as { nickname?: string };
      const now = Date.now();
      const existingSession = db.prepare(
        'SELECT * FROM watch_sessions WHERE room_id = ? AND user_id = ? AND leave_time IS NULL ORDER BY join_time DESC LIMIT 1'
      ).get(roomId, user.userId);

      if (!existingSession) {
        db.prepare('INSERT INTO watch_sessions (id, room_id, user_id, join_time, duration) VALUES (?, ?, ?, ?, 0)')
          .run(uuidv4(), roomId, user.userId, now);
      }

      const muted = isUserMuted(roomId, user.userId);
      const muteInfo = getMuteInfo(roomId, user.userId);

      socket.emit('joined_room', {
        roomId,
        online_count: onlineCount,
        muted,
        mute_info: muteInfo,
        room: accessResult.room,
      });
    });

    socket.on('send_message', async ({ roomId, content, msg_type = 'text', is_question = false }: {
      roomId: string;
      content: string;
      msg_type?: 'text' | 'emoji';
      is_question?: boolean;
    }) => {
      const access = verifyRoomAccess(socket, roomId, user);
      if (!access.allowed) {
        socket.emit('action_denied', {
          action: 'send_message',
          message: access.reason || '无权操作',
          code: access.code || 403,
        });
        return;
      }

      if (!content || content.length > 500) {
        socket.emit('error', { message: '消息内容无效' });
        return;
      }

      if (user.role !== 'teacher' && user.role !== 'admin') {
        const muted = isUserMuted(roomId, user.userId);
        if (muted) {
          const muteInfo = getMuteInfo(roomId, user.userId);
          socket.emit('muted', {
            message: '您已被禁言，无法发送消息',
            mute_until: muteInfo?.mute_until,
            reason: muteInfo?.reason,
          });
          return;
        }
      }

      const banned = containsBannedWord(content);
      const now = Date.now();
      const id = uuidv4();
      const dbUser = db.prepare('SELECT nickname FROM users WHERE id = ?').get(user.userId) as { nickname?: string };

      db.prepare(`INSERT INTO chat_messages 
        (id, room_id, user_id, user_nickname, content, original_content, blocked_reason, msg_type, is_pinned, is_question, blocked, handled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?)`)
        .run(
          id,
          roomId,
          user.userId,
          dbUser?.nickname || '匿名用户',
          banned ? maskContent(content) : content,
          banned ? content : null,
          banned || null,
          msg_type,
          is_question ? 1 : 0,
          banned ? 1 : 0,
          now
        );

      const message = db.prepare(`
        SELECT cm.*, u.username, u.avatar, u.role as user_role
        FROM chat_messages cm
        LEFT JOIN users u ON cm.user_id = u.id
        WHERE cm.id = ?
      `).get(id);

      io.to(roomId).emit('new_message', {
        message,
        blocked: !!banned,
      });

      if (banned) {
        socket.emit('message_blocked', {
          message_id: id,
          blocked_word: banned,
        });
      }
    });

    socket.on('pin_message', async ({ roomId, messageId }: { roomId: string; messageId: string }) => {
      const access = verifyRoomAccess(socket, roomId, user);
      if (!access.allowed) {
        socket.emit('action_denied', {
          action: 'pin_message',
          message: access.reason || '无权操作',
          code: access.code || 403,
        });
        return;
      }

      if (user.role !== 'teacher' && user.role !== 'admin') {
        socket.emit('error', { message: '无权限' });
        return;
      }

      const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND room_id = ?').get(messageId, roomId);
      if (!msg) {
        socket.emit('error', { message: '消息不存在' });
        return;
      }

      db.prepare('UPDATE chat_messages SET is_pinned = 1 WHERE id = ?').run(messageId);
      const updated = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId);

      io.to(roomId).emit('message_pinned', { message: updated });
    });

    socket.on('answer_question', async ({ roomId, messageId, answer }: { roomId: string; messageId: string; answer: string }) => {
      const access = verifyRoomAccess(socket, roomId, user);
      if (!access.allowed) {
        socket.emit('action_denied', {
          action: 'answer_question',
          message: access.reason || '无权操作',
          code: access.code || 403,
        });
        return;
      }

      if (user.role !== 'teacher' && user.role !== 'admin') {
        socket.emit('error', { message: '无权限' });
        return;
      }

      if (!answer || answer.length > 2000) {
        socket.emit('error', { message: '回答内容无效' });
        return;
      }

      const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND room_id = ?').get(messageId, roomId);
      if (!msg) {
        socket.emit('error', { message: '问题不存在' });
        return;
      }

      const banned = containsBannedWord(answer);
      const now = Date.now();
      db.prepare('UPDATE chat_messages SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?')
        .run(banned ? maskContent(answer) : answer, user.userId, now, messageId);

      const updated = db.prepare(`
        SELECT cm.*, u.username, u.avatar, u.role as user_role
        FROM chat_messages cm
        LEFT JOIN users u ON cm.user_id = u.id
        WHERE cm.id = ?
      `).get(messageId);

      io.to(roomId).emit('question_answered', { message: updated });
    });

    socket.on('like', async ({ roomId, count = 1 }: { roomId: string; count?: number }) => {
      const access = verifyRoomAccess(socket, roomId, user);
      if (!access.allowed) {
        socket.emit('action_denied', {
          action: 'like',
          message: access.reason || '无权操作',
          code: access.code || 403,
        });
        return;
      }

      const safeCount = Math.min(100, Math.max(1, count));
      const id = uuidv4();
      const now = Date.now();

      db.prepare('INSERT INTO likes (id, room_id, user_id, count, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, roomId, user.userId, safeCount, now);

      const totalRow = db.prepare('SELECT SUM(count) as total FROM likes WHERE room_id = ?').get(roomId) as { total: number };

      io.to(roomId).emit('like_received', {
        user_id: user.userId,
        username: user.username,
        count: safeCount,
        total_likes: totalRow.total || 0,
      });
    });

    socket.on('reward', async ({ roomId, gift_type, amount, message }: {
      roomId: string;
      gift_type: string;
      amount: number;
      message?: string;
    }) => {
      const access = verifyRoomAccess(socket, roomId, user);
      if (!access.allowed) {
        socket.emit('action_denied', {
          action: 'reward',
          message: access.reason || '无权操作',
          code: access.code || 403,
        });
        return;
      }

      if (!gift_type || !amount || amount <= 0) {
        socket.emit('error', { message: '打赏参数无效' });
        return;
      }

      const dbUser = db.prepare('SELECT nickname FROM users WHERE id = ?').get(user.userId) as { nickname?: string };
      const id = uuidv4();
      const now = Date.now();

      db.prepare(`INSERT INTO rewards 
        (id, room_id, user_id, user_nickname, gift_type, amount, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, roomId, user.userId, dbUser?.nickname || '匿名用户', gift_type, amount, message || '', now);

      const reward = db.prepare(`
        SELECT r.*, u.username, u.avatar
        FROM rewards r
        LEFT JOIN users u ON r.user_id = u.id
        WHERE r.id = ?
      `).get(id);

      io.to(roomId).emit('reward_received', { reward });
    });

    socket.on('heartbeat', ({ roomId }: { roomId: string }) => {
      const onlineCount = addOnlineUser(roomId, user.userId);
      socket.emit('heartbeat_ack', {
        online_count: onlineCount,
        timestamp: Date.now(),
      });
    });

    socket.on('leave_room', ({ roomId }: { roomId: string }) => {
      socket.leave(roomId);
      markLeftRoom(socket.id, roomId);

      if (roomSockets.has(roomId)) {
        roomSockets.get(roomId)!.delete(socket.id);
      }

      const now = Date.now();
      const session = db.prepare(
        'SELECT * FROM watch_sessions WHERE room_id = ? AND user_id = ? AND leave_time IS NULL ORDER BY join_time DESC LIMIT 1'
      ).get(roomId, user.userId) as any;

      if (session) {
        const duration = Math.floor((now - session.join_time) / 1000);
        db.prepare('UPDATE watch_sessions SET leave_time = ?, duration = ? WHERE id = ?')
          .run(now, duration, session.id);
      }

      let hasOtherSockets = false;
      if (roomSockets.has(roomId)) {
        for (const sid of roomSockets.get(roomId)!) {
          const s = io.sockets.sockets.get(sid);
          if (s && (s as any).user?.userId === user.userId) {
            hasOtherSockets = true;
            break;
          }
        }
      }

      if (!hasOtherSockets) {
        removeOnlineUser(roomId, user.userId);
      }

      io.to(roomId).emit('user_left', {
        user_id: user.userId,
        username: user.username,
        online_count: getOnlineCount(roomId),
      });
    });

    socket.on('disconnect', () => {
      const joinedRoomIds = new Set(socketRooms.get(socket.id) || []);
      clearSocketRooms(socket.id);

      for (const roomId of joinedRoomIds) {
        let hasOtherSockets = false;
        const socketsInRoom = roomSockets.get(roomId);
        if (socketsInRoom) {
          for (const sid of socketsInRoom) {
            if (sid === socket.id) continue;
            const s = io.sockets.sockets.get(sid);
            if (s && (s as any).user?.userId === user.userId) {
              hasOtherSockets = true;
              break;
            }
          }
        }

        if (!hasOtherSockets) {
          removeOnlineUser(roomId, user.userId);
        }

        const now = Date.now();
        const session = db.prepare(
          'SELECT * FROM watch_sessions WHERE room_id = ? AND user_id = ? AND leave_time IS NULL ORDER BY join_time DESC LIMIT 1'
        ).get(roomId, user.userId) as any;

        if (session) {
          const duration = Math.floor((now - session.join_time) / 1000);
          db.prepare('UPDATE watch_sessions SET leave_time = ?, duration = ? WHERE id = ?')
            .run(now, duration, session.id);
        }

        io.to(roomId).emit('user_left', {
          user_id: user.userId,
          username: user.username,
          online_count: getOnlineCount(roomId),
        });
      }
    });
  });
}
