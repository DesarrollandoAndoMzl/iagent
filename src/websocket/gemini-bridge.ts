import { GoogleGenAI, Modality } from '@google/genai';
import type { LiveServerMessage } from '@google/genai';
import WebSocket from 'ws';

import { config } from '../config';
import { prisma } from '../lib/prisma';
import type { AgentConfig, GeminiBridge, ServerMessage } from '../types';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

export async function loadAgentConfig(agentId: string): Promise<AgentConfig | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId, isActive: true },
  });
  if (!agent) return null;

  const docs = await prisma.knowledgeDoc.findMany({
    where: { OR: [{ isGlobal: true }, { agentId }] },
  });

  let systemInstruction = agent.systemPrompt;
  if (docs.length > 0) {
    const docsText = docs
      .map((d: { filename: string; content: string }) => `[${d.filename}]\n${d.content}`)
      .join('\n---\n');
    systemInstruction += `\n\n--- BASE DE CONOCIMIENTO ---\n${docsText}\n--- FIN BASE DE CONOCIMIENTO ---`;
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

export async function createGeminiBridge(
  clientWs: WebSocket,
  agentConfig: AgentConfig,
): Promise<GeminiBridge> {
  let isClosed = false;
  let waitingForGreeting = true;
  let micChunkCount = 0;
  let audioChunkCount = 0;

  const sendToClient = (msg: ServerMessage): void => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(msg));
    }
  };

  // ── System prompt ───────────────────────────────────────────────────────────
  let systemPromptText = agentConfig.systemInstruction;
  systemPromptText +=
    '\n\nINSTRUCCIÓN CRÍTICA: Cuando la sesión inicie, saluda al cliente inmediatamente sin esperar a que hable primero. Comienza hablando tú.';
  if (agentConfig.language === 'es') {
    systemPromptText +=
      '\n\nIMPORTANTE: RESPONDE EN ESPAÑOL. DEBES RESPONDER INEQUÍVOCAMENTE EN ESPAÑOL.';
  }
  console.log('[Gemini] System prompt length:', systemPromptText.length);

  // ── Config para Gemini Live API ─────────────────────────────────────────────
  const liveConfig = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: systemPromptText }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: agentConfig.voiceName },
      },
    },
    temperature: agentConfig.temperature,
    topP: agentConfig.topP,
    topK: agentConfig.topK,
    maxOutputTokens: agentConfig.maxOutputTokens,
  };

  console.log('[Gemini] Connecting | voice=' + agentConfig.voiceName);

  // ── Conectar con Gemini Live API ────────────────────────────────────────────
  const session = await ai.live.connect({
    model: LIVE_MODEL,
    config: liveConfig,
    callbacks: {
      onopen(): void {
        console.log(
          `[Gemini] Session opened | agent=${agentConfig.id} voice=${agentConfig.voiceName} time=${Date.now()}`,
        );
        sendToClient({ type: 'session_started', agentId: agentConfig.id });
      },

      onmessage(message: LiveServerMessage): void {
        const sc = message.serverContent;
        if (!sc) return;

        // ── 1. AUDIO del modelo — procesar SIEMPRE, sin return ──────────
        if (sc.modelTurn && sc.modelTurn.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData && part.inlineData.data) {
              audioChunkCount++;
              if (audioChunkCount === 1) {
                console.log('[Gemini] >>> First audio chunk | time=' + Date.now());
              } else if (audioChunkCount % 100 === 0) {
                console.log('[Gemini] Audio chunks sent:', audioChunkCount);
              }
              sendToClient({ type: 'audio', audio: part.inlineData.data });
            }
          }
        }

        // ── 2. Interrupción — NO usar return, solo notificar ────────────
        if (sc.interrupted === true) {
          console.log('[Gemini] Agent interrupted by user');
          sendToClient({ type: 'interrupted' });
        }

        // ── 3. Transcripción de salida (voz del agente) ─────────────────
        if (sc.outputTranscription && sc.outputTranscription.text) {
          sendToClient({ type: 'transcript_output', text: sc.outputTranscription.text });
        }

        // ── 4. Transcripción de entrada (voz del usuario) ───────────────
        if (sc.inputTranscription && sc.inputTranscription.text) {
          sendToClient({ type: 'transcript_input', text: sc.inputTranscription.text });
        }

        // ── 5. Fin de turno ─────────────────────────────────────────────
        if (sc.turnComplete) {
          sendToClient({ type: 'turn_complete' });
          if (waitingForGreeting) {
            waitingForGreeting = false;
            console.log('[Gemini] Initial greeting complete, mic now active');
          }
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

  // ── Trigger: hacer que el agente hable primero ──────────────────────────────
  try {
    session.sendClientContent({
      turns: [
        {
          role: 'user',
          parts: [{ text: 'Inicia la conversación ahora. Saluda al cliente según tu flujo.' }],
        },
      ],
      turnComplete: true,
    });
    console.log('[Gemini] Sent initial prompt | time=' + Date.now());
  } catch (e) {
    console.error('[Gemini] Error sending initial prompt:', e);
  }

  // ── API pública del bridge ──────────────────────────────────────────────────
  return {
    sendAudio(base64Data: string): void {
      if (isClosed) return;
      if (waitingForGreeting) return; // Bloquear mic hasta que termine el saludo
      if (micChunkCount++ === 0) console.log('[Gemini] First mic chunk sent to Gemini');
      try {
        session.sendRealtimeInput({
          audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' },
        });
      } catch (err) {
        console.error('[Gemini] Error sending audio chunk:', err);
      }
    },

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