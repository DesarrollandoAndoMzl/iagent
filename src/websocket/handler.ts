import WebSocket from 'ws';
import type { IncomingMessage } from 'http';

import { loadAgentConfig, createGeminiBridge } from './gemini-bridge';
import { prisma } from '../lib/prisma';
import type { ClientMessage, GeminiBridge } from '../types';

// Costo estimado por minuto de audio (USD)
const COST_PER_MINUTE = 0.075;

interface TranscriptionEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

/**
 * Gestiona el ciclo de vida completo de una conexión WebSocket de un cliente.
 *
 * Mensajes entrantes esperados:
 *   { type: "start_session", agentId?: string }
 *   { type: "audio",         data: string }     ← PCM base64
 *   { type: "end_session" }
 */
export function handleWebSocketConnection(
  ws: WebSocket,
  req: IncomingMessage,
): void {
  const clientIp = req.socket.remoteAddress ?? 'unknown';
  console.log(`[WS] Client connected | ip=${clientIp}`);

  let bridge: GeminiBridge | null = null;
  let callSessionId: string | null = null;
  let sessionStartTime: Date | null = null;
  const transcription: TranscriptionEntry[] = [];

  // ── Recepción de mensajes ───────────────────────────────────────────────────
  ws.on('message', async (rawData: WebSocket.RawData) => {
    let message: ClientMessage;

    // 1. Parsear JSON
    try {
      message = JSON.parse(rawData.toString()) as ClientMessage;
    } catch {
      sendError(ws, 'Invalid JSON message');
      return;
    }

    // 2. Dispatch según el tipo
    switch (message.type) {
      // ── Iniciar sesión con Gemini ───────────────────────────────────────────
      case 'start_session': {
        // Si no se envía agentId, usar el primer agente activo de la DB
        let agentId = message.agentId;
        if (!agentId) {
          const firstAgent = await prisma.agent.findFirst({
            where: { isActive: true },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          });
          if (!firstAgent) {
            sendError(ws, 'No active agents found');
            return;
          }
          agentId = firstAgent.id;
        }

        const agentConfig = await loadAgentConfig(agentId);
        if (!agentConfig) {
          sendError(ws, `Agent "${agentId}" not found`);
          return;
        }

        // Cerrar sesión previa si existía
        if (bridge) {
          console.log(`[WS] Closing previous session before starting new one`);
          await closeSession(bridge, callSessionId, sessionStartTime, transcription);
          bridge = null;
          callSessionId = null;
          sessionStartTime = null;
          transcription.length = 0;
        }

        try {
          // Crear registro CallSession en DB
          const callSession = await prisma.callSession.create({
            data: { agentId, status: 'active' },
          });
          callSessionId = callSession.id;
          sessionStartTime = new Date();

          console.log(`[WS] Starting session | agent=${agentId} session=${callSessionId}`);
          bridge = await createGeminiBridge(ws, agentConfig);
        } catch (err) {
          console.error('[WS] Failed to create Gemini bridge:', err);
          sendError(ws, 'Failed to connect to Gemini Live API');
        }
        break;
      }

      // ── Reenviar audio a Gemini ─────────────────────────────────────────────
      case 'audio': {
        if (!bridge) {
          sendError(ws, 'No active session. Send start_session first.');
          return;
        }
        if (!message.data) {
          sendError(ws, 'Audio message missing "data" field');
          return;
        }
        bridge.sendAudio(message.data);
        break;
      }

      // ── Finalizar sesión ────────────────────────────────────────────────────
      case 'end_session': {
        if (bridge) {
          await closeSession(bridge, callSessionId, sessionStartTime, transcription);
          bridge = null;
          callSessionId = null;
          sessionStartTime = null;
          transcription.length = 0;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'session_ended' }));
        }
        break;
      }

      default: {
        sendError(ws, `Unknown message type: "${(message as ClientMessage).type}"`);
      }
    }
  });

  // ── Cliente desconectado ────────────────────────────────────────────────────
  ws.on('close', async (code, reason) => {
    console.log(
      `[WS] Client disconnected | ip=${clientIp} code=${code} reason=${reason.toString()}`,
    );
    if (bridge) {
      await closeSession(bridge, callSessionId, sessionStartTime, transcription);
      bridge = null;
    }
  });

  // ── Error de transporte ─────────────────────────────────────────────────────
  ws.on('error', async (err) => {
    console.error(`[WS] Socket error | ip=${clientIp}:`, err.message);
    if (bridge) {
      await closeSession(bridge, callSessionId, sessionStartTime, transcription, 'error');
      bridge = null;
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

async function closeSession(
  bridge: GeminiBridge,
  callSessionId: string | null,
  startTime: Date | null,
  transcription: TranscriptionEntry[],
  status: 'completed' | 'error' = 'completed',
): Promise<void> {
  bridge.close();

  if (!callSessionId) return;

  const endedAt = new Date();
  const durationSeconds =
    startTime ? Math.round((endedAt.getTime() - startTime.getTime()) / 1000) : 0;
  const estimatedCost = Math.round((durationSeconds / 60) * COST_PER_MINUTE * 10000) / 10000;

  try {
    await prisma.callSession.update({
      where: { id: callSessionId },
      data: {
        endedAt,
        durationSeconds,
        estimatedCost,
        status,
        transcription: transcription.length > 0 ? JSON.stringify(transcription) : null,
      },
    });
    console.log(
      `[WS] Session ${callSessionId} saved | duration=${durationSeconds}s cost=$${estimatedCost}`,
    );
  } catch (err) {
    console.error('[WS] Failed to update CallSession:', err);
  }
}

function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message }));
  }
}
