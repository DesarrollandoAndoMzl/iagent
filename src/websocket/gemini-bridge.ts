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
  let audioChunkCount = 0;

  // Helper: envía un mensaje JSON al cliente si la conexión sigue abierta
  const sendToClient = (msg: ServerMessage): void => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(msg));
    }
  };

  // ── Construir system prompt (con sufijo de idioma si aplica) ─────────────────
  let systemPromptText = agentConfig.systemInstruction;
  systemPromptText += '\n\nINSTRUCCIÓN CRÍTICA: Cuando la sesión inicie, saluda al cliente inmediatamente sin esperar a que hable primero. Comienza hablando tú.';
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

  const session = await ai.live.connect({
    model: LIVE_MODEL,
    config: liveConfig,
    callbacks: {
      onopen(): void {
        console.log('[Gemini] Session opened | time=' + Date.now());
        console.log(`[Gemini] Session opened | agent=${agentConfig.id} voice=${agentConfig.voiceName}`);
        sendToClient({ type: 'session_started', agentId: agentConfig.id });
      },

      onmessage(message: LiveServerMessage): void {
        const sc = message.serverContent;

        // Interrupción del agente por el usuario (patrón oficial Google)
        if (sc && sc.interrupted === true) {
          console.log('[Gemini] Agent interrupted by user');
          sendToClient({ type: 'interrupted' });
          return;
        }

        // Audio generado por Gemini
        if (sc && sc.modelTurn && sc.modelTurn.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData && part.inlineData.data) {
              audioChunkCount++;
              if (audioChunkCount === 1) console.log('[Gemini] First audio chunk | time=' + Date.now());
              if (audioChunkCount % 50 === 0) console.log('[Gemini] Audio chunks received:', audioChunkCount);
              sendToClient({
                type: 'audio',
                audio: part.inlineData.data,
              });
            }
          }
        }

        // Transcripción de entrada (voz del usuario)
        if (sc && sc.inputTranscription) {
          sendToClient({ type: 'transcript_input', text: sc.inputTranscription.text ?? '' });
        }

        // Transcripción de salida (voz del agente)
        if (sc && sc.outputTranscription) {
          sendToClient({ type: 'transcript_output', text: sc.outputTranscription.text ?? '' });
        }

        // Señal de fin de turno (Gemini terminó de hablar)
        if (sc && sc.turnComplete) {
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

  // Trigger 1: Enviar texto para que Gemini responda inmediatamente
  try {
    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: '.' }] }],
      turnComplete: true,
    });
    console.log('[Gemini] Sent text trigger for initial greeting');
  } catch (e) {
    console.error('[Gemini] Error sending text trigger:', e);
  }

  // Trigger 2: Enviar silencio para activar el canal de audio
  try {
    const silenceBuffer = Buffer.alloc(3200).toString('base64');
    session.sendRealtimeInput({
      audio: {
        data: silenceBuffer,
        mimeType: 'audio/pcm;rate=16000',
      },
    });
    console.log('[Gemini] Sent silence buffer');
  } catch (e) {
    console.error('[Gemini] Error sending silence:', e);
  }

  // ── API pública del bridge ────────────────────────────────────────────────────
  let micChunkCount = 0;

  return {
    /**
     * Reenvía un chunk de audio PCM (base64) a Gemini.
     * Gemini maneja el VAD internamente; enviamos audio de forma continua.
     */
    sendAudio(base64Data: string): void {
      if (isClosed) return;
      if (micChunkCount++ === 0) console.log('[Gemini] First mic chunk sent to Gemini');
      try {
        session.sendRealtimeInput({
          audio: {
            data: base64Data,
            mimeType: 'audio/pcm;rate=16000',
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
