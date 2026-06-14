import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { Server } from 'socket.io';
import './database';

import authRoutes from './routes/auth';
import roomRoutes from './routes/room';
import viewerRoutes from './routes/viewer';
import chatRoutes from './routes/chat';
import interactionRoutes from './routes/interaction';
import replayRoutes from './routes/replay';
import exportRoutes from './routes/export';
import { setupSocketIO } from './socket';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const uploadDir = path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
app.use('/uploads', express.static(uploadDir));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/viewer', viewerRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/interaction', interactionRoutes);
app.use('/api/replays', replayRoutes);
app.use('/api/export', exportRoutes);

app.use((_req, res) => {
  res.status(404).json({ code: 404, message: '接口不存在' });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('服务器错误:', err);
  res.status(500).json({ code: 500, message: '服务器内部错误' });
});

setupSocketIO(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 直播平台后端服务已启动`);
  console.log(`📍 HTTP服务: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`📊 健康检查: http://localhost:${PORT}/health`);
});

export default server;
