export interface User {
  id: string;
  username: string;
  password: string;
  nickname?: string;
  role: 'admin' | 'teacher' | 'viewer';
  avatar?: string;
  created_at: number;
}

export interface LiveRoom {
  id: string;
  title: string;
  description?: string;
  cover_image?: string;
  teacher_id: string;
  start_time: number;
  end_time: number;
  status: 'scheduled' | 'live' | 'ended';
  watch_token: string;
  max_viewers: number;
  allow_guest: number;
  created_at: number;
}

export interface RoomEnrollment {
  id: string;
  room_id: string;
  user_id: string;
  enrolled_at: number;
}

export interface WatchSession {
  id: string;
  room_id: string;
  user_id: string;
  join_time: number;
  leave_time?: number;
  duration: number;
}

export type MessageType = 'text' | 'emoji' | 'system';

export interface ChatMessage {
  id: string;
  room_id: string;
  user_id: string;
  user_nickname?: string;
  content: string;
  msg_type: MessageType;
  is_pinned: number;
  is_question: number;
  answer?: string;
  answered_by?: string;
  answered_at?: number;
  blocked: number;
  created_at: number;
}

export interface Like {
  id: string;
  room_id: string;
  user_id: string;
  count: number;
  created_at: number;
}

export interface Reward {
  id: string;
  room_id: string;
  user_id: string;
  user_nickname?: string;
  gift_type: string;
  amount: number;
  message?: string;
  created_at: number;
}

export interface Replay {
  id: string;
  room_id: string;
  title: string;
  video_url?: string;
  duration: number;
  view_count: number;
  created_at: number;
}

export interface BannedWord {
  id: string;
  word: string;
  created_at: number;
}

export interface JwtPayload {
  userId: string;
  username: string;
  role: string;
}

export interface ApiResponse<T = any> {
  code: number;
  message: string;
  data?: T;
}
