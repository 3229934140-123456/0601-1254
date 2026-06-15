import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import db from '../database';
import { success, error } from '../utils/response';
import { authMiddleware, teacherMiddleware } from '../middleware/auth';
import {
  muteUser,
  unmuteUser,
  isUserMuted,
  getMuteInfo,
} from '../services/roomAccess';

const router = Router();

const VALID_REVIEW_STATUSES = ['pending', 'handled', 'pending_review', 'appealing', 'rejected'];

const muteSchema = z.object({
  user_id: z.string(),
  duration_minutes: z.number().min(1).max(1440).default(30),
  reason: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});

function writeModLog(params: {
  roomId: string;
  action: string;
  targetType: string;
  targetId: string;
  operatorId: string;
  note?: string;
  extra?: Record<string, any>;
}) {
  const id = uuidv4();
  const now = Date.now();
  db.prepare(`INSERT INTO moderation_logs (id, room_id, action, target_type, target_id, operator_id, note, extra, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, params.roomId, params.action, params.targetType, params.targetId,
      params.operatorId, params.note || null, params.extra ? JSON.stringify(params.extra) : null, now);
}

router.get('/:roomId/blocked-messages', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { page = '1', page_size = '50', review_status } = req.query;

  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.min(200, Math.max(1, Number(page_size)));
  const offset = (pageNum - 1) * pageSize;

  let where = 'cm.room_id = ? AND cm.blocked = 1';
  const params: any[] = [roomId];

  if (review_status && VALID_REVIEW_STATUSES.includes(review_status as string)) {
    where += ' AND cm.review_status = ?';
    params.push(review_status);
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
      cm.review_status,
      cm.review_conclusion,
      cm.current_handler,
      cm.reviewed_at,
      cm.reviewed_by,
      cm.created_at,
      u.username,
      u.nickname,
      u.avatar,
      hu.nickname as handled_by_nickname,
      rv.nickname as reviewed_by_nickname,
      ch.nickname as current_handler_nickname
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    LEFT JOIN users hu ON cm.handled_by = hu.id
    LEFT JOIN users rv ON cm.reviewed_by = rv.id
    LEFT JOIN users ch ON cm.current_handler = ch.id
    WHERE ${where}
    ORDER BY cm.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const list = Array.isArray(rows) ? rows : [];

  const statusCounts = db.prepare(`
    SELECT review_status, COUNT(*) as count FROM chat_messages
    WHERE room_id = ? AND blocked = 1
    GROUP BY review_status
  `).all(roomId) as any[];

  const countsByStatus: Record<string, number> = {};
  for (const sc of statusCounts) {
    countsByStatus[sc.review_status || 'pending'] = sc.count;
  }

  success(res, {
    list,
    total: totalRow.count,
    page: pageNum,
    page_size: pageSize,
    empty: totalRow.count === 0,
    status_counts: countsByStatus,
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
  const { user_id, duration_minutes, reason, note } = parseResult.data;

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

  writeModLog({
    roomId,
    action: 'mute',
    targetType: 'user',
    targetId: user_id,
    operatorId,
    note: note || reason,
    extra: { duration_minutes, mute_until: muteInfo.mute_until },
  });

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
  const { user_id, note } = req.body;
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

  writeModLog({
    roomId,
    action: 'unmute',
    targetType: 'user',
    targetId: user_id,
    operatorId,
    note: note || '解除禁言',
  });

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

function updateReviewStatus(msgId: string, status: string, operatorId: string, conclusion?: string) {
  const now = Date.now();
  const updates: string[] = ['review_status = ?'];
  const params: any[] = [status];

  if (status === 'handled') {
    updates.push('handled = 1', 'handled_at = ?', 'handled_by = ?');
    params.push(now, operatorId);
  }

  if (status === 'pending_review') {
    updates.push('current_handler = ?');
    params.push(operatorId);
  }

  if (conclusion) {
    updates.push('review_conclusion = ?');
    params.push(conclusion);
  }

  if (status === 'handled' || status === 'rejected') {
    updates.push('reviewed_at = ?', 'reviewed_by = ?');
    params.push(now, operatorId);
  }

  params.push(msgId);
  db.prepare(`UPDATE chat_messages SET ${updates.join(', ')} WHERE id = ?`)
    .run(...params);
}

router.post('/:roomId/blocked-messages/:msgId/review', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId, msgId } = req.params;
  const { userId: operatorId } = (req as any).user;
  const { action, conclusion, note } = req.body;

  const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND room_id = ? AND blocked = 1')
    .get(msgId, roomId);
  if (!msg) {
    return error(res, '拦截消息不存在', 404);
  }

  const msgData = msg as any;
  const validActions: Record<string, string> = {
    handle: 'handled',
    pending_review: 'pending_review',
    appeal: 'appealing',
    reject: 'rejected',
    reopen: 'pending',
  };

  const targetStatus = validActions[action];
  if (!targetStatus) {
    return error(res, `无效操作: ${action}，支持: ${Object.keys(validActions).join(', ')}`, 400);
  }

  updateReviewStatus(msgId, targetStatus, operatorId, conclusion);

  writeModLog({
    roomId,
    action: `review_${action}`,
    targetType: 'message',
    targetId: msgId,
    operatorId,
    note: note || conclusion || `状态变更为: ${targetStatus}`,
    extra: {
      from_status: msgData.review_status,
      to_status: targetStatus,
      conclusion,
    },
  });

  const updated = db.prepare(`
    SELECT cm.*,
      u.username, u.nickname, u.avatar,
      hu.nickname as handled_by_nickname,
      rv.nickname as reviewed_by_nickname,
      ch.nickname as current_handler_nickname
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    LEFT JOIN users hu ON cm.handled_by = hu.id
    LEFT JOIN users rv ON cm.reviewed_by = hu.id
    LEFT JOIN users ch ON cm.current_handler = ch.id
    WHERE cm.id = ?
  `).get(msgId);

  success(res, { message: updated, action, target_status: targetStatus }, '操作成功');
});

router.post('/:roomId/blocked-messages/:msgId/handle', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId, msgId } = req.params;
  const { userId: operatorId } = (req as any).user;
  const { note } = req.body;

  const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND room_id = ? AND blocked = 1')
    .get(msgId, roomId);
  if (!msg) {
    return error(res, '拦截消息不存在', 404);
  }

  updateReviewStatus(msgId, 'handled', operatorId);

  writeModLog({
    roomId,
    action: 'handle_message',
    targetType: 'message',
    targetId: msgId,
    operatorId,
    note: note || '标记已处理',
  });

  const updated = db.prepare(`
    SELECT cm.*, u.username, u.nickname, u.avatar,
      hu.nickname as handled_by_nickname,
      rv.nickname as reviewed_by_nickname,
      ch.nickname as current_handler_nickname
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    LEFT JOIN users hu ON cm.handled_by = hu.id
    LEFT JOIN users rv ON cm.reviewed_by = rv.id
    LEFT JOIN users ch ON cm.current_handler = ch.id
    WHERE cm.id = ?
  `).get(msgId);

  success(res, { message: updated, action: 'handle' }, '处理成功');
});

router.post('/:roomId/blocked-messages/:msgId/mute', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId, msgId } = req.params;
  const { userId: operatorId, role } = (req as any).user;
  const { duration_minutes = 30, reason, note } = req.body;

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

  updateReviewStatus(msgId, 'handled', operatorId, '禁言处理');

  writeModLog({
    roomId,
    action: 'mute_via_message',
    targetType: 'message',
    targetId: msgId,
    operatorId,
    note: note || `根据拦截消息禁言用户 ${userId}`,
    extra: { muted_user: userId, duration_minutes: safeDuration, mute_until: muteInfo.mute_until },
  });

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
  const { message_ids, note, action = 'handle' } = req.body;

  if (!Array.isArray(message_ids) || message_ids.length === 0) {
    return error(res, '请提供消息ID列表', 400);
  }

  const targetStatus = action === 'reject' ? 'rejected' : 'handled';
  const now = Date.now();
  const placeholders = message_ids.map(() => '?').join(',');

  if (targetStatus === 'handled') {
    db.prepare(`UPDATE chat_messages SET review_status = ?, handled = 1, handled_at = ?, handled_by = ?, reviewed_at = ?, reviewed_by = ?
      WHERE room_id = ? AND blocked = 1 AND id IN (${placeholders})`)
      .run(targetStatus, now, operatorId, now, operatorId, roomId, ...message_ids);
  } else {
    db.prepare(`UPDATE chat_messages SET review_status = ?, reviewed_at = ?, reviewed_by = ?
      WHERE room_id = ? AND blocked = 1 AND id IN (${placeholders})`)
      .run(targetStatus, now, operatorId, roomId, ...message_ids);
  }

  writeModLog({
    roomId,
    action: `batch_${action}`,
    targetType: 'message_batch',
    targetId: message_ids.join(','),
    operatorId,
    note: note || `批量${action === 'reject' ? '驳回' : '处理'} ${message_ids.length} 条消息`,
    extra: { count: message_ids.length, target_status: targetStatus },
  });

  success(res, { handled_count: message_ids.length, target_status: targetStatus }, '批量处理成功');
});

router.get('/:roomId/logs', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { page = '1', page_size = '50', action, target_type } = req.query;

  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.min(200, Math.max(1, Number(page_size)));
  const offset = (pageNum - 1) * pageSize;

  let where = 'ml.room_id = ?';
  const params: any[] = [roomId];

  if (action) {
    where += ' AND ml.action = ?';
    params.push(action);
  }
  if (target_type) {
    where += ' AND ml.target_type = ?';
    params.push(target_type);
  }

  const totalRow = db.prepare(
    `SELECT COUNT(*) as count FROM moderation_logs ml WHERE ${where}`
  ).get(...params) as { count: number };

  const rows = db.prepare(`
    SELECT ml.*,
      ou.username as operator_username,
      ou.nickname as operator_nickname,
      ou.avatar as operator_avatar
    FROM moderation_logs ml
    LEFT JOIN users ou ON ml.operator_id = ou.id
    WHERE ${where}
    ORDER BY ml.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const list = (Array.isArray(rows) ? rows : []).map((row: any) => ({
    ...row,
    extra: row.extra ? JSON.parse(row.extra) : null,
  }));

  success(res, {
    list,
    total: totalRow.count,
    page: pageNum,
    page_size: pageSize,
    empty: totalRow.count === 0,
  }, totalRow.count === 0 ? '暂无操作记录' : 'success');
});

