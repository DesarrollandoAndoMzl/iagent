import type { AgentConfig } from '../types';

// ── Registro de agentes ─────────────────────────────────────────────────────────
// Por ahora hardcoded; en el futuro puede cargarse desde DB o CMS.

const agentRegistry: Record<string, AgentConfig> = {
  default: {
    id: 'default',
    name: 'Asistente de Voz',
    systemInstruction:
      'Eres un asistente de voz amigable y útil. Respondes en español de forma concisa y natural.',
    voiceName: 'Kore',
    inputSampleRate: 16000,
  },

  // Ejemplo de agente adicional (descomentar para activar):
  // soporte: {
  //   id: 'soporte',
  //   name: 'Agente de Soporte',
  //   systemInstruction:
  //     'Eres un agente de soporte técnico especializado. Ayudas a los usuarios a resolver problemas de manera empática y efectiva.',
  //   voiceName: 'Aoede',
  //   inputSampleRate: 16000,
  // },
};

export function getAgentConfig(agentId: string): AgentConfig | null {
  return agentRegistry[agentId] ?? null;
}

export function listAgentIds(): string[] {
  return Object.keys(agentRegistry);
}
