import { Router, Request, Response } from 'express';
import { createObjectCsvWriter } from 'csv-writer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import db from '../database';
import { success, error } from '../utils/response';
import { authMiddleware, teacherMiddleware } from '../middleware/auth';

const router = Router();

const exportDir = path.join(process.cwd(), 'exports');
if (!fs.existsSync(exportDir)) {
  fs.mkdirSync(exportDir, { recursive: true });
}

const RESERVED_PATHS = new Set(['report', 'tasks']);

router.get('/:roomId/chat-messages', authMiddleware, teacherMiddleware, async (req: Request, res: Response, next: Function) => {
  if (RESERVED_PATHS.has(req.params.roomId)) return next();
  const { roomId } = req.params;
  const { format = 'json' } = req.query;

  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(roomId);
  if (!room) {
    return error(res, '直播间不存在', 404);
  }

  const messages = db.prepare(`
    SELECT 
      cm.id as message_id,
      cm.content,
      cm.msg_type,
      cm.is_pinned,
      cm.is_question,
      cm.answer,
      cm.blocked,
      cm.created_at,
      u.id as user_id,
      u.username,
      u.nickname,
      u.role as user_role
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    WHERE cm.room_id = ?
    ORDER BY cm.created_at ASC
  `).all(roomId);

  if (format === 'csv') {
    const fileName = `chat_${roomId}_${Date.now()}.csv`;
    const filePath = path.join(exportDir, fileName);

    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'message_id', title: '消息ID' },
        { id: 'user_id', title: '用户ID' },
        { id: 'username', title: '用户名' },
        { id: 'nickname', title: '昵称' },
        { id: 'user_role', title: '角色' },
        { id: 'content', title: '内容' },
        { id: 'msg_type', title: '类型' },
        { id: 'is_pinned', title: '是否置顶' },
        { id: 'is_question', title: '是否问题' },
        { id: 'answer', title: '回答' },
        { id: 'blocked', title: '是否屏蔽' },
        { id: 'created_at', title: '发送时间' },
      ],
    });

    const records = messages.map((m: any) => ({
      ...m,
      is_pinned: m.is_pinned ? '是' : '否',
      is_question: m.is_question ? '是' : '否',
      blocked: m.blocked ? '是' : '否',
      created_at: new Date(m.created_at).toLocaleString('zh-CN'),
    }));

    await csvWriter.writeRecords(records);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    fileStream.on('end', () => {
      fs.unlink(filePath, () => {});
    });
    return;
  }

  success(res, {
    room_id: roomId,
    total: messages.length,
    messages,
  });
});

router.get('/:roomId/questions', authMiddleware, teacherMiddleware, async (req: Request, res: Response, next: Function) => {
  if (RESERVED_PATHS.has(req.params.roomId)) return next();
  const { roomId } = req.params;
  const { format = 'json' } = req.query;

  const questions = db.prepare(`
    SELECT 
      cm.id as question_id,
      cm.content as question_content,
      cm.answer,
      cm.answered_at,
      cm.created_at as question_time,
      u.id as user_id,
      u.username,
      u.nickname,
      au.nickname as answered_by_nickname
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    LEFT JOIN users au ON cm.answered_by = au.id
    WHERE cm.room_id = ? AND cm.is_question = 1
    ORDER BY cm.created_at ASC
  `).all(roomId);

  if (format === 'csv') {
    const fileName = `questions_${roomId}_${Date.now()}.csv`;
    const filePath = path.join(exportDir, fileName);

    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'question_id', title: '问题ID' },
        { id: 'user_id', title: '用户ID' },
        { id: 'username', title: '用户名' },
        { id: 'nickname', title: '昵称' },
        { id: 'question_content', title: '问题内容' },
        { id: 'answer', title: '回答' },
        { id: 'answered_by_nickname', title: '回答人' },
        { id: 'question_time', title: '提问时间' },
        { id: 'answered_at', title: '回答时间' },
      ],
    });

    const records = questions.map((q: any) => ({
      ...q,
      question_time: new Date(q.question_time).toLocaleString('zh-CN'),
      answered_at: q.answered_at ? new Date(q.answered_at).toLocaleString('zh-CN') : '',
    }));

    await csvWriter.writeRecords(records);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    fileStream.on('end', () => {
      fs.unlink(filePath, () => {});
    });
    return;
  }

  success(res, {
    room_id: roomId,
    total: questions.length,
    questions,
  });
});

router.get('/:roomId/viewers', authMiddleware, teacherMiddleware, async (req: Request, res: Response, next: Function) => {
  if (RESERVED_PATHS.has(req.params.roomId)) return next();
  const { roomId } = req.params;
  const { format = 'json' } = req.query;

  const sessions = db.prepare(`
    SELECT 
      ws.id as session_id,
      ws.user_id,
      ws.join_time,
      ws.leave_time,
      ws.duration,
      u.username,
      u.nickname,
      u.avatar
    FROM watch_sessions ws
    LEFT JOIN users u ON ws.user_id = u.id
    WHERE ws.room_id = ?
    ORDER BY ws.join_time ASC
  `).all(roomId);

  const viewerStats: Record<string, any> = {};
  for (const s of sessions as any[]) {
    if (!viewerStats[s.user_id]) {
      viewerStats[s.user_id] = {
        user_id: s.user_id,
        username: s.username,
        nickname: s.nickname,
        avatar: s.avatar,
        total_duration: 0,
        sessions_count: 0,
        first_join: s.join_time,
        last_leave: s.leave_time || Date.now(),
      };
    }
    viewerStats[s.user_id].total_duration += s.duration || 0;
    viewerStats[s.user_id].sessions_count += 1;
    viewerStats[s.user_id].last_leave = Math.max(
      viewerStats[s.user_id].last_leave,
      s.leave_time || Date.now()
    );
  }

  const viewers = Object.values(viewerStats).sort((a, b) => b.total_duration - a.total_duration);

  if (format === 'csv') {
    const fileName = `viewers_${roomId}_${Date.now()}.csv`;
    const filePath = path.join(exportDir, fileName);

    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'user_id', title: '用户ID' },
        { id: 'username', title: '用户名' },
        { id: 'nickname', title: '昵称' },
        { id: 'total_duration', title: '观看时长(秒)' },
        { id: 'sessions_count', title: '进入次数' },
        { id: 'first_join', title: '首次进入时间' },
        { id: 'last_leave', title: '最后离开时间' },
      ],
    });

    const records = viewers.map((v: any) => ({
      ...v,
      first_join: new Date(v.first_join).toLocaleString('zh-CN'),
      last_leave: new Date(v.last_leave).toLocaleString('zh-CN'),
    }));

    await csvWriter.writeRecords(records);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    fileStream.on('end', () => {
      fs.unlink(filePath, () => {});
    });
    return;
  }

  success(res, {
    room_id: roomId,
    total_viewers: viewers.length,
    viewers,
  });
});

router.get('/:roomId/rewards', authMiddleware, teacherMiddleware, async (req: Request, res: Response, next: Function) => {
  if (RESERVED_PATHS.has(req.params.roomId)) return next();
  const { roomId } = req.params;
  const { format = 'json' } = req.query;

  const rewards = db.prepare(`
    SELECT 
      r.id as reward_id,
      r.gift_type,
      r.amount,
      r.message,
      r.created_at,
      u.id as user_id,
      u.username,
      u.nickname,
      u.avatar
    FROM rewards r
    LEFT JOIN users u ON r.user_id = u.id
    WHERE r.room_id = ?
    ORDER BY r.created_at DESC
  `).all(roomId);

  const totalRow = db.prepare('SELECT SUM(amount) as total, COUNT(*) as count FROM rewards WHERE room_id = ?')
    .get(roomId) as { total: number; count: number };

  if (format === 'csv') {
    const fileName = `rewards_${roomId}_${Date.now()}.csv`;
    const filePath = path.join(exportDir, fileName);

    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'reward_id', title: '打赏ID' },
        { id: 'user_id', title: '用户ID' },
        { id: 'username', title: '用户名' },
        { id: 'nickname', title: '昵称' },
        { id: 'gift_type', title: '礼物类型' },
        { id: 'amount', title: '金额' },
        { id: 'message', title: '留言' },
        { id: 'created_at', title: '打赏时间' },
      ],
    });

    const records = rewards.map((r: any) => ({
      ...r,
      created_at: new Date(r.created_at).toLocaleString('zh-CN'),
    }));

    await csvWriter.writeRecords(records);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    fileStream.on('end', () => {
      fs.unlink(filePath, () => {});
    });
    return;
  }

  success(res, {
    room_id: roomId,
    total_amount: totalRow.total || 0,
    total_count: totalRow.count || 0,
    rewards,
  });
});

