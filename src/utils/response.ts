import { Response } from 'express';
import { ApiResponse } from '../types';

export function success<T>(res: Response, data?: T, message = 'success'): void {
  const resp: ApiResponse<T> = { code: 0, message, data };
  res.json(resp);
}

export function error(res: Response, message: string, code = 1, status = 200): void {
  res.status(status).json({ code, message });
}
