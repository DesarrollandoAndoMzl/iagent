import express from 'express';
import cors from 'cors';
import http from 'http';
import fs from 'fs';
import { WebSocketServer } from 'ws';

import { config } from './config';
import { handleWebSocketConnection } from './websocket/handler';
import { prisma } from './lib/prisma';
import agentsRouter from './routes/agents';
import knowledgeRouter from './routes/knowledge';
import metricsRouter from './routes/metrics';

// ── Asegurar directorio de uploads ──────────────────────────────────────────────
const UPLOAD_DIR = '/tmp/uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ── Express ─────────────────────────────────────────────────────────────────────
const app = express();

// CORS para rutas HTTP
const corsOrigin = config.allowedOrigins.includes('*') ? '*' : config.allowedOrigins;
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// ── Rutas API ────────────────────────────────────────────────────────────────────
app.use('/api', agentsRouter);
app.use('/api', knowledgeRouter);
app.use('/api', metricsRouter);

// Health check
app.get('/health', async (_req, res) => {
  try {
    const agents = await prisma.agent.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      agents,
    });
  } catch {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), agents: [] });
  }
});

// ── HTTP server ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket server ────────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server,
  path: '/ws/voice',
  verifyClient({ origin }, cb) {
    const allowed = config.allowedOrigins;
    if (allowed.includes('*') || !origin || allowed.includes(origin)) {
      cb(true);
    } else {
      console.warn(`[WS] Rejected connection from origin: ${origin}`);
      cb(false, 403, 'Forbidden');
    }
  },
});

wss.on('connection', (ws, req) => {
  handleWebSocketConnection(ws, req);
});

wss.on('error', (err) => {
  console.error('[WSS] Server error:', err);
});

// ── Seed: crear agente default si la DB está vacía ──────────────────────────────
async function seedDefaultAgent(): Promise<void> {
  try {
    const count = await prisma.agent.count();
    if (count === 0) {
      const agent = await prisma.agent.create({
        data: {
          name: 'Asistente de Voz',
          description: 'Agente de voz por defecto',
          systemPrompt:
            'Eres un asistente de voz amigable y útil. Respondes en español de forma concisa y natural.',
          voiceName: 'Kore',
          language: 'es',
        },
      });
      console.log(`[Server] Default agent created | id=${agent.id}`);
    }
  } catch (err) {
    console.error('[Server] Seed error:', err);
  }
}

// ── Arrancar ────────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  await seedDefaultAgent();

  server.listen(config.port, () => {
    console.log(`[Server] Listening on port ${config.port}`);
    console.log(`[Server] Health check → http://localhost:${config.port}/health`);
    console.log(`[Server] WebSocket    → ws://localhost:${config.port}/ws/voice`);
    console.log(`[Server] REST API     → http://localhost:${config.port}/api`);
  });
}

start().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});

// ── Graceful shutdown ───────────────────────────────────────────────────────────
function shutdown(signal: string): void {
  console.log(`\n[Server] ${signal} received. Shutting down...`);
  wss.close(() => {
    server.close(async () => {
      await prisma.$disconnect();
      console.log('[Server] Closed.');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