router.get('/:roomId/summary', authMiddleware, teacherMiddleware, (req: Request, res: Response, next: Function) => {
  if (RESERVED_PATHS.has(req.params.roomId)) return next();
  const { roomId } = req.params;

  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(roomId);
  if (!room) {
    return error(res, '直播间不存在', 404);
  }

  const roomData = room as any;

  const messageCount = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ?').get(roomId) as { count: number };
  const blockedMessageCount = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND blocked = 1').get(roomId) as { count: number };
  const questionCount = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND is_question = 1').get(roomId) as { count: number };
  const answeredCount = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND is_question = 1 AND answer IS NOT NULL').get(roomId) as { count: number };
  const likeRow = db.prepare('SELECT SUM(count) as total, COUNT(DISTINCT user_id) as users FROM likes WHERE room_id = ?').get(roomId) as { total: number; users: number };
  const rewardRow = db.prepare('SELECT SUM(amount) as total, COUNT(*) as count, COUNT(DISTINCT user_id) as users FROM rewards WHERE room_id = ?').get(roomId) as { total: number; count: number; users: number };
  const enrollmentRow = db.prepare('SELECT COUNT(*) as count FROM room_enrollments WHERE room_id = ?').get(roomId) as { count: number };
  const viewerRow = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM watch_sessions WHERE room_id = ?').get(roomId) as { count: number };
  const durationRow = db.prepare('SELECT SUM(duration) as total, COUNT(*) as sessions FROM watch_sessions WHERE room_id = ?').get(roomId) as { total: number; sessions: number };
  const muteRow = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM mutes WHERE room_id = ?').get(roomId) as { count: number };

  const enrollmentCount = enrollmentRow.count;
  const actualViewerCount = viewerRow.count;
  const totalWatchSeconds = durationRow.total || 0;
  const avgWatchSeconds = actualViewerCount > 0 ? Math.floor(totalWatchSeconds / actualViewerCount) : 0;
  const attendanceRate = enrollmentCount > 0 ? Math.round((actualViewerCount / enrollmentCount) * 10000) / 100 : 0;
  const totalInteractions = messageCount.count + (likeRow.total || 0) + rewardRow.count;
  const answerRate = questionCount.count > 0 ? Math.round((answeredCount.count / questionCount.count) * 10000) / 100 : 0;

  const replay = db.prepare('SELECT * FROM replays WHERE room_id = ?').get(roomId);

  success(res, {
    room_id: roomId,
    title: roomData.title,
    cover_image: roomData.cover_image,
    start_time: roomData.start_time,
    end_time: roomData.end_time,
    status: roomData.status,
    teacher_id: roomData.teacher_id,
    has_replay: !!replay,
    stats: {
      enrollments: enrollmentCount,
      actual_viewers: actualViewerCount,
      attendance_rate: attendanceRate,
      total_watch_seconds: totalWatchSeconds,
      avg_watch_seconds: avgWatchSeconds,
      avg_watch_formatted: formatDuration(avgWatchSeconds),
      total_messages: messageCount.count,
      blocked_messages: blockedMessageCount.count,
      questions: questionCount.count,
      answered_questions: answeredCount.count,
      answer_rate: answerRate,
      total_likes: likeRow.total || 0,
      like_users: likeRow.users || 0,
      total_rewards: rewardRow.total || 0,
      reward_count: rewardRow.count,
      reward_users: rewardRow.users || 0,
      total_interactions: totalInteractions,
      muted_users: muteRow.count,
      watch_sessions: durationRow.sessions || 0,
    },
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

const GRANULARITY_MS: Record<string, number> = {
  '1min': 60 * 1000,
  '5min': 5 * 60 * 1000,
  '15min': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

function getTimeBuckets(startTime: number, endTime: number, granularity: string): number[] {
  const step = GRANULARITY_MS[granularity] || GRANULARITY_MS['5min'];
  const buckets: number[] = [];
  let current = Math.floor(startTime / step) * step;
  const end = Math.floor(endTime / step) * step;
  while (current <= end) {
    buckets.push(current);
    current += step;
  }
  return buckets;
}

router.get('/:roomId/trends', authMiddleware, teacherMiddleware, (req: Request, res: Response, next: Function) => {
  if (RESERVED_PATHS.has(req.params.roomId)) return next();
  const { roomId } = req.params;
  const { granularity = '5min', start_time, end_time } = req.query;

  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(roomId);
  if (!room) {
    return error(res, '直播间不存在', 404);
  }

  const roomData = room as any;
  const startTime = start_time ? Number(start_time) : roomData.start_time;
  const endTime = end_time ? Number(end_time) : (roomData.end_time || Date.now());

  if (!GRANULARITY_MS[granularity as string]) {
    return error(res, '无效的时间粒度，支持：1min, 5min, 15min, 1h, 1d', 400);
  }

  const step = GRANULARITY_MS[granularity as string];
  const buckets = getTimeBuckets(startTime, endTime, granularity as string);

  const bucketIndex = (ts: number) => Math.floor((ts - startTime) / step);

  const msgData = new Map<number, { count: number; users: Set<string> }>();
  const messages = db.prepare(
    'SELECT created_at, user_id FROM chat_messages WHERE room_id = ? AND created_at >= ? AND created_at <= ? AND blocked = 0'
  ).all(roomId, startTime, endTime) as any[];
  for (const m of messages) {
    const idx = bucketIndex(m.created_at);
    if (!msgData.has(idx)) {
      msgData.set(idx, { count: 0, users: new Set() });
    }
    const d = msgData.get(idx)!;
    d.count += 1;
    d.users.add(m.user_id);
  }

  const likeData = new Map<number, { count: number; total: number; users: Set<string> }>();
  const likes = db.prepare(
    'SELECT created_at, user_id, count FROM likes WHERE room_id = ? AND created_at >= ? AND created_at <= ?'
  ).all(roomId, startTime, endTime) as any[];
  for (const l of likes) {
    const idx = bucketIndex(l.created_at);
    if (!likeData.has(idx)) {
      likeData.set(idx, { count: 0, total: 0, users: new Set() });
    }
    const d = likeData.get(idx)!;
    d.count += 1;
    d.total += l.count;
    d.users.add(l.user_id);
  }

  const rewardData = new Map<number, { count: number; amount: number; users: Set<string> }>();
  const rewards = db.prepare(
    'SELECT created_at, user_id, amount FROM rewards WHERE room_id = ? AND created_at >= ? AND created_at <= ?'
  ).all(roomId, startTime, endTime) as any[];
  for (const r of rewards) {
    const idx = bucketIndex(r.created_at);
    if (!rewardData.has(idx)) {
      rewardData.set(idx, { count: 0, amount: 0, users: new Set() });
    }
    const d = rewardData.get(idx)!;
    d.count += 1;
    d.amount += r.amount;
    d.users.add(r.user_id);
  }

  const activeUserData = new Map<number, Set<string>>();
  const sessions = db.prepare(
    'SELECT join_time, leave_time, user_id, duration FROM watch_sessions WHERE room_id = ? AND join_time <= ? AND (leave_time IS NULL OR leave_time >= ?)'
  ).all(roomId, endTime, startTime) as any[];

  for (const s of sessions) {
    const sJoin = Math.max(s.join_time, startTime);
    const sLeave = Math.min(s.leave_time || Date.now(), endTime);
    const startIdx = bucketIndex(sJoin);
    const endIdx = bucketIndex(sLeave);
    for (let i = startIdx; i <= endIdx; i++) {
      if (!activeUserData.has(i)) {
        activeUserData.set(i, new Set());
      }
      activeUserData.get(i)!.add(s.user_id);
    }
  }

  const allTrends = buckets.map((bucketStart, idx) => {
    const msg = msgData.get(idx) || { count: 0, users: new Set() };
    const like = likeData.get(idx) || { count: 0, total: 0, users: new Set() };
    const reward = rewardData.get(idx) || { count: 0, amount: 0, users: new Set() };
    const activeUsers = activeUserData.get(idx) || new Set();

    return {
      timestamp: bucketStart,
      datetime: new Date(bucketStart).toLocaleString('zh-CN'),
      messages: msg.count,
      message_users: msg.users.size,
      likes: like.total,
      like_users: like.users.size,
      rewards: reward.count,
      reward_amount: reward.amount,
      reward_users: reward.users.size,
      active_users: activeUsers.size,
      interactions: msg.count + like.total + reward.count,
    };
  });

  const trends = allTrends.filter(t => t.messages > 0 || t.likes > 0 || t.rewards > 0 || t.active_users > 0);

  const totalMessages = messages.length;
  const totalLikes = likes.reduce((sum: number, l: any) => sum + l.count, 0);
  const totalRewards = rewards.length;
  const totalRewardAmount = rewards.reduce((sum: number, r: any) => sum + r.amount, 0);
  const uniqueMsgUsers = new Set(messages.map((m: any) => m.user_id)).size;
  const uniqueLikeUsers = new Set(likes.map((l: any) => l.user_id)).size;
  const uniqueRewardUsers = new Set(rewards.map((r: any) => r.user_id)).size;
  const uniqueActiveUsers = new Set(sessions.map((s: any) => s.user_id)).size;

  success(res, {
    room_id: roomId,
    title: roomData.title,
    granularity: granularity as string,
    start_time: startTime,
    end_time: endTime,
    total_points: trends.length,
    empty: trends.length === 0,
    summary: {
      total_messages: totalMessages,
      total_likes: totalLikes,
      total_rewards: totalRewards,
      total_reward_amount: totalRewardAmount,
      total_interactions: totalMessages + totalLikes + totalRewards,
      unique_message_users: uniqueMsgUsers,
      unique_like_users: uniqueLikeUsers,
      unique_reward_users: uniqueRewardUsers,
      unique_active_users: uniqueActiveUsers,
      peak_active_users: trends.length > 0 ? Math.max(...trends.map(t => t.active_users)) : 0,
      peak_messages: trends.length > 0 ? Math.max(...trends.map(t => t.messages)) : 0,
      peak_interactions: trends.length > 0 ? Math.max(...trends.map(t => t.interactions)) : 0,
    },
    trends,
  }, trends.length === 0 ? '暂无趋势数据' : 'success');
});

router.get('/report/courses', authMiddleware, teacherMiddleware, async (req: Request, res: Response) => {
  const { userId: currentUserId, role } = (req as any).user;
  const {
    teacher_id,
    start_date,
    end_date,
    status,
    format = 'json',
    page = '1',
    page_size = '50',
  } = req.query;

  let where = '1=1';
  const params: any[] = [];

  if (role === 'teacher') {
    where += ' AND lr.teacher_id = ?';
    params.push(currentUserId);
  } else if (teacher_id) {
    where += ' AND lr.teacher_id = ?';
    params.push(teacher_id);
  }

  if (start_date) {
    where += ' AND lr.start_time >= ?';
    params.push(Number(start_date));
  }
  if (end_date) {
    where += ' AND lr.start_time <= ?';
    params.push(Number(end_date));
  }
  if (status) {
    where += ' AND lr.status = ?';
    params.push(status);
  }

  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.min(200, Math.max(1, Number(page_size)));
  const offset = (pageNum - 1) * pageSize;

  const totalRow = db.prepare(`
    SELECT COUNT(*) as count FROM live_rooms lr WHERE ${where}
  `).get(...params) as { count: number };

  const rooms = db.prepare(`
    SELECT lr.*, u.nickname as teacher_name, u.avatar as teacher_avatar
    FROM live_rooms lr
    LEFT JOIN users u ON lr.teacher_id = u.id
    WHERE ${where}
    ORDER BY lr.start_time DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as any[];

  const courseStats = rooms.map(room => {
    const roomId = room.id;

    const enrollmentRow = db.prepare('SELECT COUNT(*) as count FROM room_enrollments WHERE room_id = ?')
      .get(roomId) as { count: number };
    const viewerRow = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM watch_sessions WHERE room_id = ?')
      .get(roomId) as { count: number };
    const durationRow = db.prepare('SELECT SUM(duration) as total, COUNT(DISTINCT user_id) as users FROM watch_sessions WHERE room_id = ?')
      .get(roomId) as { total: number; users: number };
    const messageRow = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND blocked = 0')
      .get(roomId) as { count: number };
    const blockedMsgRow = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND blocked = 1')
      .get(roomId) as { count: number };
    const questionRow = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND is_question = 1')
      .get(roomId) as { count: number };
    const likeRow = db.prepare('SELECT SUM(count) as total, COUNT(DISTINCT user_id) as users FROM likes WHERE room_id = ?')
      .get(roomId) as { total: number; users: number };
    const rewardRow = db.prepare('SELECT SUM(amount) as total, COUNT(*) as count, COUNT(DISTINCT user_id) as users FROM rewards WHERE room_id = ?')
      .get(roomId) as { total: number; count: number; users: number };
    const muteRow = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM mutes WHERE room_id = ?')
      .get(roomId) as { count: number };
    const replayRow = db.prepare('SELECT id, duration, view_count FROM replays WHERE room_id = ?')
      .get(roomId) as any;

    const enrollments = enrollmentRow.count;
    const actualViewers = viewerRow.count;
    const totalWatchSeconds = durationRow.total || 0;
    const avgWatchSeconds = durationRow.users > 0 ? Math.floor(totalWatchSeconds / durationRow.users) : 0;
    const attendanceRate = enrollments > 0 ? Math.round((actualViewers / enrollments) * 10000) / 100 : 0;
    const totalInteractions = messageRow.count + (likeRow.total || 0) + rewardRow.count;

    return {
      room_id: roomId,
      title: room.title,
      cover_image: room.cover_image,
      teacher_id: room.teacher_id,
      teacher_name: room.teacher_name,
      start_time: room.start_time,
      end_time: room.end_time,
      status: room.status,
      has_replay: !!replayRow,
      stats: {
        enrollments,
        actual_viewers: actualViewers,
        attendance_rate: attendanceRate,
        total_watch_seconds: totalWatchSeconds,
        avg_watch_seconds: avgWatchSeconds,
        avg_watch_formatted: formatDuration(avgWatchSeconds),
        total_messages: messageRow.count,
        blocked_messages: blockedMsgRow.count,
        questions: questionRow.count,
        total_likes: likeRow.total || 0,
        like_users: likeRow.users || 0,
        total_rewards: rewardRow.total || 0,
        reward_count: rewardRow.count,
        reward_users: rewardRow.users || 0,
        total_interactions: totalInteractions,
        muted_users: muteRow.count,
        replay_views: replayRow?.view_count || 0,
        replay_duration: replayRow?.duration || 0,
      },
    };
  });

  const summary = {
    total_courses: totalRow.count,
    total_enrollments: courseStats.reduce((sum, c) => sum + c.stats.enrollments, 0),
    total_viewers: courseStats.reduce((sum, c) => sum + c.stats.actual_viewers, 0),
    total_messages: courseStats.reduce((sum, c) => sum + c.stats.total_messages, 0),
    total_likes: courseStats.reduce((sum, c) => sum + c.stats.total_likes, 0),
    total_rewards: courseStats.reduce((sum, c) => sum + c.stats.total_rewards, 0),
    total_interactions: courseStats.reduce((sum, c) => sum + c.stats.total_interactions, 0),
    total_replays: courseStats.filter(c => c.has_replay).length,
    avg_attendance_rate: courseStats.length > 0
      ? Math.round(courseStats.reduce((sum, c) => sum + c.stats.attendance_rate, 0) / courseStats.length * 100) / 100
      : 0,
  };

  if (format === 'csv') {
    const fileName = `course_report_${Date.now()}.csv`;
    const filePath = path.join(exportDir, fileName);

    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'room_id', title: '课程ID' },
        { id: 'title', title: '课程标题' },
        { id: 'teacher_name', title: '讲师' },
        { id: 'start_time', title: '开始时间' },
        { id: 'end_time', title: '结束时间' },
        { id: 'status', title: '状态' },
        { id: 'enrollments', title: '报名人数' },
        { id: 'actual_viewers', title: '到课人数' },
        { id: 'attendance_rate', title: '到课率(%)' },
        { id: 'avg_watch_formatted', title: '平均观看时长' },
        { id: 'total_messages', title: '消息数' },
        { id: 'blocked_messages', title: '违规消息数' },
        { id: 'questions', title: '提问数' },
        { id: 'total_likes', title: '点赞数' },
        { id: 'total_rewards', title: '打赏金额' },
        { id: 'reward_users', title: '打赏人数' },
        { id: 'muted_users', title: '禁言人数' },
        { id: 'has_replay', title: '是否有回放' },
      ],
    });

    const records = courseStats.map(c => ({
      room_id: c.room_id,
      title: c.title,
      teacher_name: c.teacher_name,
      start_time: new Date(c.start_time).toLocaleString('zh-CN'),
      end_time: new Date(c.end_time).toLocaleString('zh-CN'),
      status: c.status === 'scheduled' ? '未开始' : c.status === 'live' ? '直播中' : '已结束',
      enrollments: c.stats.enrollments,
      actual_viewers: c.stats.actual_viewers,
      attendance_rate: c.stats.attendance_rate,
      avg_watch_formatted: c.stats.avg_watch_formatted,
      total_messages: c.stats.total_messages,
      blocked_messages: c.stats.blocked_messages,
      questions: c.stats.questions,
      total_likes: c.stats.total_likes,
      total_rewards: c.stats.total_rewards,
      reward_users: c.stats.reward_users,
      muted_users: c.stats.muted_users,
      has_replay: c.has_replay ? '是' : '否',
    }));

    await csvWriter.writeRecords(records);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    fileStream.on('end', () => {
      fs.unlink(filePath, () => {});
    });
    return;
  }

  success(res, {
    list: courseStats,
    total: totalRow.count,
    page: pageNum,
    page_size: pageSize,
    has_more: pageNum * pageSize < totalRow.count,
    empty: totalRow.count === 0,
    summary,
  }, totalRow.count === 0 ? '暂无课程数据' : 'success');
});

router.get('/report/teachers', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { userId: currentUserId, role } = (req as any).user;
  const { start_date, end_date, format = 'json' } = req.query;

  let timeWhere = '';
  const timeParams: any[] = [];
  if (start_date) {
    timeWhere += ' AND lr.start_time >= ?';
    timeParams.push(Number(start_date));
  }
  if (end_date) {
    timeWhere += ' AND lr.start_time <= ?';
    timeParams.push(Number(end_date));
  }

  let teacherFilter = '';
  const teacherParams: any[] = [];
  if (role === 'teacher') {
    teacherFilter = ' AND u.id = ?';
    teacherParams.push(currentUserId);
  }

  const teachers = db.prepare(`
    SELECT u.id as teacher_id, u.username, u.nickname, u.avatar
    FROM users u
    WHERE u.role IN ('teacher', 'admin')${teacherFilter}
  `).all(...teacherParams) as any[];

  const teacherStats = teachers.map(t => {
    const roomStats = db.prepare(`
      SELECT
        COUNT(lr.id) as course_count,
        COALESCE(SUM(enroll.cnt), 0) as total_enrollments,
        COALESCE(SUM(viewer.cnt), 0) as total_viewers,
        COALESCE(SUM(ws_dur.total_duration), 0) as total_watch_seconds,
        COALESCE(SUM(ws_dur.viewer_count), 0) as total_viewer_count,
        COALESCE(SUM(msg.cnt), 0) as total_messages,
        COALESCE(SUM(blocked.cnt), 0) as total_blocked,
        COALESCE(SUM(like_total.cnt), 0) as total_likes,
        COALESCE(SUM(reward_total.amount), 0) as total_rewards,
        COALESCE(SUM(reward_total.cnt), 0) as total_reward_count,
        COALESCE(SUM(mute_total.cnt), 0) as total_muted
      FROM live_rooms lr
      LEFT JOIN (SELECT room_id, COUNT(*) as cnt FROM room_enrollments GROUP BY room_id) enroll ON enroll.room_id = lr.id
      LEFT JOIN (SELECT room_id, COUNT(DISTINCT user_id) as cnt FROM watch_sessions GROUP BY room_id) viewer ON viewer.room_id = lr.id
      LEFT JOIN (SELECT room_id, SUM(duration) as total_duration, COUNT(DISTINCT user_id) as viewer_count FROM watch_sessions GROUP BY room_id) ws_dur ON ws_dur.room_id = lr.id
      LEFT JOIN (SELECT room_id, COUNT(*) as cnt FROM chat_messages WHERE blocked = 0 GROUP BY room_id) msg ON msg.room_id = lr.id
      LEFT JOIN (SELECT room_id, COUNT(*) as cnt FROM chat_messages WHERE blocked = 1 GROUP BY room_id) blocked ON blocked.room_id = lr.id
      LEFT JOIN (SELECT room_id, SUM(count) as cnt FROM likes GROUP BY room_id) like_total ON like_total.room_id = lr.id
      LEFT JOIN (SELECT room_id, SUM(amount) as amount, COUNT(*) as cnt FROM rewards GROUP BY room_id) reward_total ON reward_total.room_id = lr.id
      LEFT JOIN (SELECT room_id, COUNT(DISTINCT user_id) as cnt FROM mutes GROUP BY room_id) mute_total ON mute_total.room_id = lr.id
      WHERE lr.teacher_id = ?${timeWhere}
    `).get(t.teacher_id, ...timeParams) as any;

    const courseCount = roomStats.course_count || 0;
    const totalEnrollments = roomStats.total_enrollments || 0;
    const totalViewers = roomStats.total_viewers || 0;
    const totalWatchSeconds = roomStats.total_watch_seconds || 0;
    const totalViewerCount = roomStats.total_viewer_count || 0;
    const avgWatchSeconds = totalViewerCount > 0 ? Math.floor(totalWatchSeconds / totalViewerCount) : 0;
    const attendanceRate = totalEnrollments > 0 ? Math.round((totalViewers / totalEnrollments) * 10000) / 100 : 0;
    const totalMessages = roomStats.total_messages || 0;
    const totalLikes = roomStats.total_likes || 0;
    const totalRewardCount = roomStats.total_reward_count || 0;
    const totalInteractions = totalMessages + totalLikes + totalRewardCount;

    return {
      teacher_id: t.teacher_id,
      username: t.username,
      nickname: t.nickname,
      avatar: t.avatar,
      stats: {
        course_count: courseCount,
        total_enrollments: totalEnrollments,
        total_viewers: totalViewers,
        attendance_rate: attendanceRate,
        total_watch_seconds: totalWatchSeconds,
        avg_watch_seconds: avgWatchSeconds,
        avg_watch_formatted: formatDuration(avgWatchSeconds),
        total_messages: totalMessages,
        total_blocked: roomStats.total_blocked || 0,
        total_likes: totalLikes,
        total_rewards: roomStats.total_rewards || 0,
        total_interactions: totalInteractions,
        total_muted: roomStats.total_muted || 0,
      },
    };
  });

  const nonEmptyTeachers = teacherStats.filter(t => t.stats.course_count > 0);

  const overallSummary = {
    total_teachers: nonEmptyTeachers.length,
    total_courses: nonEmptyTeachers.reduce((s, t) => s + t.stats.course_count, 0),
    total_enrollments: nonEmptyTeachers.reduce((s, t) => s + t.stats.total_enrollments, 0),
    total_viewers: nonEmptyTeachers.reduce((s, t) => s + t.stats.total_viewers, 0),
    total_interactions: nonEmptyTeachers.reduce((s, t) => s + t.stats.total_interactions, 0),
    total_rewards: nonEmptyTeachers.reduce((s, t) => s + t.stats.total_rewards, 0),
    avg_attendance_rate: nonEmptyTeachers.length > 0
      ? Math.round(nonEmptyTeachers.reduce((s, t) => s + t.stats.attendance_rate, 0) / nonEmptyTeachers.length * 100) / 100
      : 0,
  };

  if (format === 'csv') {
    const fileName = `teacher_report_${Date.now()}.csv`;
    const filePath = path.join(exportDir, fileName);
    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'teacher_id', title: '讲师ID' },
        { id: 'nickname', title: '讲师' },
        { id: 'course_count', title: '开课数' },
        { id: 'total_enrollments', title: '总报名' },
        { id: 'total_viewers', title: '总到课' },
        { id: 'attendance_rate', title: '到课率(%)' },
        { id: 'avg_watch_formatted', title: '平均观看' },
        { id: 'total_messages', title: '消息数' },
        { id: 'total_blocked', title: '违规消息' },
        { id: 'total_likes', title: '点赞数' },
        { id: 'total_rewards', title: '打赏金额' },
        { id: 'total_muted', title: '禁言人数' },
        { id: 'total_interactions', title: '互动总数' },
      ],
    });
    const records = nonEmptyTeachers.map(t => ({
      teacher_id: t.teacher_id,
      nickname: t.nickname || t.username,
      course_count: t.stats.course_count,
      total_enrollments: t.stats.total_enrollments,
      total_viewers: t.stats.total_viewers,
      attendance_rate: t.stats.attendance_rate,
      avg_watch_formatted: t.stats.avg_watch_formatted,
      total_messages: t.stats.total_messages,
      total_blocked: t.stats.total_blocked,
      total_likes: t.stats.total_likes,
      total_rewards: t.stats.total_rewards,
      total_muted: t.stats.total_muted,
      total_interactions: t.stats.total_interactions,
    }));
    (async () => {
      await csvWriter.writeRecords(records);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      fileStream.on('end', () => { fs.unlink(filePath, () => {}); });
    })();
    return;
  }

  success(res, {
    list: nonEmptyTeachers,
    summary: overallSummary,
    empty: nonEmptyTeachers.length === 0,
  }, nonEmptyTeachers.length === 0 ? '暂无讲师数据' : 'success');
});

router.get('/report/teachers/:teacherId/courses', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { teacherId } = req.params;
  const { userId: currentUserId, role } = (req as any).user;
  const { start_date, end_date, page = '1', page_size = '50' } = req.query;

  if (role === 'teacher' && teacherId !== currentUserId) {
    return error(res, '无权查看其他讲师的课程', 403);
  }

  let where = 'lr.teacher_id = ?';
  const params: any[] = [teacherId];

  if (start_date) {
    where += ' AND lr.start_time >= ?';
    params.push(Number(start_date));
  }
  if (end_date) {
    where += ' AND lr.start_time <= ?';
    params.push(Number(end_date));
  }

  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.min(200, Math.max(1, Number(page_size)));
  const offset = (pageNum - 1) * pageSize;

  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM live_rooms lr WHERE ${where}`)
    .get(...params) as { count: number };

  const rooms = db.prepare(`
    SELECT lr.*, u.nickname as teacher_name
    FROM live_rooms lr
    LEFT JOIN users u ON lr.teacher_id = u.id
    WHERE ${where}
    ORDER BY lr.start_time DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as any[];

  const courseStats = rooms.map(room => {
    const roomId = room.id;
    const enrollmentRow = db.prepare('SELECT COUNT(*) as count FROM room_enrollments WHERE room_id = ?')
      .get(roomId) as { count: number };
    const viewerRow = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM watch_sessions WHERE room_id = ?')
      .get(roomId) as { count: number };
    const durationRow = db.prepare('SELECT SUM(duration) as total, COUNT(DISTINCT user_id) as users FROM watch_sessions WHERE room_id = ?')
      .get(roomId) as { total: number; users: number };
    const messageRow = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND blocked = 0')
      .get(roomId) as { count: number };
    const blockedMsgRow = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND blocked = 1')
      .get(roomId) as { count: number };
    const likeRow = db.prepare('SELECT SUM(count) as total, COUNT(DISTINCT user_id) as users FROM likes WHERE room_id = ?')
      .get(roomId) as { total: number; users: number };
    const rewardRow = db.prepare('SELECT SUM(amount) as total, COUNT(*) as count, COUNT(DISTINCT user_id) as users FROM rewards WHERE room_id = ?')
      .get(roomId) as { total: number; count: number; users: number };
    const muteRow = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM mutes WHERE room_id = ?')
      .get(roomId) as { count: number };

    const enrollments = enrollmentRow.count;
    const actualViewers = viewerRow.count;
    const totalWatchSeconds = durationRow.total || 0;
    const avgWatchSeconds = (durationRow.users || 0) > 0 ? Math.floor(totalWatchSeconds / durationRow.users) : 0;
    const attendanceRate = enrollments > 0 ? Math.round((actualViewers / enrollments) * 10000) / 100 : 0;

    return {
      room_id: roomId,
      title: room.title,
      start_time: room.start_time,
      end_time: room.end_time,
      status: room.status,
      stats: {
        enrollments,
        actual_viewers: actualViewers,
        attendance_rate: attendanceRate,
        avg_watch_seconds: avgWatchSeconds,
        avg_watch_formatted: formatDuration(avgWatchSeconds),
        total_messages: messageRow.count,
        blocked_messages: blockedMsgRow.count,
        total_likes: likeRow.total || 0,
        total_rewards: rewardRow.total || 0,
        total_interactions: messageRow.count + (likeRow.total || 0) + rewardRow.count,
        muted_users: muteRow.count,
      },
    };
  });

  const teacher = db.prepare('SELECT id, username, nickname, avatar FROM users WHERE id = ?').get(teacherId);

  success(res, {
    teacher,
    list: courseStats,
    total: totalRow.count,
    page: pageNum,
    page_size: pageSize,
    has_more: pageNum * pageSize < totalRow.count,
    empty: totalRow.count === 0,
  }, totalRow.count === 0 ? '该讲师暂无课程数据' : 'success');
});

router.get('/report/teachers/:teacherId/profile', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { teacherId } = req.params;
  const { userId: currentUserId, role } = (req as any).user;

  if (role === 'teacher' && teacherId !== currentUserId) {
    return error(res, '无权查看其他讲师的画像', 403);
  }

  const teacher = db.prepare('SELECT id, username, nickname, avatar, created_at FROM users WHERE id = ?').get(teacherId) as any;
  if (!teacher) {
    return error(res, '讲师不存在', 404);
  }

  const rooms = db.prepare(`
    SELECT lr.id, lr.title, lr.start_time, lr.end_time, lr.status
    FROM live_rooms lr WHERE lr.teacher_id = ?
    ORDER BY lr.start_time DESC
  `).all(teacherId) as any[];

  const roomIdList = rooms.map(r => r.id);

  const recentActiveRooms = rooms
    .filter(r => r.status === 'live' || (r.end_time && r.end_time > Date.now() - 7 * 24 * 60 * 60 * 1000))
    .slice(0, 5)
    .map(r => {
      const viewerRow = db.prepare('SELECT COUNT(DISTINCT user_id) as cnt FROM watch_sessions WHERE room_id = ?').get(r.id) as { cnt: number };
      const msgRow = db.prepare('SELECT COUNT(*) as cnt FROM chat_messages WHERE room_id = ? AND blocked = 0').get(r.id) as { cnt: number };
      return {
        room_id: r.id,
        title: r.title,
        start_time: r.start_time,
        end_time: r.end_time,
        status: r.status,
        viewer_count: viewerRow.cnt,
        message_count: msgRow.cnt,
      };
    });

  let problemPeriods: any[] = [];
  let violationUserRanking: any[] = [];
  let topBlockedWords: any[] = [];

  if (roomIdList.length > 0) {
    const placeholders = roomIdList.map(() => '?').join(',');

    const hourRows = db.prepare(`
      SELECT 
        CAST((cm.created_at / 3600000) AS INTEGER) % 24 as hour_of_day,
        COUNT(*) as blocked_count
      FROM chat_messages cm
      WHERE cm.room_id IN (${placeholders}) AND cm.blocked = 1
      GROUP BY hour_of_day
      ORDER BY blocked_count DESC
    `).all(...roomIdList) as any[];
    problemPeriods = hourRows.slice(0, 5).map(h => ({
      hour: h.hour_of_day,
      label: `${h.hour_of_day}:00-${h.hour_of_day + 1}:00`,
      blocked_count: h.blocked_count,
    }));

    const violUsers = db.prepare(`
      SELECT 
        cm.user_id,
        u.username,
        u.nickname,
        COUNT(*) as blocked_count,
        MAX(cm.created_at) as last_blocked_at
      FROM chat_messages cm
      LEFT JOIN users u ON cm.user_id = u.id
      WHERE cm.room_id IN (${placeholders}) AND cm.blocked = 1
      GROUP BY cm.user_id
      ORDER BY blocked_count DESC
      LIMIT 10
    `).all(...roomIdList) as any[];
    violationUserRanking = violUsers;

    const blockedWords = db.prepare(`
      SELECT cm.blocked_reason, COUNT(*) as hit_count
      FROM chat_messages cm
      WHERE cm.room_id IN (${placeholders}) AND cm.blocked = 1 AND cm.blocked_reason IS NOT NULL
      GROUP BY cm.blocked_reason
      ORDER BY hit_count DESC
      LIMIT 10
    `).all(...roomIdList) as any[];
    topBlockedWords = blockedWords;
  }

  const totalCourses = rooms.length;
  const liveCourses = rooms.filter(r => r.status === 'live').length;
  const endedCourses = rooms.filter(r => r.status === 'ended').length;

  let totalEnrollments = 0;
  let totalViewers = 0;
  let totalBlocked = 0;
  let totalMuted = 0;

  if (roomIdList.length > 0) {
    const placeholders = roomIdList.map(() => '?').join(',');
    const enrollRow = db.prepare(`SELECT COUNT(*) as cnt FROM room_enrollments WHERE room_id IN (${placeholders})`).get(...roomIdList) as { cnt: number };
    const viewerRow = db.prepare(`SELECT COUNT(DISTINCT user_id) as cnt FROM watch_sessions WHERE room_id IN (${placeholders})`).get(...roomIdList) as { cnt: number };
    const blockedRow = db.prepare(`SELECT COUNT(*) as cnt FROM chat_messages WHERE room_id IN (${placeholders}) AND blocked = 1`).get(...roomIdList) as { cnt: number };
    const mutedRow = db.prepare(`SELECT COUNT(DISTINCT user_id) as cnt FROM mutes WHERE room_id IN (${placeholders})`).get(...roomIdList) as { cnt: number };
    totalEnrollments = enrollRow.cnt;
    totalViewers = viewerRow.cnt;
    totalBlocked = blockedRow.cnt;
    totalMuted = mutedRow.cnt;
  }

  success(res, {
    teacher,
    overview: {
      total_courses: totalCourses,
      live_courses: liveCourses,
      ended_courses: endedCourses,
      total_enrollments: totalEnrollments,
      total_viewers: totalViewers,
      total_blocked: totalBlocked,
      total_muted: totalMuted,
      risk_level: totalBlocked > 20 ? 'high' : totalBlocked > 5 ? 'medium' : 'low',
    },
    recent_active_courses: recentActiveRooms,
    problem_periods: problemPeriods,
    violation_user_ranking: violationUserRanking,
    top_blocked_words: topBlockedWords,
    empty: totalCourses === 0,
  }, totalCourses === 0 ? '该讲师暂无课程数据' : 'success');
});

router.get('/report/overview', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { userId: currentUserId, role } = (req as any).user;
  const { start_date, end_date, teacher_id, granularity = 'day' } = req.query;

  if (!start_date || !end_date) {
    return error(res, '请提供 start_date 和 end_date', 400);
  }

  const startTime = Number(start_date);
  const endTime = Number(end_date);

  let roomWhere = 'lr.start_time >= ? AND lr.start_time <= ?';
  const roomParams: any[] = [startTime, endTime];

  if (role === 'teacher') {
    roomWhere += ' AND lr.teacher_id = ?';
    roomParams.push(currentUserId);
  } else if (teacher_id) {
    roomWhere += ' AND lr.teacher_id = ?';
    roomParams.push(teacher_id);
  }

  const rooms = db.prepare(`
    SELECT lr.id, lr.teacher_id, lr.start_time, lr.end_time, lr.status, u.nickname as teacher_name
    FROM live_rooms lr LEFT JOIN users u ON lr.teacher_id = u.id
    WHERE ${roomWhere}
    ORDER BY lr.start_time ASC
  `).all(...roomParams) as any[];

  const stepMs = granularity === 'week' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const stepLabel = granularity === 'week' ? 'week' : 'day';

  const buckets: number[] = [];
  let cursor = Math.floor(startTime / stepMs) * stepMs;
  const endBucket = Math.floor(endTime / stepMs) * stepMs;
  while (cursor <= endBucket) {
    buckets.push(cursor);
    cursor += stepMs;
  }

  const bucketIndex = (ts: number) => {
    const idx = Math.floor((ts - buckets[0]) / stepMs);
    return Math.max(0, Math.min(idx, buckets.length - 1));
  };

  const bucketData = buckets.map(b => ({
    period_start: b,
    period_label: granularity === 'week'
      ? `${new Date(b).toLocaleDateString('zh-CN')} 周`
      : new Date(b).toLocaleDateString('zh-CN'),
    course_ids: new Set<string>(),
    teacher_ids: new Set<string>(),
    enrollments: 0,
    viewer_count: 0,
    total_watch_seconds: 0,
    watch_user_count: 0,
    messages: 0,
    blocked: 0,
    likes: 0,
    reward_amount: 0,
    reward_count: 0,
    muted_users: new Set<string>(),
  }));

  const roomIdList = rooms.map(r => r.id);
  const roomPeriodMap = new Map<string, number>();
  for (const room of rooms) {
    const idx = bucketIndex(room.start_time);
    roomPeriodMap.set(room.id, idx);
    bucketData[idx].course_ids.add(room.id);
    bucketData[idx].teacher_ids.add(room.teacher_id);
  }

  if (roomIdList.length > 0) {
    const placeholders = roomIdList.map(() => '?').join(',');

    const enrollRows = db.prepare(`
      SELECT room_id, COUNT(*) as cnt FROM room_enrollments WHERE room_id IN (${placeholders}) GROUP BY room_id
    `).all(...roomIdList) as any[];
    for (const e of enrollRows) {
      const idx = roomPeriodMap.get(e.room_id);
      if (idx !== undefined) bucketData[idx].enrollments += e.cnt;
    }

    const viewerRows = db.prepare(`
      SELECT room_id, COUNT(DISTINCT user_id) as cnt FROM watch_sessions WHERE room_id IN (${placeholders}) GROUP BY room_id
    `).all(...roomIdList) as any[];
    for (const v of viewerRows) {
      const idx = roomPeriodMap.get(v.room_id);
      if (idx !== undefined) {
        bucketData[idx].viewer_count += v.cnt;
      }
    }

    const durRows = db.prepare(`
      SELECT room_id, SUM(duration) as total_dur, COUNT(DISTINCT user_id) as user_cnt FROM watch_sessions WHERE room_id IN (${placeholders}) GROUP BY room_id
    `).all(...roomIdList) as any[];
    for (const d of durRows) {
      const idx = roomPeriodMap.get(d.room_id);
      if (idx !== undefined) {
        bucketData[idx].total_watch_seconds += d.total_dur || 0;
        bucketData[idx].watch_user_count += d.user_cnt || 0;
      }
    }

    const msgRows = db.prepare(`
      SELECT room_id, SUM(CASE WHEN blocked = 0 THEN 1 ELSE 0 END) as msg_cnt, SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) as blocked_cnt FROM chat_messages WHERE room_id IN (${placeholders}) GROUP BY room_id
    `).all(...roomIdList) as any[];
    for (const m of msgRows) {
      const idx = roomPeriodMap.get(m.room_id);
      if (idx !== undefined) {
        bucketData[idx].messages += m.msg_cnt || 0;
        bucketData[idx].blocked += m.blocked_cnt || 0;
      }
    }

    const likeRows = db.prepare(`
      SELECT room_id, SUM(count) as total_cnt FROM likes WHERE room_id IN (${placeholders}) GROUP BY room_id
    `).all(...roomIdList) as any[];
    for (const l of likeRows) {
      const idx = roomPeriodMap.get(l.room_id);
      if (idx !== undefined) bucketData[idx].likes += l.total_cnt || 0;
    }

    const rewardRows = db.prepare(`
      SELECT room_id, SUM(amount) as total_amt, COUNT(*) as cnt FROM rewards WHERE room_id IN (${placeholders}) GROUP BY room_id
    `).all(...roomIdList) as any[];
    for (const r of rewardRows) {
      const idx = roomPeriodMap.get(r.room_id);
      if (idx !== undefined) {
        bucketData[idx].reward_amount += r.total_amt || 0;
        bucketData[idx].reward_count += r.cnt || 0;
      }
    }

    const muteRows = db.prepare(`
      SELECT room_id, GROUP_CONCAT(DISTINCT user_id) as user_ids FROM mutes WHERE room_id IN (${placeholders}) GROUP BY room_id
    `).all(...roomIdList) as any[];
    for (const m of muteRows) {
      const idx = roomPeriodMap.get(m.room_id);
      if (idx !== undefined && m.user_ids) {
        for (const uid of m.user_ids.split(',')) {
          bucketData[idx].muted_users.add(uid);
        }
      }
    }
  }

  const timeline = bucketData
    .filter(b => b.course_ids.size > 0)
    .map(b => {
      const viewerCount = b.viewer_count || b.watch_user_count;
      const avgWatch = viewerCount > 0 ? Math.floor(b.total_watch_seconds / viewerCount) : 0;
      const attendanceRate = b.enrollments > 0 ? Math.round((viewerCount / b.enrollments) * 10000) / 100 : 0;
      return {
        period: b.period_label,
        period_start: b.period_start,
        course_count: b.course_ids.size,
        teacher_count: b.teacher_ids.size,
        enrollment_count: b.enrollments,
        viewer_count: viewerCount,
        attendance_rate: attendanceRate,
        avg_watch_seconds: avgWatch,
        avg_watch_formatted: formatDuration(avgWatch),
        message_count: b.messages,
        blocked_count: b.blocked,
        like_count: b.likes,
        reward_count: b.reward_count,
        reward_amount: b.reward_amount,
        muted_user_count: b.muted_users.size,
        interaction_count: b.messages + b.likes + b.reward_count,
      };
    });

  const totalEnrollments = timeline.reduce((s, t) => s + t.enrollment_count, 0);
  const totalViewers = timeline.reduce((s, t) => s + t.viewer_count, 0);
  const totalMessages = timeline.reduce((s, t) => s + t.message_count, 0);
  const totalLikes = timeline.reduce((s, t) => s + t.like_count, 0);
  const totalRewardAmount = timeline.reduce((s, t) => s + t.reward_amount, 0);
  const totalInteractions = timeline.reduce((s, t) => s + t.interaction_count, 0);
  const totalBlocked = timeline.reduce((s, t) => s + t.blocked_count, 0);
  const totalMuted = timeline.reduce((s, t) => s + t.muted_user_count, 0);
  const avgAttendanceRate = timeline.length > 0
    ? Math.round(timeline.reduce((s, t) => s + t.attendance_rate, 0) / timeline.length * 100) / 100
    : 0;

  success(res, {
    granularity: stepLabel,
    start_time: startTime,
    end_time: endTime,
    total_periods: timeline.length,
    empty: timeline.length === 0,
    summary: {
      total_courses: rooms.length,
      total_enrollments: totalEnrollments,
      total_viewers: totalViewers,
      avg_attendance_rate: avgAttendanceRate,
      total_messages: totalMessages,
      total_likes: totalLikes,
      total_reward_amount: totalRewardAmount,
      total_interactions: totalInteractions,
      total_blocked: totalBlocked,
      total_muted: totalMuted,
    },
    timeline,
  }, timeline.length === 0 ? '暂无运营数据' : 'success');
});

const exportTaskRunners: Record<string, (params: any, filePath: string) => Promise<void>> = {};

exportTaskRunners['course_report'] = async (params: any, filePath: string) => {
  const { teacher_id, start_date, end_date, status, created_by_role, created_by_id } = params;
  let where = '1=1';
  const sqlParams: any[] = [];
  if (created_by_role === 'teacher') {
    where += ' AND lr.teacher_id = ?';
    sqlParams.push(created_by_id);
  } else if (teacher_id) {
    where += ' AND lr.teacher_id = ?';
    sqlParams.push(teacher_id);
  }
  if (start_date) { where += ' AND lr.start_time >= ?'; sqlParams.push(Number(start_date)); }
  if (end_date) { where += ' AND lr.start_time <= ?'; sqlParams.push(Number(end_date)); }
  if (status) { where += ' AND lr.status = ?'; sqlParams.push(status); }

  const rooms = db.prepare(`
    SELECT lr.*, u.nickname as teacher_name
    FROM live_rooms lr LEFT JOIN users u ON lr.teacher_id = u.id
    WHERE ${where} ORDER BY lr.start_time DESC
  `).all(...sqlParams) as any[];

  const csvWriter = createObjectCsvWriter({
    path: filePath,
    header: [
      { id: 'room_id', title: '课程ID' },
      { id: 'title', title: '课程标题' },
      { id: 'teacher_name', title: '讲师' },
      { id: 'start_time', title: '开始时间' },
      { id: 'end_time', title: '结束时间' },
      { id: 'status', title: '状态' },
      { id: 'enrollments', title: '报名人数' },
      { id: 'actual_viewers', title: '到课人数' },
      { id: 'attendance_rate', title: '到课率(%)' },
      { id: 'avg_watch_formatted', title: '平均观看时长' },
      { id: 'total_messages', title: '消息数' },
      { id: 'blocked_messages', title: '违规消息数' },
      { id: 'total_likes', title: '点赞数' },
      { id: 'total_rewards', title: '打赏金额' },
      { id: 'muted_users', title: '禁言人数' },
    ],
  });

  const records = rooms.map(room => {
    const roomId = room.id;
    const enrollmentRow = db.prepare('SELECT COUNT(*) as count FROM room_enrollments WHERE room_id = ?').get(roomId) as { count: number };
    const viewerRow = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM watch_sessions WHERE room_id = ?').get(roomId) as { count: number };
    const durationRow = db.prepare('SELECT SUM(duration) as total, COUNT(DISTINCT user_id) as users FROM watch_sessions WHERE room_id = ?').get(roomId) as { total: number; users: number };
    const messageRow = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND blocked = 0').get(roomId) as { count: number };
    const blockedMsgRow = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE room_id = ? AND blocked = 1').get(roomId) as { count: number };
    const likeRow = db.prepare('SELECT SUM(count) as total FROM likes WHERE room_id = ?').get(roomId) as { total: number };
    const rewardRow = db.prepare('SELECT SUM(amount) as total FROM rewards WHERE room_id = ?').get(roomId) as { total: number };
    const muteRow = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM mutes WHERE room_id = ?').get(roomId) as { count: number };
    const avgWatchSeconds = (durationRow.users || 0) > 0 ? Math.floor((durationRow.total || 0) / durationRow.users) : 0;
    return {
      room_id: roomId,
      title: room.title,
      teacher_name: room.teacher_name,
      start_time: new Date(room.start_time).toLocaleString('zh-CN'),
      end_time: new Date(room.end_time).toLocaleString('zh-CN'),
      status: room.status === 'scheduled' ? '未开始' : room.status === 'live' ? '直播中' : '已结束',
      enrollments: enrollmentRow.count,
      actual_viewers: viewerRow.count,
      attendance_rate: enrollmentRow.count > 0 ? Math.round((viewerRow.count / enrollmentRow.count) * 10000) / 100 : 0,
      avg_watch_formatted: formatDuration(avgWatchSeconds),
      total_messages: messageRow.count,
      blocked_messages: blockedMsgRow.count,
      total_likes: likeRow.total || 0,
      total_rewards: rewardRow.total || 0,
      muted_users: muteRow.count,
    };
  });

  await csvWriter.writeRecords(records);
};

exportTaskRunners['teacher_report'] = async (params: any, filePath: string) => {
  const { start_date, end_date, created_by_role, created_by_id } = params;
  let teacherFilter = "u.role IN ('teacher', 'admin')";
  const teacherParams: any[] = [];
  if (created_by_role === 'teacher') {
    teacherFilter += ' AND u.id = ?';
    teacherParams.push(created_by_id);
  }
  const teachers = db.prepare(`SELECT u.id as teacher_id, u.username, u.nickname FROM users u WHERE ${teacherFilter}`)
    .all(...teacherParams) as any[];

  const csvWriter = createObjectCsvWriter({
    path: filePath,
    header: [
      { id: 'teacher_id', title: '讲师ID' },
      { id: 'nickname', title: '讲师' },
      { id: 'course_count', title: '开课数' },
      { id: 'total_enrollments', title: '总报名' },
      { id: 'total_viewers', title: '总到课' },
      { id: 'total_rewards', title: '打赏金额' },
      { id: 'total_muted', title: '禁言人数' },
    ],
  });

  const records = teachers.map(t => {
    let timeWhere = '';
    const timeParams: any[] = [t.teacher_id];
    if (start_date) { timeWhere += ' AND lr.start_time >= ?'; timeParams.push(Number(start_date)); }
    if (end_date) { timeWhere += ' AND lr.start_time <= ?'; timeParams.push(Number(end_date)); }
    const stats = db.prepare(`SELECT COUNT(lr.id) as course_count FROM live_rooms lr WHERE lr.teacher_id = ?${timeWhere}`)
      .get(...timeParams) as { course_count: number };
    return {
      teacher_id: t.teacher_id,
      nickname: t.nickname || t.username,
      course_count: stats.course_count || 0,
      total_enrollments: 0,
      total_viewers: 0,
      total_rewards: 0,
      total_muted: 0,
    };
  }).filter(r => r.course_count > 0);

  await csvWriter.writeRecords(records);
};

function runExportTask(taskId: string) {
  const task = db.prepare('SELECT * FROM export_tasks WHERE id = ?').get(taskId) as any;
  if (!task) return;

  const runner = exportTaskRunners[task.type];
  if (!runner) {
    db.prepare('UPDATE export_tasks SET status = ?, error = ? WHERE id = ?')
      .run('failed', `不支持的导出类型: ${task.type}`, taskId);
    return;
  }

  const fileName = `${task.type}_${taskId}_${Date.now()}.csv`;
  const filePath = path.join(exportDir, fileName);

  db.prepare('UPDATE export_tasks SET status = ?, started_at = ? WHERE id = ?')
    .run('processing', Date.now(), taskId);

  runner(JSON.parse(task.params || '{}'), filePath)
    .then(() => {
      const stat = fs.statSync(filePath);
      db.prepare('UPDATE export_tasks SET status = ?, file_path = ?, file_name = ?, file_size = ?, completed_at = ? WHERE id = ?')
        .run('completed', filePath, fileName, stat.size, Date.now(), taskId);
    })
    .catch((err: any) => {
      db.prepare('UPDATE export_tasks SET status = ?, error = ?, completed_at = ? WHERE id = ?')
        .run('failed', err.message || '导出失败', Date.now(), taskId);
    });
}

router.post('/tasks', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { userId, role } = (req as any).user;
  const { type, params } = req.body;

  if (!type) {
    return error(res, '请提供导出类型', 400);
  }

  if (!exportTaskRunners[type]) {
    return error(res, `不支持的导出类型: ${type}，支持: ${Object.keys(exportTaskRunners).join(', ')}`, 400);
  }

  const id = uuidv4();
  const now = Date.now();
  const taskParams = {
    ...(params || {}),
    created_by_role: role,
    created_by_id: userId,
  };

  db.prepare(`INSERT INTO export_tasks (id, type, params, status, created_by, created_by_role, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)`)
    .run(id, type, JSON.stringify(taskParams), userId, role, now);

  setImmediate(() => runExportTask(id));

  success(res, {
    task_id: id,
    type,
    status: 'pending',
    created_at: now,
  }, '导出任务已创建');
});

router.get('/tasks/:taskId', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { taskId } = req.params;
  const { userId, role } = (req as any).user;

  const task = db.prepare('SELECT * FROM export_tasks WHERE id = ?').get(taskId) as any;
  if (!task) {
    return error(res, '任务不存在', 404);
  }

  if (role !== 'admin' && task.created_by !== userId) {
    return error(res, '无权查看此任务', 403);
  }

  const result: any = {
    task_id: task.id,
    type: task.type,
    status: task.status,
    created_at: task.created_at,
    started_at: task.started_at,
    completed_at: task.completed_at,
  };

  if (task.status === 'completed') {
    result.file_name = task.file_name;
    result.file_size = task.file_size;
    result.download_url = `/api/export/tasks/${task.id}/download`;
  }

  if (task.status === 'failed') {
    result.error = task.error;
  }

  success(res, result);
});

router.get('/tasks/:taskId/download', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { taskId } = req.params;
  const { userId, role } = (req as any).user;

  const task = db.prepare('SELECT * FROM export_tasks WHERE id = ?').get(taskId) as any;
  if (!task) {
    return error(res, '任务不存在', 404);
  }

  if (role !== 'admin' && task.created_by !== userId) {
    return error(res, '无权下载此文件', 403);
  }

  if (task.status !== 'completed') {
    return error(res, '任务尚未完成', 400);
  }

  if (!task.file_path || !fs.existsSync(task.file_path)) {
    return error(res, '文件已过期或不存在', 404);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${task.file_name}"`);
  const fileStream = fs.createReadStream(task.file_path);
  fileStream.pipe(res);
});

router.get('/tasks', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
  const { userId, role } = (req as any).user;
  const { page = '1', page_size = '20', status } = req.query;

  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.min(100, Math.max(1, Number(page_size)));
  const offset = (pageNum - 1) * pageSize;

  let where = role === 'admin' ? '1=1' : 'created_by = ?';
  const params: any[] = role === 'admin' ? [] : [userId];

  if (status) {
    where += ' AND status = ?';
    params.push(status);
  }

  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM export_tasks WHERE ${where}`)
    .get(...params) as { count: number };

  const rows = db.prepare(`
    SELECT id, type, status, file_name, file_size, error, created_by, created_at, started_at, completed_at
    FROM export_tasks WHERE ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const list = (Array.isArray(rows) ? rows : []).map((row: any) => ({
    ...row,
    download_url: row.status === 'completed' ? `/api/export/tasks/${row.id}/download` : null,
  }));

  success(res, {
    list,
    total: totalRow.count,
    page: pageNum,
    page_size: pageSize,
    has_more: pageNum * pageSize < totalRow.count,
    empty: totalRow.count === 0,
  });
});

export default router;
