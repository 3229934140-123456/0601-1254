import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import db from '../database';
import { success, error } from '../utils/response';
import { authMiddleware } from '../middleware/auth';
import { LiveRoom, WatchSession } from '../types';
import {
  checkRoomAccess,
  addOnlineUser,
  removeOnlineUser,
  getOnlineCount,
  onlineUsersCache,
  isUserMuted,
} from '../services/roomAccess';

const router = Router();

router.post('/:roomId/enter', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId, role } = (req as any).user;
  const { watch_token } = req.body;

  const accessResult = checkRoomAccess(roomId, userId, role, watch_token);
  if (!accessResult.allowed) {
    return error(res, accessResult.reason || '无法进入直播间', accessResult.code || 400);
  }

  const now = Date.now();
  const existingSession = db.prepare(
    'SELECT * FROM watch_sessions WHERE room_id = ? AND user_id = ? AND leave_time IS NULL ORDER BY join_time DESC LIMIT 1'
  ).get(roomId, userId) as WatchSession | undefined;

  let sessionId: string;
  if (existingSession) {
    sessionId = existingSession.id;
  } else {
    sessionId = uuidv4();
    db.prepare('INSERT INTO watch_sessions (id, room_id, user_id, join_time, duration) VALUES (?, ?, ?, ?, 0)')
      .run(sessionId, roomId, userId, now);
  }

  const onlineCount = addOnlineUser(roomId, userId);

  const muted = isUserMuted(roomId, userId);

  success(res, {
    session_id: sessionId,
    room_id: roomId,
    online_count: onlineCount,
    muted,
  }, '进入直播间成功');
});

router.post('/:roomId/leave', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId } = (req as any).user;
  const { session_id } = req.body;

  const now = Date.now();

  const session = db.prepare('SELECT * FROM watch_sessions WHERE id = ? AND user_id = ?').get(session_id, userId) as WatchSession | undefined;
  if (session && !session.leave_time) {
    const duration = Math.floor((now - session.join_time) / 1000);
    db.prepare('UPDATE watch_sessions SET leave_time = ?, duration = ? WHERE id = ?')
      .run(now, duration, session_id);
  }

  const onlineCount = removeOnlineUser(roomId, userId);

  success(res, { duration: session ? Math.floor((now - session.join_time) / 1000) : 0, online_count: onlineCount }, '已离开直播间');
});

router.post('/:roomId/heartbeat', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId } = (req as any).user;

  const onlineCount = addOnlineUser(roomId, userId);

  success(res, {
    online_count: onlineCount,
    timestamp: Date.now(),
  });
});

router.get('/:roomId/online', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const count = getOnlineCount(roomId);
  success(res, {
    room_id: roomId,
    online_count: count,
  });
});

router.post('/:roomId/enroll', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId } = (req as any).user;

  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(roomId) as LiveRoom | undefined;
  if (!room) {
    return error(res, '直播间不存在', 404);
  }

  const existing = db.prepare('SELECT id FROM room_enrollments WHERE room_id = ? AND user_id = ?').get(roomId, userId);
  if (existing) {
    return success(res, { enrolled: true }, '已报名');
  }

  const id = uuidv4();
  db.prepare('INSERT INTO room_enrollments (id, room_id, user_id, enrolled_at) VALUES (?, ?, ?, ?)')
    .run(id, roomId, userId, Date.now());

  success(res, { enrolled: true, enrollment_id: id }, '报名成功');
});

router.get('/:roomId/enrollments', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const rows = db.prepare(`
    SELECT re.id, re.enrolled_at, u.id as user_id, u.username, u.nickname, u.avatar
    FROM room_enrollments re
    LEFT JOIN users u ON re.user_id = u.id
    WHERE re.room_id = ?
    ORDER BY re.enrolled_at DESC
  `).all(roomId);
  success(res, { list: rows, total: rows.length });
});

router.get('/:roomId/watch-duration', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId, role } = (req as any).user;
  const targetUserId = req.query.user_id as string || userId;

  if (role === 'viewer' && targetUserId !== userId) {
    return error(res, '无权限查看他人数据', 403);
  }

  const sessions = db.prepare('SELECT * FROM watch_sessions WHERE room_id = ? AND user_id = ?').all(roomId, targetUserId) as WatchSession[];
  const totalDuration = sessions.reduce((sum, s) => {
    if (s.leave_time) {
      return sum + s.duration;
    }
    return sum + Math.floor((Date.now() - s.join_time) / 1000);
  }, 0);

  success(res, {
    user_id: targetUserId,
    room_id: roomId,
    total_duration_seconds: totalDuration,
    total_duration_formatted: formatDuration(totalDuration),
    sessions: sessions.map(s => ({
      id: s.id,
      join_time: s.join_time,
      leave_time: s.leave_time,
      duration: s.leave_time ? s.duration : Math.floor((Date.now() - s.join_time) / 1000),
    })),
  });
});

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}小时`);
  if (m > 0) parts.push(`${m}分`);
  parts.push(`${s}秒`);
  return parts.join('');
}

export default router;
export { onlineUsersCache as onlineUsers };
