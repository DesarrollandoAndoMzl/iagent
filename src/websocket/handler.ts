import WebSocket from 'ws';
import type { IncomingMessage } from 'http';

import { getAgentConfig } from '../services/agent-config';
import { createGeminiBridge } from './gemini-bridge';
import type { ClientMessage, GeminiBridge } from '../types';

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
        const agentId = message.agentId ?? 'default';
        const agentConfig = getAgentConfig(agentId);

        if (!agentConfig) {
          sendError(ws, `Agent "${agentId}" not found`);
          return;
        }

        // Cerrar sesión previa si existía
        if (bridge) {
          console.log(`[WS] Closing previous session before starting new one`);
          bridge.close();
          bridge = null;
        }

        try {
          console.log(`[WS] Starting session | agent=${agentId}`);
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
          bridge.close();
          bridge = null;
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
  ws.on('close', (code, reason) => {
    console.log(
      `[WS] Client disconnected | ip=${clientIp} code=${code} reason=${reason.toString()}`,
    );
    if (bridge) {
      bridge.close();
      bridge = null;
    }
  });

  // ── Error de transporte ─────────────────────────────────────────────────────
  ws.on('error', (err) => {
    console.error(`[WS] Socket error | ip=${clientIp}:`, err.message);
    if (bridge) {
      bridge.close();
      bridge = null;
    }
  });
}

// ── Helper ──────────────────────────────────────────────────────────────────────
function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message }));
  }
}
