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

router.get('/:roomId/chat-messages', authMiddleware, teacherMiddleware, async (req: Request, res: Response) => {
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

router.get('/:roomId/questions', authMiddleware, teacherMiddleware, async (req: Request, res: Response) => {
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

router.get('/:roomId/viewers', authMiddleware, teacherMiddleware, async (req: Request, res: Response) => {
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

router.get('/:roomId/rewards', authMiddleware, teacherMiddleware, async (req: Request, res: Response) => {
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

router.get('/:roomId/summary', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
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

router.get('/:roomId/trends', authMiddleware, teacherMiddleware, (req: Request, res: Response) => {
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

  const trends = buckets.map((bucketStart, idx) => {
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
    empty: trends.length === 0 || trends.every(t => t.interactions === 0 && t.active_users === 0),
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
      peak_active_users: Math.max(...trends.map(t => t.active_users), 0),
      peak_interactions: Math.max(...trends.map(t => t.interactions), 0),
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

export default router;
