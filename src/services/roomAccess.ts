import db from '../database';
import { LiveRoom } from '../types';

export interface RoomAccessResult {
  allowed: boolean;
  reason?: string;
  code?: number;
  room?: LiveRoom;
}

export interface MuteInfo {
  id: string;
  room_id: string;
  user_id: string;
  mute_until: number;
  reason?: string;
  created_by: string;
  created_at: number;
}

export function checkRoomAccess(
  roomId: string,
  userId: string,
  userRole: string,
  watchToken?: string
): RoomAccessResult {
  const room = db.prepare('SELECT * FROM live_rooms WHERE id = ?').get(roomId) as LiveRoom | undefined;

  if (!room) {
    return { allowed: false, reason: '直播间不存在', code: 404 };
  }

  if (room.status === 'ended') {
    return { allowed: false, reason: '直播已结束', code: 400, room };
  }

  if (userRole !== 'admin' && userRole !== 'teacher') {
    if (room.watch_token && watchToken !== room.watch_token) {
      return { allowed: false, reason: '观看令牌无效', code: 403, room };
    }

    if (!room.allow_guest) {
      const enrolled = db.prepare('SELECT id FROM room_enrollments WHERE room_id = ? AND user_id = ?')
        .get(roomId, userId);
      if (!enrolled) {
        return { allowed: false, reason: '您未报名此课程，无法进入', code: 403, room };
      }
    }

    const onlineCount = getOnlineCount(roomId);
    if (room.max_viewers > 0 && onlineCount >= room.max_viewers) {
      return { allowed: false, reason: '直播间人数已满', code: 400, room };
    }
  }

  return { allowed: true, room };
}

const onlineUsersCache: Map<string, Set<string>> = new Map();

export function getOnlineCount(roomId: string): number {
  return onlineUsersCache.get(roomId)?.size || 0;
}

export function addOnlineUser(roomId: string, userId: string): number {
  if (!onlineUsersCache.has(roomId)) {
    onlineUsersCache.set(roomId, new Set());
  }
  onlineUsersCache.get(roomId)!.add(userId);
  return onlineUsersCache.get(roomId)!.size;
}

export function removeOnlineUser(roomId: string, userId: string): number {
  if (onlineUsersCache.has(roomId)) {
    onlineUsersCache.get(roomId)!.delete(userId);
    return onlineUsersCache.get(roomId)!.size;
  }
  return 0;
}

export function isUserOnline(roomId: string, userId: string): boolean {
  return onlineUsersCache.get(roomId)?.has(userId) || false;
}

export function isUserMuted(roomId: string, userId: string): boolean {
  const now = Date.now();
  const mute = db.prepare(
    'SELECT * FROM mutes WHERE room_id = ? AND user_id = ? AND mute_until > ?'
  ).get(roomId, userId, now);
  return !!mute;
}

export function getMuteInfo(roomId: string, userId: string): MuteInfo | null {
  const now = Date.now();
  const mute = db.prepare(
    'SELECT * FROM mutes WHERE room_id = ? AND user_id = ? AND mute_until > ? ORDER BY mute_until DESC LIMIT 1'
  ).get(roomId, userId, now);
  return (mute as MuteInfo) || null;
}

export function muteUser(
  roomId: string,
  userId: string,
  durationMinutes: number,
  reason: string,
  operatorId: string
): MuteInfo {
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();
  const now = Date.now();
  const muteUntil = now + durationMinutes * 60 * 1000;

  db.prepare(`INSERT INTO mutes 
    (id, room_id, user_id, mute_until, reason, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, roomId, userId, muteUntil, reason, operatorId, now);

  return {
    id,
    room_id: roomId,
    user_id: userId,
    mute_until: muteUntil,
    reason,
    created_by: operatorId,
    created_at: now,
  };
}

export function unmuteUser(roomId: string, userId: string): void {
  const now = Date.now();
  db.prepare('UPDATE mutes SET mute_until = ? WHERE room_id = ? AND user_id = ? AND mute_until > ?')
    .run(now, roomId, userId, now);
}

export { onlineUsersCache };
