import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import db from '../database';
import { success, error } from '../utils/response';
import { authMiddleware } from '../middleware/auth';
import { checkRoomAccess } from '../services/roomAccess';

const router = Router();

const likeSchema = z.object({
  count: z.number().min(1).max(100).default(1),
  watch_token: z.string().optional(),
});

const rewardSchema = z.object({
  gift_type: z.string().min(1).max(50),
  amount: z.number().min(1).max(1000000),
  message: z.string().max(200).optional(),
  watch_token: z.string().optional(),
});

router.post('/:roomId/like', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId, role } = (req as any).user;

  const parseResult = likeSchema.safeParse(req.body);
  if (!parseResult.success) {
    return error(res, parseResult.error.errors[0].message, 400);
  }
  const { count, watch_token } = parseResult.data;

  const accessResult = checkRoomAccess(roomId, userId, role, watch_token);
  if (!accessResult.allowed) {
    return error(res, accessResult.reason || '无权操作', accessResult.code || 403);
  }

  const id = uuidv4();
  const now = Date.now();

  db.prepare('INSERT INTO likes (id, room_id, user_id, count, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, roomId, userId, count, now);

  const totalRow = db.prepare('SELECT SUM(count) as total FROM likes WHERE room_id = ?').get(roomId) as { total: number };

  success(res, {
    like_id: id,
    count,
    total_likes: totalRow.total || 0,
  }, '点赞成功');
});

router.get('/:roomId/likes', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const totalRow = db.prepare('SELECT SUM(count) as total, COUNT(*) as users FROM likes WHERE room_id = ?')
    .get(roomId) as { total: number; users: number };

  success(res, {
    room_id: roomId,
    total_likes: totalRow.total || 0,
    total_users: totalRow.users || 0,
  });
});

router.post('/:roomId/reward', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId, role } = (req as any).user;

  const parseResult = rewardSchema.safeParse(req.body);
  if (!parseResult.success) {
    return error(res, parseResult.error.errors[0].message, 400);
  }
  const { gift_type, amount, message, watch_token } = parseResult.data;

  const accessResult = checkRoomAccess(roomId, userId, role, watch_token);
  if (!accessResult.allowed) {
    return error(res, accessResult.reason || '无权操作', accessResult.code || 403);
  }

  const user = db.prepare('SELECT nickname FROM users WHERE id = ?').get(userId) as { nickname?: string };
  const id = uuidv4();
  const now = Date.now();

  db.prepare(`INSERT INTO rewards 
    (id, room_id, user_id, user_nickname, gift_type, amount, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, roomId, userId, user?.nickname || '匿名用户', gift_type, amount, message || '', now);

  const reward = db.prepare(`
    SELECT r.*, u.username, u.avatar
    FROM rewards r
    LEFT JOIN users u ON r.user_id = u.id
    WHERE r.id = ?
  `).get(id);

  success(res, reward, '打赏成功');
});

router.get('/:roomId/rewards', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;

  const rows = db.prepare(`
    SELECT r.*, u.username, u.avatar
    FROM rewards r
    LEFT JOIN users u ON r.user_id = u.id
    WHERE r.room_id = ?
    ORDER BY r.created_at DESC
    LIMIT 100
  `).all(roomId);

  const totalRow = db.prepare('SELECT SUM(amount) as total, COUNT(*) as count FROM rewards WHERE room_id = ?')
    .get(roomId) as { total: number; count: number };

  success(res, {
    list: rows,
    total_amount: totalRow.total || 0,
    total_count: totalRow.count || 0,
  });
});

export default router;
