import { GoogleGenAI, Modality } from '@google/genai';
import type { LiveServerMessage } from '@google/genai';
import WebSocket from 'ws';

import { config } from '../config';
import { prisma } from '../lib/prisma';
import type { AgentConfig, AudioStats, GeminiBridge, ServerMessage } from '../types';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

// ── Límite de knowledge en system prompt (~4K tokens ≈ 16K chars) ─────────────
const MAX_KNOWLEDGE_CHARS = 16_000;

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
    let docsText = docs
      .map((d: { filename: string; content: string }) => `[${d.filename}]\n${d.content}`)
      .join('\n---\n');

    // Truncar knowledge si excede el límite para proteger latencia
    if (docsText.length > MAX_KNOWLEDGE_CHARS) {
      console.warn(
        `[AgentConfig] Knowledge truncated: ${docsText.length} → ${MAX_KNOWLEDGE_CHARS} chars`
      );
      docsText = docsText.slice(0, MAX_KNOWLEDGE_CHARS) + '\n[... contenido truncado por límite]';
    }

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

  // ── Contadores de bytes para cálculo de costo ──────────────────────────────
  let inputBytes = 0;
  let outputBytes = 0;

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
  //
  // NOTA: enableAffectiveDialog y proactiveAudio requieren api_version="v1alpha"
  // que el SDK de Node.js no soporta correctamente todavía.
  // El SDK serializa estos campos dentro de generationConfig y Gemini los rechaza.
  // Se omiten hasta que Google lo arregle. Ver:
  // https://github.com/googleapis/python-genai/issues/865
  // https://discuss.ai.google.dev/t/84326
  //
  const liveConfig: Record<string, unknown> = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: systemPromptText }] },
    inputAudioTranscription: { languageCode: "es-419" },
    outputAudioTranscription: {},

    // Voice
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: agentConfig.voiceName },
      },
    },

    // Generation params
    temperature: agentConfig.temperature,
    topP: agentConfig.topP,
    topK: agentConfig.topK,
    maxOutputTokens: agentConfig.maxOutputTokens,

    // FIX 1: Thinking budget — 0 = sin razonamiento = respuesta inmediata
    thinkingConfig: {
      thinkingBudget: agentConfig.thinkingBudget ?? 0,
    },

    // FIX 2: VAD Sensitivity
    // Gemini expects full enum values: START_SENSITIVITY_LOW / END_SENSITIVITY_LOW
    // NOT just "LOW" or "low"
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        ...(agentConfig.vadSensitivity && agentConfig.vadSensitivity !== 'default'
          ? {
              startOfSpeechSensitivity: `START_SENSITIVITY_${agentConfig.vadSensitivity.toUpperCase()}`,
              endOfSpeechSensitivity: `END_SENSITIVITY_${agentConfig.vadSensitivity.toUpperCase()}`,
            }
          : {}),
      },
    },
  };

  console.log('[Gemini] Config:', JSON.stringify({
    voice: agentConfig.voiceName,
    thinkingBudget: agentConfig.thinkingBudget,
    affectiveDialog: agentConfig.enableAffectiveDialog + ' (not sent - SDK bug)',
    proactiveAudio: agentConfig.enableProactiveAudio + ' (not sent - SDK bug)',
    vadSensitivity: agentConfig.vadSensitivity,
    temperature: agentConfig.temperature,
    promptLength: systemPromptText.length,
  }));

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

        // ── 1. AUDIO del modelo ─────────────────────────────────────────
        if (sc.modelTurn && sc.modelTurn.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData && part.inlineData.data) {
              audioChunkCount++;
              outputBytes += Math.floor(part.inlineData.data.length * 0.75);

              if (audioChunkCount === 1) {
                console.log('[Gemini] >>> First audio chunk | time=' + Date.now());
              } else if (audioChunkCount % 100 === 0) {
                console.log('[Gemini] Audio chunks sent:', audioChunkCount);
              }
              sendToClient({ type: 'audio', audio: part.inlineData.data });
            }
          }
        }

        // ── 2. Interrupción ─────────────────────────────────────────────
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
      if (waitingForGreeting) return;

      inputBytes += Math.floor(base64Data.length * 0.75);
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

    getStats(): AudioStats {
      return { inputBytes, outputBytes };
    },
  };
}