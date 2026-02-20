import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';

import { config } from './config';
import { handleWebSocketConnection } from './websocket/handler';
import { listAgentIds } from './services/agent-config';

// ── Express ─────────────────────────────────────────────────────────────────────
const app = express();

// CORS para rutas HTTP
const corsOrigin = config.allowedOrigins.includes('*') ? '*' : config.allowedOrigins;
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    agents: listAgentIds(),
  });
});

// ── HTTP server ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket server ────────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server,
  path: '/ws/voice',
  // Verificar origen para CORS en WebSocket
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

// ── Arrancar ────────────────────────────────────────────────────────────────────
server.listen(config.port, () => {
  console.log(`[Server] Listening on port ${config.port}`);
  console.log(`[Server] Health check → http://localhost:${config.port}/health`);
  console.log(`[Server] WebSocket    → ws://localhost:${config.port}/ws/voice`);
  console.log(`[Server] Agents available: ${listAgentIds().join(', ')}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────────────
function shutdown(signal: string): void {
  console.log(`\n[Server] ${signal} received. Shutting down...`);
  wss.close(() => {
    server.close(() => {
      console.log('[Server] Closed.');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
