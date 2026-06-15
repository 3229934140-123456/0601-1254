import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import db from '../database';
import { success, error } from '../utils/response';
import { authMiddleware, teacherMiddleware } from '../middleware/auth';
import { containsBannedWord, maskContent } from '../utils/contentFilter';
import { ChatMessage } from '../types';
import { isUserMuted, getMuteInfo } from '../services/roomAccess';

const router = Router();

const sendMessageSchema = z.object({
  content: z.string().min(1).max(500),
  msg_type: z.enum(['text', 'emoji']).default('text'),
  is_question: z.boolean().default(false),
});

router.post('/:roomId/messages', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId, role } = (req as any).user;

  const parseResult = sendMessageSchema.safeParse(req.body);
  if (!parseResult.success) {
    return error(res, parseResult.error.errors[0].message, 400);
  }
  const { content, msg_type, is_question } = parseResult.data;

  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(roomId);
  if (!room) {
    return error(res, '直播间不存在', 404);
  }

  if (role !== 'teacher' && role !== 'admin') {
    const muted = isUserMuted(roomId, userId);
    if (muted) {
      const muteInfo = getMuteInfo(roomId, userId);
      return error(res, '您已被禁言，无法发送消息', 403);
    }
  }

  const banned = containsBannedWord(content);
  const now = Date.now();
  const id = uuidv4();
  const user = db.prepare('SELECT nickname FROM users WHERE id = ?').get(userId) as { nickname?: string };

  db.prepare(`INSERT INTO chat_messages 
    (id, room_id, user_id, user_nickname, content, msg_type, is_pinned, is_question, blocked, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(
      id,
      roomId,
      userId,
      user?.nickname || '匿名用户',
      banned ? maskContent(content) : content,
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

  success(res, {
    message,
    blocked: !!banned,
    blocked_word: banned,
  }, banned ? '消息包含违规内容，已屏蔽' : '消息发送成功');
});

router.get('/:roomId/messages', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { page = '1', page_size = '50', type } = req.query;

  let where = 'room_id = ? AND blocked = 0';
  const params: any[] = [roomId];

  if (type === 'question') {
    where += ' AND is_question = 1';
  }

  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.min(200, Math.max(1, Number(page_size)));
  const offset = (pageNum - 1) * pageSize;

  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM chat_messages WHERE ${where}`).get(...params) as { count: number };
  const rows = db.prepare(`
    SELECT cm.*, u.username, u.avatar, u.role as user_role
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    WHERE ${where}
    ORDER BY cm.is_pinned DESC, cm.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  success(res, {
    list: rows,
    total: totalRow.count,
    page: pageNum,
    page_size: pageSize,
  });
});

router.get('/:roomId/messages/pinned', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const rows = db.prepare(`
    SELECT cm.*, u.username, u.avatar, u.role as user_role
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    WHERE cm.room_id = ? AND cm.is_pinned = 1
    ORDER BY cm.created_at DESC
  `).all(roomId);
  success(res, { list: rows });
});

router.post('/:roomId/messages/:msgId/pin', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId, msgId } = req.params;

  const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND room_id = ?').get(msgId, roomId) as ChatMessage | undefined;
  if (!msg) {
    return error(res, '消息不存在', 404);
  }

  db.prepare('UPDATE chat_messages SET is_pinned = 1 WHERE id = ?').run(msgId);
  const updated = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(msgId);
  success(res, updated, '已置顶');
});

router.post('/:roomId/messages/:msgId/unpin', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId, msgId } = req.params;

  const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND room_id = ?').get(msgId, roomId);
  if (!msg) {
    return error(res, '消息不存在', 404);
  }

  db.prepare('UPDATE chat_messages SET is_pinned = 0 WHERE id = ?').run(msgId);
  success(res, { id: msgId, is_pinned: 0 }, '已取消置顶');
});

router.post('/:roomId/messages/:msgId/answer', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId, msgId } = req.params;
  const { userId } = (req as any).user;
  const { answer } = req.body;

  if (!answer || typeof answer !== 'string' || answer.length > 2000) {
    return error(res, '回答内容不能为空且不能超过2000字符', 400);
  }

  const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND room_id = ?').get(msgId, roomId) as ChatMessage | undefined;
  if (!msg) {
    return error(res, '问题不存在', 404);
  }
  if (!msg.is_question) {
    return error(res, '该消息不是问题', 400);
  }

  const banned = containsBannedWord(answer);
  const now = Date.now();
  db.prepare('UPDATE chat_messages SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?')
    .run(banned ? maskContent(answer) : answer, userId, now, msgId);

  const updated = db.prepare(`
    SELECT cm.*, u.username, u.avatar, u.role as user_role
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    WHERE cm.id = ?
  `).get(msgId);

  success(res, updated, '回答已提交');
});

router.get('/:roomId/questions', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { answered } = req.query;

  let where = 'room_id = ? AND is_question = 1';
  const params: any[] = [roomId];

  if (answered === 'true') {
    where += ' AND answer IS NOT NULL';
  } else if (answered === 'false') {
    where += ' AND answer IS NULL';
  }

  const rows = db.prepare(`
    SELECT cm.*, u.username, u.avatar, u.role as user_role,
      au.nickname as answered_by_nickname
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    LEFT JOIN users au ON cm.answered_by = au.id
    WHERE ${where}
    ORDER BY cm.created_at DESC
  `).all(...params);

  success(res, { list: rows, total: rows.length });
});

router.get('/banned-words', authMiddleware, (req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM banned_words ORDER BY created_at DESC').all();
  success(res, { list: rows });
});

router.post('/banned-words', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { word } = req.body;
  if (!word || typeof word !== 'string' || word.length > 50) {
    return error(res, '违规词无效', 400);
  }

  const existing = db.prepare('SELECT id FROM banned_words WHERE word = ?').get(word);
  if (existing) {
    return error(res, '该违规词已存在', 400);
  }

  const id = uuidv4();
  db.prepare('INSERT INTO banned_words (id, word, created_at) VALUES (?, ?, ?)').run(id, word, Date.now());
  success(res, { id, word }, '违规词添加成功');
});

router.delete('/banned-words/:id', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { id } = req.params;
  db.prepare('DELETE FROM banned_words WHERE id = ?').run(id);
  success(res, null, '删除成功');
});

export default router;
