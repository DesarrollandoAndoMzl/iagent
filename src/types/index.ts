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
  audio: string; // PCM codificado en base64
}

export interface TurnCompleteMessage {
  type: 'turn_complete';
}

export interface InterruptedMessage {
  type: 'interrupted';
}

export interface TranscriptInputMessage {
  type: 'transcript_input';
  text: string;
}

export interface TranscriptOutputMessage {
  type: 'transcript_output';
  text: string;
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
  | InterruptedMessage
  | TranscriptInputMessage
  | TranscriptOutputMessage
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

export interface AudioStats {
  /** Bytes de PCM de entrada realmente enviados a Gemini (excluye audio suprimido) */
  inputBytes: number;
  /** Bytes de PCM de salida recibidos desde Gemini */
  outputBytes: number;
}

export interface GeminiBridge {
  sendAudio: (base64Data: string) => void;
  close: () => void;
  getStats: () => AudioStats;
}
