import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import db from '../database';
import { success, error } from '../utils/response';
import { signToken } from '../utils/jwt';
import { authMiddleware } from '../middleware/auth';
import { User } from '../types';

const router = Router();

const registerSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6).max(100),
  nickname: z.string().optional(),
  role: z.enum(['viewer', 'teacher']).default('viewer'),
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

router.post('/register', async (req: Request, res: Response) => {
  const parseResult = registerSchema.safeParse(req.body);
  if (!parseResult.success) {
    return error(res, parseResult.error.errors[0].message, 400);
  }
  const { username, password, nickname, role } = parseResult.data;

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return error(res, '用户名已存在', 400);
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const id = uuidv4();
  const now = Date.now();

  db.prepare('INSERT INTO users (id, username, password, nickname, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, username, hashedPassword, nickname || username, role, now);

  const token = signToken({ userId: id, username, role });
  success(res, { token, user: { id, username, nickname: nickname || username, role } }, '注册成功');
});

router.post('/login', async (req: Request, res: Response) => {
  const parseResult = loginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return error(res, parseResult.error.errors[0].message, 400);
  }
  const { username, password } = parseResult.data;

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  if (!user) {
    return error(res, '用户名或密码错误', 400);
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return error(res, '用户名或密码错误', 400);
  }

  const token = signToken({ userId: user.id, username: user.username, role: user.role });
  success(res, {
    token,
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      role: user.role,
      avatar: user.avatar,
    },
  }, '登录成功');
});

router.get('/profile', authMiddleware, (req: Request, res: Response) => {
  const { userId } = (req as any).user;
  const user = db.prepare('SELECT id, username, nickname, role, avatar, created_at FROM users WHERE id = ?').get(userId);
  if (!user) {
    return error(res, '用户不存在', 404);
  }
  success(res, user);
});

export default router;
