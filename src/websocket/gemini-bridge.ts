import { GoogleGenAI, Modality } from '@google/genai';
import type { LiveServerMessage } from '@google/genai';
import WebSocket from 'ws';

import { config } from '../config';
import { prisma } from '../lib/prisma';
import type { AgentConfig, GeminiBridge, ServerMessage } from '../types';

// ── Cliente Gemini (singleton por proceso) ──────────────────────────────────────
const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

// ── Modelo usado para Native Audio ─────────────────────────────────────────────
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

/**
 * Carga la configuración del agente desde la DB, incluyendo documentos de
 * conocimiento globales y propios del agente, y devuelve un AgentConfig listo
 * para usar en Gemini.
 */
export async function loadAgentConfig(agentId: string): Promise<AgentConfig | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId, isActive: true },
  });

  if (!agent) return null;

  // Obtener documentos de conocimiento: globales + propios del agente
  const docs = await prisma.knowledgeDoc.findMany({
    where: {
      OR: [{ isGlobal: true }, { agentId }],
    },
  });

  let systemInstruction = agent.systemPrompt;

  if (docs.length > 0) {
    const docsText = docs
      .map((d: { filename: string; content: string }) => `[${d.filename}]\n${d.content}`)
      .join('\n---\n');
    systemInstruction +=
      `\n\n--- BASE DE CONOCIMIENTO ---\n${docsText}\n--- FIN BASE DE CONOCIMIENTO ---`;
  }

  return {
    id: agent.id,
    name: agent.name,
    systemInstruction,
    voiceName: agent.voiceName,
    language: agent.language,
    temperature: agent.temperature,
    topP: agent.topP,
    topK: agent.topK,
    maxOutputTokens: agent.maxOutputTokens,
    enableAffectiveDialog: agent.enableAffectiveDialog,
    enableProactiveAudio: agent.enableProactiveAudio,
    thinkingBudget: agent.thinkingBudget,
    vadSensitivity: agent.vadSensitivity,
    inputSampleRate: 16000,
  };
}

/**
 * Crea un puente bidireccional entre el cliente WebSocket y la Gemini Live API.
 *
 * Flujo de audio:
 *   Cliente (PCM 16 kHz base64) → sendAudio() → Gemini Live API
 *   Gemini Live API             → onmessage()  → Cliente (PCM base64)
 */
export async function createGeminiBridge(
  clientWs: WebSocket,
  agentConfig: AgentConfig,
): Promise<GeminiBridge> {
  let isClosed = false;

  // Helper: envía un mensaje JSON al cliente si la conexión sigue abierta
  const sendToClient = (msg: ServerMessage): void => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(msg));
    }
  };

  // ── Construir system prompt (con sufijo de idioma si aplica) ─────────────────
  let systemPromptText = agentConfig.systemInstruction;
  if (agentConfig.language === 'es') {
    systemPromptText +=
      '\n\nIMPORTANTE: RESPONDE EN ESPAÑOL. DEBES RESPONDER INEQUÍVOCAMENTE EN ESPAÑOL.';
  }
  console.log('[Gemini] System prompt (full):', systemPromptText);

  // ── Conectar con Gemini Live API ──────────────────────────────────────────────
  const liveConfig = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: systemPromptText }] },
    // Transcripciones
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Voz
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: agentConfig.voiceName,
        },
      },
    },
    // Parámetros de generación
    temperature: agentConfig.temperature,
    topP: agentConfig.topP,
    topK: agentConfig.topK,
    maxOutputTokens: agentConfig.maxOutputTokens,
  };

  console.log('[Gemini] Full config:', JSON.stringify(liveConfig, null, 2));

  let session = await ai.live.connect({
    model: LIVE_MODEL,
    config: liveConfig,
    callbacks: {
      onopen(): void {
        console.log(
          `[Gemini] Session opened | agent=${agentConfig.id} voice=${agentConfig.voiceName}`,
        );
        sendToClient({ type: 'session_started', agentId: agentConfig.id });
      },

      onmessage(message: LiveServerMessage): void {
        // Audio generado por Gemini
        const parts = message.serverContent?.modelTurn?.parts ?? [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            sendToClient({
              type: 'audio',
              data: part.inlineData.data,
              mimeType: part.inlineData.mimeType ?? 'audio/pcm;rate=24000',
            });
          }
        }

        // Señal de fin de turno (Gemini terminó de hablar)
        if (message.serverContent?.turnComplete) {
          sendToClient({ type: 'turn_complete' });
        }
      },

      onerror(error: ErrorEvent): void {
        console.error('[Gemini] Session error:', error.message ?? error);
        sendToClient({ type: 'error', message: 'Gemini session error' });
      },

      onclose(event: CloseEvent): void {
        console.log(`[Gemini] Session closed | code=${event.code} reason=${event.reason}`);
        if (!isClosed) {
          sendToClient({ type: 'session_ended' });
        }
      },
    },
  });

  // Enviar el prompt inicial DESPUÉS de que session esté asignada
  setTimeout(() => {
    try {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: 'Inicia la conversación ahora. Saluda al cliente.' }] }],
        turnComplete: true,
      });
      console.log('[Gemini] Sent initial prompt to start conversation');
    } catch (e) {
      console.error('[Gemini] Error sending initial prompt:', e);
    }
  }, 100);

  // ── API pública del bridge ────────────────────────────────────────────────────
  return {
    /**
     * Reenvía un chunk de audio PCM (base64) a Gemini.
     * El audio debe ser PCM 16-bit mono a la frecuencia indicada en agentConfig.inputSampleRate.
     */
    sendAudio(base64Data: string): void {
      if (isClosed) return;
      const sampleRate = agentConfig.inputSampleRate ?? 16000;
      try {
        session.sendRealtimeInput({
          audio: {
            data: base64Data,
            mimeType: `audio/pcm;rate=${sampleRate}`,
          },
        });
      } catch (err) {
        console.error('[Gemini] Error sending audio chunk:', err);
      }
    },

    /** Cierra la sesión Gemini limpiamente. */
    close(): void {
      if (isClosed) return;
      isClosed = true;
      try {
        session.close();
      } catch (err) {
        console.error('[Gemini] Error closing session:', err);
      }
    },
  };
}