router.get('/:roomId/logs/target/:targetType/:targetId', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId, targetType, targetId } = req.params;

  const rows = db.prepare(`
    SELECT ml.*,
      ou.username as operator_username,
      ou.nickname as operator_nickname,
      ou.avatar as operator_avatar
    FROM moderation_logs ml
    LEFT JOIN users ou ON ml.operator_id = ou.id
    WHERE ml.room_id = ? AND ml.target_type = ? AND ml.target_id = ?
    ORDER BY ml.created_at ASC
  `).all(roomId, targetType, targetId);

  const list = (Array.isArray(rows) ? rows : []).map((row: any) => ({
    ...row,
    extra: row.extra ? JSON.parse(row.extra) : null,
  }));

  const msg = db.prepare(`
    SELECT cm.id, cm.review_status, cm.review_conclusion, cm.current_handler,
      ch.nickname as current_handler_nickname,
      hu.nickname as handled_by_nickname,
      rv.nickname as reviewed_by_nickname
    FROM chat_messages cm
    LEFT JOIN users ch ON cm.current_handler = ch.id
    LEFT JOIN users hu ON cm.handled_by = hu.id
    LEFT JOIN users rv ON cm.reviewed_by = rv.id
    WHERE cm.id = ?
  `).get(targetId);

  success(res, {
    target_type: targetType,
    target_id: targetId,
    current_state: msg ? {
      review_status: (msg as any).review_status,
      review_conclusion: (msg as any).review_conclusion,
      current_handler: (msg as any).current_handler,
      current_handler_nickname: (msg as any).current_handler_nickname,
      handled_by_nickname: (msg as any).handled_by_nickname,
      reviewed_by_nickname: (msg as any).reviewed_by_nickname,
    } : null,
    timeline: list,
    total: list.length,
    empty: list.length === 0,
  }, list.length === 0 ? '暂无操作记录' : 'success');
});

export default router;
