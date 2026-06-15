import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbDir = path.dirname(process.env.DB_PATH || './data/live.db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db: Database.Database = new Database(process.env.DB_PATH || './data/live.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nickname TEXT,
    role TEXT NOT NULL DEFAULT 'viewer',
    avatar TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS live_rooms (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    cover_image TEXT,
    teacher_id TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    watch_token TEXT UNIQUE NOT NULL,
    max_viewers INTEGER DEFAULT 0,
    allow_guest INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (teacher_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS room_enrollments (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    enrolled_at INTEGER NOT NULL,
    UNIQUE (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES live_rooms(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS watch_sessions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    join_time INTEGER NOT NULL,
    leave_time INTEGER,
    duration INTEGER DEFAULT 0,
    FOREIGN KEY (room_id) REFERENCES live_rooms(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_nickname TEXT,
    content TEXT NOT NULL,
    original_content TEXT,
    blocked_reason TEXT,
    msg_type TEXT NOT NULL DEFAULT 'text',
    is_pinned INTEGER DEFAULT 0,
    is_question INTEGER DEFAULT 0,
    answer TEXT,
    answered_by TEXT,
    answered_at INTEGER,
    blocked INTEGER DEFAULT 0,
    handled INTEGER DEFAULT 0,
    handled_at INTEGER,
    handled_by TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES live_rooms(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS likes (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES live_rooms(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS rewards (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_nickname TEXT,
    gift_type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    message TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES live_rooms(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS replays (
    id TEXT PRIMARY KEY,
    room_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    video_url TEXT,
    duration INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES live_rooms(id)
  );

  CREATE TABLE IF NOT EXISTS banned_words (
    id TEXT PRIMARY KEY,
    word TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mutes (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    mute_until INTEGER NOT NULL,
    reason TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES live_rooms(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_mutes_room ON mutes(room_id);
  CREATE INDEX IF NOT EXISTS idx_mutes_user ON mutes(user_id);
  CREATE INDEX IF NOT EXISTS idx_mutes_active ON mutes(room_id, user_id, mute_until);

  CREATE INDEX IF NOT EXISTS idx_rooms_status ON live_rooms(status);
  CREATE INDEX IF NOT EXISTS idx_rooms_time ON live_rooms(start_time);
  CREATE INDEX IF NOT EXISTS idx_msgs_room ON chat_messages(room_id);
  CREATE INDEX IF NOT EXISTS idx_msgs_pinned ON chat_messages(room_id, is_pinned);
  CREATE INDEX IF NOT EXISTS idx_sessions_room ON watch_sessions(room_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON watch_sessions(user_id);
`);

const initBannedWords = db.prepare('SELECT COUNT(*) as count FROM banned_words');
const result = initBannedWords.get() as { count: number };
if (result.count === 0) {
  const insertWord = db.prepare('INSERT INTO banned_words (id, word, created_at) VALUES (?, ?, ?)');
  const defaultWords = ['傻逼', '操', '草', '他妈', '狗日', '垃圾'];
  const now = Date.now();
  const { v4: uuidv4 } = require('uuid');
  for (const word of defaultWords) {
    insertWord.run(uuidv4(), word, now);
  }
}

function columnExists(table: string, column: string): boolean {
  try {
    const row = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    return row.some(c => c.name === column);
  } catch {
    return false;
  }
}

if (!columnExists('chat_messages', 'original_content')) {
  db.prepare('ALTER TABLE chat_messages ADD COLUMN original_content TEXT').run();
}
if (!columnExists('chat_messages', 'blocked_reason')) {
  db.prepare('ALTER TABLE chat_messages ADD COLUMN blocked_reason TEXT').run();
}
if (!columnExists('chat_messages', 'handled')) {
  db.prepare('ALTER TABLE chat_messages ADD COLUMN handled INTEGER DEFAULT 0').run();
}
if (!columnExists('chat_messages', 'handled_at')) {
  db.prepare('ALTER TABLE chat_messages ADD COLUMN handled_at INTEGER').run();
}
if (!columnExists('chat_messages', 'handled_by')) {
  db.prepare('ALTER TABLE chat_messages ADD COLUMN handled_by TEXT').run();
}

export default db;
