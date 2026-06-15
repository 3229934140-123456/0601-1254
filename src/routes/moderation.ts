import { Router, Request, Response } from 'express';
import { z } from 'zod';
import db from '../database';
import { success, error } from '../utils/response';
import { authMiddleware, teacherMiddleware } from '../middleware/auth';
import {
  muteUser,
  unmuteUser,
  isUserMuted,
  getMuteInfo,
  MuteInfo,
} from '../services/roomAccess';

const router = Router();

const muteSchema = z.object({
  user_id: z.string(),
  duration_minutes: z.number().min(1).max(1440).default(30),
  reason: z.string().max(200).optional(),
});

router.get('/:roomId/blocked-messages', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { page = '1', page_size = '50', handled } = req.query;

  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.min(200, Math.max(1, Number(page_size)));
  const offset = (pageNum - 1) * pageSize;

  let where = 'cm.room_id = ? AND cm.blocked = 1';
  const params: any[] = [roomId];

  if (handled === 'true') {
    where += ' AND cm.handled = 1';
  } else if (handled === 'false') {
    where += ' AND cm.handled = 0';
  }

  const totalRow = db.prepare(
    `SELECT COUNT(*) as count FROM chat_messages cm WHERE ${where}`
  ).get(...params) as { count: number };

  const rows = db.prepare(`
    SELECT 
      cm.id,
      cm.room_id,
      cm.user_id,
      cm.user_nickname,
      cm.content as masked_content,
      cm.original_content,
      cm.blocked_reason,
      cm.msg_type,
      cm.blocked,
      cm.handled,
      cm.handled_at,
      cm.handled_by,
      cm.created_at,
      u.username,
      u.nickname,
      u.avatar,
      hu.nickname as handled_by_nickname
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    LEFT JOIN users hu ON cm.handled_by = hu.id
    WHERE ${where}
    ORDER BY cm.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const list = Array.isArray(rows) ? rows : [];

  const unhandledCountRow = db.prepare(
    'SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND blocked = 1 AND handled = 0'
  ).get(roomId) as { count: number };

  success(res, {
    list,
    total: totalRow.count,
    page: pageNum,
    page_size: pageSize,
    empty: totalRow.count === 0,
    unhandled_count: unhandledCountRow.count,
  }, totalRow.count === 0 ? '暂无拦截消息' : 'success');
});

router.get('/:roomId/violation-users', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;

  const rows = db.prepare(`
    SELECT 
      u.id as user_id,
      u.username,
      u.nickname,
      u.avatar,
      COUNT(cm.id) as blocked_count,
      MAX(cm.created_at) as last_blocked_at
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    WHERE cm.room_id = ? AND cm.blocked = 1
    GROUP BY cm.user_id
    ORDER BY blocked_count DESC
  `).all(roomId);

  const list = Array.isArray(rows) ? rows : [];

  const mutedUsers = db.prepare(`
    SELECT m.user_id, m.mute_until, m.reason, m.created_at,
      u.username, u.nickname, u.avatar
    FROM mutes m
    LEFT JOIN users u ON m.user_id = u.id
    WHERE m.room_id = ? AND m.mute_until > ?
    ORDER BY m.mute_until DESC
  `).all(roomId, Date.now());

  success(res, {
    violation_users: list,
    muted_users: Array.isArray(mutedUsers) ? mutedUsers : [],
    total_violation_users: list.length,
    total_muted_users: Array.isArray(mutedUsers) ? mutedUsers.length : 0,
  });
});

router.post('/:roomId/mute', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId: operatorId, role } = (req as any).user;

  const parseResult = muteSchema.safeParse(req.body);
  if (!parseResult.success) {
    return error(res, parseResult.error.errors[0].message, 400);
  }
  const { user_id, duration_minutes, reason } = parseResult.data;

  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(roomId);
  if (!room) {
    return error(res, '直播间不存在', 404);
  }

  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!targetUser) {
    return error(res, '用户不存在', 404);
  }

  if ((targetUser as any).role === 'teacher' || (targetUser as any).role === 'admin') {
    if (role !== 'admin') {
      return error(res, '无权限禁言讲师或管理员', 403);
    }
  }

  const muteInfo = muteUser(
    roomId,
    user_id,
    duration_minutes,
    reason || '违规发言',
    operatorId
  );

  const io = (req as any).io;
  if (io) {
    io.to(roomId).emit('user_muted', {
      user_id,
      mute_until: muteInfo.mute_until,
      reason: muteInfo.reason,
      operator_id: operatorId,
    });
  }

  success(res, {
    mute_info: muteInfo,
    user: {
      id: user_id,
      username: (targetUser as any).username,
      nickname: (targetUser as any).nickname,
    },
  }, '禁言成功');
});

router.post('/:roomId/unmute', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { user_id } = req.body;
  const { userId: operatorId } = (req as any).user;

  if (!user_id) {
    return error(res, '请提供用户ID', 400);
  }

  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(roomId);
  if (!room) {
    return error(res, '直播间不存在', 404);
  }

  if (!isUserMuted(roomId, user_id)) {
    return success(res, { user_id, muted: false }, '用户当前未被禁言');
  }

  unmuteUser(roomId, user_id);

  const io = (req as any).io;
  if (io) {
    io.to(roomId).emit('user_unmuted', {
      user_id,
      operator_id: operatorId,
    });
  }

  success(res, { user_id, muted: false }, '解除禁言成功');
});

router.get('/:roomId/mute-status/:userId', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId, userId } = req.params;

  const muted = isUserMuted(roomId, userId);
  const muteInfo = getMuteInfo(roomId, userId);

  const user = db.prepare('SELECT id, username, nickname, avatar FROM users WHERE id = ?').get(userId);

  success(res, {
    user_id: userId,
    user,
    muted,
    mute_info: muteInfo,
  });
});

router.get('/:roomId/mute-records', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { page = '1', page_size = '50' } = req.query;

  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.min(200, Math.max(1, Number(page_size)));
  const offset = (pageNum - 1) * pageSize;

  const totalRow = db.prepare(
    'SELECT COUNT(*) as count FROM mutes WHERE room_id = ?'
  ).get(roomId) as { count: number };

  const rows = db.prepare(`
    SELECT m.*,
      u.username, u.nickname, u.avatar,
      ou.nickname as operator_nickname
    FROM mutes m
    LEFT JOIN users u ON m.user_id = u.id
    LEFT JOIN users ou ON m.created_by = ou.id
    WHERE m.room_id = ?
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `).all(roomId, pageSize, offset);

  const list = Array.isArray(rows) ? rows : [];

  success(res, {
    list,
    total: totalRow.count,
    page: pageNum,
    page_size: pageSize,
    empty: totalRow.count === 0,
  });
});

router.post('/:roomId/blocked-messages/:msgId/handle', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId, msgId } = req.params;
  const { userId: operatorId } = (req as any).user;
  const { action = 'mark_handled' } = req.body;

  const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND room_id = ? AND blocked = 1')
    .get(msgId, roomId);
  if (!msg) {
    return error(res, '拦截消息不存在', 404);
  }

  const now = Date.now();
  db.prepare('UPDATE chat_messages SET handled = 1, handled_at = ?, handled_by = ? WHERE id = ?')
    .run(now, operatorId, msgId);

  const updated = db.prepare(`
    SELECT cm.*, u.username, u.nickname, u.avatar,
      hu.nickname as handled_by_nickname
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    LEFT JOIN users hu ON cm.handled_by = hu.id
    WHERE cm.id = ?
  `).get(msgId);

  success(res, { message: updated, action }, '处理成功');
});

router.post('/:roomId/blocked-messages/:msgId/mute', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId, msgId } = req.params;
  const { userId: operatorId, role } = (req as any).user;
  const { duration_minutes = 30, reason } = req.body;

  const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND room_id = ? AND blocked = 1')
    .get(msgId, roomId);
  if (!msg) {
    return error(res, '拦截消息不存在', 404);
  }

  const msgData = msg as any;
  const userId = msgData.user_id;

  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!targetUser) {
    return error(res, '用户不存在', 404);
  }

  if ((targetUser as any).role === 'teacher' || (targetUser as any).role === 'admin') {
    if (role !== 'admin') {
      return error(res, '无权限禁言讲师或管理员', 403);
    }
  }

  const safeDuration = Math.min(1440, Math.max(1, Number(duration_minutes) || 30));
  const muteInfo = muteUser(
    roomId,
    userId,
    safeDuration,
    reason || msgData.blocked_reason || '违规发言',
    operatorId
  );

  const now = Date.now();
  db.prepare('UPDATE chat_messages SET handled = 1, handled_at = ?, handled_by = ? WHERE id = ?')
    .run(now, operatorId, msgId);

  const io = (req as any).io;
  if (io) {
    io.to(roomId).emit('user_muted', {
      user_id: userId,
      mute_until: muteInfo.mute_until,
      reason: muteInfo.reason,
      operator_id: operatorId,
    });
  }

  success(res, {
    mute_info: muteInfo,
    message_handled: true,
    user: {
      id: userId,
      username: (targetUser as any).username,
      nickname: (targetUser as any).nickname,
    },
  }, '禁言成功，消息已标记处理');
});

router.post('/:roomId/blocked-messages/batch-handle', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId: operatorId } = (req as any).user;
  const { message_ids } = req.body;

  if (!Array.isArray(message_ids) || message_ids.length === 0) {
    return error(res, '请提供消息ID列表', 400);
  }

  const now = Date.now();
  const placeholders = message_ids.map(() => '?').join(',');
  db.prepare(`UPDATE chat_messages SET handled = 1, handled_at = ?, handled_by = ? 
    WHERE room_id = ? AND blocked = 1 AND id IN (${placeholders})`)
    .run(now, operatorId, roomId, ...message_ids);

  success(res, { handled_count: message_ids.length }, '批量处理成功');
});

export default router;
