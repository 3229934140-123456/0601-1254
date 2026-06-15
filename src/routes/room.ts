import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import db from '../database';
import { success, error } from '../utils/response';
import { authMiddleware, teacherMiddleware } from '../middleware/auth';
import { LiveRoom } from '../types';

const router = Router();

const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const createRoomSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  start_time: z.number().positive(),
  end_time: z.number().positive(),
  max_viewers: z.number().min(0).default(0),
  allow_guest: z.boolean().default(false),
});

const updateRoomSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  start_time: z.number().positive().optional(),
  end_time: z.number().positive().optional(),
  teacher_id: z.string().optional(),
  max_viewers: z.number().min(0).optional(),
  allow_guest: z.boolean().optional(),
});

router.post('/', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const parseResult = createRoomSchema.safeParse(req.body);
  if (!parseResult.success) {
    return error(res, parseResult.error.errors[0].message, 400);
  }
  const { title, description, start_time, end_time, max_viewers, allow_guest } = parseResult.data;

  if (start_time >= end_time) {
    return error(res, '结束时间必须大于开始时间', 400);
  }

  const { userId } = (req as any).user;
  const id = uuidv4();
  const watchToken = uuidv4().replace(/-/g, '');
  const now = Date.now();

  db.prepare(`INSERT INTO live_rooms 
    (id, title, description, teacher_id, start_time, end_time, status, watch_token, max_viewers, allow_guest, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, title, description || '', userId, start_time, end_time, 'scheduled', watchToken, max_viewers, allow_guest ? 1 : 0, now);

  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(id);
  success(res, room, '直播间创建成功');
});

router.get('/schedule', (req: Request, res: Response) => {
  const { status, start_date, end_date, page = '1', page_size = '20' } = req.query;

  let where = '1=1';
  const params: any[] = [];

  if (status) {
    where += ' AND status = ?';
    params.push(status);
  }
  if (start_date) {
    where += ' AND start_time >= ?';
    params.push(Number(start_date));
  }
  if (end_date) {
    where += ' AND start_time <= ?';
    params.push(Number(end_date));
  }

  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.min(100, Math.max(1, Number(page_size)));
  const offset = (pageNum - 1) * pageSize;

  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM live_rooms WHERE ${where}`).get(...params) as { count: number };
  const rows = db.prepare(`
    SELECT lr.*, u.nickname as teacher_name, u.avatar as teacher_avatar,
      r.id as replay_id, r.duration as replay_duration
    FROM live_rooms lr
    LEFT JOIN users u ON lr.teacher_id = u.id
    LEFT JOIN replays r ON lr.id = r.room_id
    WHERE ${where}
    ORDER BY lr.start_time DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const list = Array.isArray(rows) ? rows : [];

  success(res, {
    list,
    total: totalRow.count,
    page: pageNum,
    page_size: pageSize,
    has_more: pageNum * pageSize < totalRow.count,
    empty: totalRow.count === 0,
  }, totalRow.count === 0 ? '暂无排课数据' : 'success');
});

router.get('/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const room = db.prepare(`
    SELECT lr.*, u.nickname as teacher_name, u.avatar as teacher_avatar,
      r.id as replay_id, r.video_url as replay_url, r.duration as replay_duration,
      r.view_count as replay_view_count, r.created_at as replay_created_at
    FROM live_rooms lr
    LEFT JOIN users u ON lr.teacher_id = u.id
    LEFT JOIN replays r ON lr.id = r.room_id
    WHERE lr.id = ?
  `).get(id);
  if (!room) {
    return error(res, '直播间不存在', 404);
  }
  const roomData = room as any;
  const hasReplay = !!roomData.replay_id;
  success(res, { ...roomData, has_replay: hasReplay });
});

router.put('/:id', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { id } = req.params;
  const { userId, role } = (req as any).user;

  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(id) as LiveRoom | undefined;
  if (!room) {
    return error(res, '直播间不存在', 404);
  }
  if (role !== 'admin' && room.teacher_id !== userId) {
    return error(res, '无权限修改此直播间', 403);
  }

  const parseResult = updateRoomSchema.safeParse(req.body);
  if (!parseResult.success) {
    return error(res, parseResult.error.errors[0].message, 400);
  }

  const fields: string[] = [];
  const values: any[] = [];
  const data = parseResult.data;

  if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
  if (data.start_time !== undefined) { fields.push('start_time = ?'); values.push(data.start_time); }
  if (data.end_time !== undefined) { fields.push('end_time = ?'); values.push(data.end_time); }
  if (data.teacher_id !== undefined) { fields.push('teacher_id = ?'); values.push(data.teacher_id); }
  if (data.max_viewers !== undefined) { fields.push('max_viewers = ?'); values.push(data.max_viewers); }
  if (data.allow_guest !== undefined) { fields.push('allow_guest = ?'); values.push(data.allow_guest ? 1 : 0); }

  if (fields.length === 0) {
    return success(res, room, '无更新内容');
  }

  values.push(id);
  db.prepare(`UPDATE live_rooms SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(id);
  success(res, updated, '更新成功');
});

router.post('/:id/cover', authMiddleware, teacherMiddleware, upload.single('cover'), (req: Request, res: Response) => {
  const { id } = req.params;
  if (!req.file) {
    return error(res, '请上传封面图片', 400);
  }

  const { userId, role } = (req as any).user;
  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(id) as LiveRoom | undefined;
  if (!room) {
    return error(res, '直播间不存在', 404);
  }
  if (role !== 'admin' && room.teacher_id !== userId) {
    return error(res, '无权限修改此直播间', 403);
  }

  const coverUrl = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE live_rooms SET cover_image = ? WHERE id = ?').run(coverUrl, id);
  success(res, { cover_url: coverUrl }, '封面上传成功');
});

router.post('/:id/status', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatus = ['scheduled', 'live', 'ended'];
  if (!validStatus.includes(status)) {
    return error(res, '无效的状态', 400);
  }

  const { userId, role } = (req as any).user;
  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(id) as LiveRoom | undefined;
  if (!room) {
    return error(res, '直播间不存在', 404);
  }
  if (role !== 'admin' && room.teacher_id !== userId) {
    return error(res, '无权限修改此直播间', 403);
  }

  db.prepare('UPDATE live_rooms SET status = ? WHERE id = ?').run(status, id);
  success(res, { status }, '状态更新成功');
});

router.get('/:id/entry', authMiddleware, (req: Request, res: Response) => {
  const { id } = req.params;
  const room = db.prepare('SELECT id, title, watch_token, status FROM live_rooms WHERE id = ?').get(id);
  if (!room) {
    return error(res, '直播间不存在', 404);
  }
  success(res, {
    room_id: id,
    watch_token: (room as any).watch_token,
    entry_url: `/live/${id}?token=${(room as any).watch_token}`,
  });
});

export default router;
