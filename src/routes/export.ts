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

export default router;
