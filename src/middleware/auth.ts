import { Request, Response, NextFunction } from 'express';
import { verifyToken, extractToken } from '../utils/jwt';
import { error } from '../utils/response';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req.headers.authorization);
  if (!token) {
    error(res, '未授权访问', 401, 401);
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    error(res, 'Token无效或已过期', 401, 401);
    return;
  }
  (req as any).user = payload;
  next();
}

export function teacherMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user;
  if (!user || (user.role !== 'teacher' && user.role !== 'admin')) {
    error(res, '需要讲师权限', 403, 403);
    return;
  }
  next();
}

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    error(res, '需要管理员权限', 403, 403);
    return;
  }
  next();
}
