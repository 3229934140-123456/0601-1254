import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import db from '../database';
import { success, error } from '../utils/response';
import { authMiddleware, teacherMiddleware } from '../middleware/auth';
import { LiveRoom, WatchSession } from '../types';

const router = Router();

const createReplaySchema = z.object({
  video_url: z.string().max(500).optional(),
  duration: z.number().min(0).default(0),
});

router.post('/:roomId', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { userId, role } = (req as any).user;

  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(roomId) as LiveRoom | undefined;
  if (!room) {
    return error(res, '直播间不存在', 404);
  }
  if (role !== 'admin' && room.teacher_id !== userId) {
    return error(res, '无权限操作', 403);
  }

  const parseResult = createReplaySchema.safeParse(req.body);
  if (!parseResult.success) {
    return error(res, parseResult.error.errors[0].message, 400);
  }
  const { video_url, duration } = parseResult.data;

  const existing = db.prepare('SELECT id FROM replays WHERE room_id = ?').get(roomId);
  let replayId: string;

  if (existing) {
    replayId = (existing as any).id;
    db.prepare('UPDATE replays SET video_url = ?, duration = ? WHERE id = ?')
      .run(video_url || '', duration, replayId);
  } else {
    replayId = uuidv4();
    db.prepare(`INSERT INTO replays 
      (id, room_id, title, video_url, duration, view_count, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)`)
      .run(replayId, roomId, room.title, video_url || '', duration, Date.now());
  }

  db.prepare('UPDATE live_rooms SET status = ? WHERE id = ?').run('ended', roomId);

  const replay = db.prepare(`
    SELECT r.*, lr.cover_image, lr.teacher_id, u.nickname as teacher_name
    FROM replays r
    LEFT JOIN live_rooms lr ON r.room_id = lr.id
    LEFT JOIN users u ON lr.teacher_id = u.id
    WHERE r.id = ?
  `).get(replayId);

  success(res, replay, '回放生成成功');
});

router.get('/', authMiddleware, (req: Request, res: Response) => {
  const { teacher_id, page = '1', page_size = '20' } = req.query;

  let where = '1=1';
  const params: any[] = [];

  if (teacher_id) {
    where += ' AND lr.teacher_id = ?';
    params.push(teacher_id);
  }

  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.min(100, Math.max(1, Number(page_size)));
  const offset = (pageNum - 1) * pageSize;

  const totalRow = db.prepare(`
    SELECT COUNT(*) as count FROM replays r
    LEFT JOIN live_rooms lr ON r.room_id = lr.id
    WHERE ${where}
  `).get(...params) as { count: number };

  const rows = db.prepare(`
    SELECT r.*, lr.cover_image, lr.start_time, lr.teacher_id,
      u.nickname as teacher_name, u.avatar as teacher_avatar
    FROM replays r
    LEFT JOIN live_rooms lr ON r.room_id = lr.id
    LEFT JOIN users u ON lr.teacher_id = u.id
    WHERE ${where}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  success(res, {
    list: rows,
    total: totalRow.count,
    page: pageNum,
    page_size: pageSize,
  });
});

router.get('/:id', authMiddleware, (req: Request, res: Response) => {
  const { id } = req.params;
  const replay = db.prepare(`
    SELECT r.*, lr.cover_image, lr.start_time, lr.teacher_id,
      u.nickname as teacher_name, u.avatar as teacher_avatar,
      lr.description
    FROM replays r
    LEFT JOIN live_rooms lr ON r.room_id = lr.id
    LEFT JOIN users u ON lr.teacher_id = u.id
    WHERE r.id = ?
  `).get(id);

  if (!replay) {
    return error(res, '回放不存在', 404);
  }

  db.prepare('UPDATE replays SET view_count = view_count + 1 WHERE id = ?').run(id);

  success(res, { ...(replay as any), view_count: ((replay as any).view_count + 1) });
});

router.get('/room/:roomId', authMiddleware, (req: Request, res: Response) => {
  const { roomId } = req.params;
  const replay = db.prepare(`
    SELECT r.*, lr.cover_image, lr.start_time, lr.teacher_id,
      u.nickname as teacher_name, u.avatar as teacher_avatar
    FROM replays r
    LEFT JOIN live_rooms lr ON r.room_id = lr.id
    LEFT JOIN users u ON lr.teacher_id = u.id
    WHERE r.room_id = ?
  `).get(roomId);

  if (!replay) {
    return error(res, '该直播间暂无回放', 404);
  }
  success(res, replay);
});

router.get('/:id/viewer-stats', authMiddleware, (req: Request, res: Response) => {
  const { id } = req.params;
  const { userId, role } = (req as any).user;

  const replay = db.prepare('SELECT * FROM replays WHERE id = ?').get(id);
  if (!replay) {
    return error(res, '回放不存在', 404);
  }

  const replayData = replay as any;

  if (role === 'viewer') {
    const sessions = db.prepare(
      'SELECT * FROM watch_sessions WHERE room_id = ? AND user_id = ?'
    ).all(replayData.room_id, userId) as WatchSession[];
    const totalDuration = sessions.reduce((sum, s) => sum + s.duration, 0);

    return success(res, {
      user_id: userId,
      total_watch_seconds: totalDuration,
      sessions: sessions.map(s => ({
        join_time: s.join_time,
        leave_time: s.leave_time,
        duration: s.duration,
      })),
    });
  }

  const sessions = db.prepare(`
    SELECT ws.*, u.username, u.nickname, u.avatar
    FROM watch_sessions ws
    LEFT JOIN users u ON ws.user_id = u.id
    WHERE ws.room_id = ?
    ORDER BY ws.join_time DESC
  `).all(replayData.room_id);

  const stats: Record<string, { user_id: string; username?: string; nickname?: string; avatar?: string; total_duration: number; sessions_count: number }> = {};

  for (const s of sessions as any[]) {
    if (!stats[s.user_id]) {
      stats[s.user_id] = {
        user_id: s.user_id,
        username: s.username,
        nickname: s.nickname,
        avatar: s.avatar,
        total_duration: 0,
        sessions_count: 0,
      };
    }
    stats[s.user_id].total_duration += s.duration || 0;
    stats[s.user_id].sessions_count += 1;
  }

  const viewerList = Object.values(stats).sort((a, b) => b.total_duration - a.total_duration);

  success(res, {
    replay_id: id,
    room_id: replayData.room_id,
    total_viewers: viewerList.length,
    total_view_duration: viewerList.reduce((sum, v) => sum + v.total_duration, 0),
    viewers: viewerList,
  });
});

export default router;
