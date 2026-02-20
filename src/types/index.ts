// ── Mensajes del cliente → servidor ────────────────────────────────────────────

export interface StartSessionMessage {
  type: 'start_session';
  agentId?: string;
}

export interface AudioInputMessage {
  type: 'audio';
  data: string; // PCM 16-bit mono a 16 kHz codificado en base64
}

export interface EndSessionMessage {
  type: 'end_session';
}

export type ClientMessage = StartSessionMessage | AudioInputMessage | EndSessionMessage;

// ── Mensajes del servidor → cliente ────────────────────────────────────────────

export interface SessionStartedMessage {
  type: 'session_started';
  agentId: string;
}

export interface AudioOutputMessage {
  type: 'audio';
  data: string;    // PCM codificado en base64
  mimeType: string; // e.g. "audio/pcm;rate=24000"
}

export interface TurnCompleteMessage {
  type: 'turn_complete';
}

export interface SessionEndedMessage {
  type: 'session_ended';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | SessionStartedMessage
  | AudioOutputMessage
  | TurnCompleteMessage
  | SessionEndedMessage
  | ErrorMessage;

// ── Configuración de agentes ────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  systemInstruction: string;
  voiceName: string;
  language: string;
  // Generation params
  temperature: number;
  topP: number;
  topK: number;
  maxOutputTokens: number;
  // Session features
  enableAffectiveDialog: boolean;
  enableProactiveAudio: boolean;
  thinkingBudget: number;
  vadSensitivity: string;
  /** Frecuencia de muestreo de audio de entrada en Hz (default: 16000) */
  inputSampleRate?: number;
}

// ── Estado de sesión WebSocket ──────────────────────────────────────────────────

export interface GeminiBridge {
  sendAudio: (base64Data: string) => void;
  close: () => void;
}
