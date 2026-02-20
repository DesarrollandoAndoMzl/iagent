import { Router } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

// GET /api/agents — lista todos los agentes activos
router.get('/agents', async (_req, res) => {
  try {
    const agents = await prisma.agent.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(agents);
  } catch (err) {
    console.error('[Agents] GET /agents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/agents/:id — detalle de un agente con sus docs
router.get('/agents/:id', async (req, res) => {
  try {
    const agent = await prisma.agent.findUnique({
      where: { id: req.params.id },
      include: { knowledgeDocs: true },
    });
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json(agent);
  } catch (err) {
    console.error('[Agents] GET /agents/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/agents — crear agente
router.post('/agents', async (req, res) => {
  const {
    name, description, systemPrompt, voiceName, language,
    temperature, topP, topK, maxOutputTokens,
    enableAffectiveDialog, enableProactiveAudio, thinkingBudget, vadSensitivity,
  } = req.body as {
    name?: string;
    description?: string;
    systemPrompt?: string;
    voiceName?: string;
    language?: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    enableAffectiveDialog?: boolean;
    enableProactiveAudio?: boolean;
    thinkingBudget?: number;
    vadSensitivity?: string;
  };

  if (!name) {
    res.status(400).json({ error: '"name" is required' });
    return;
  }

  try {
    const agent = await prisma.agent.create({
      data: {
        name,
        description: description ?? null,
        systemPrompt: systemPrompt ?? 'Eres un asistente útil.',
        voiceName: voiceName ?? 'Kore',
        language: language ?? 'es',
        ...(temperature !== undefined && { temperature }),
        ...(topP !== undefined && { topP }),
        ...(topK !== undefined && { topK }),
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
        ...(enableAffectiveDialog !== undefined && { enableAffectiveDialog }),
        ...(enableProactiveAudio !== undefined && { enableProactiveAudio }),
        ...(thinkingBudget !== undefined && { thinkingBudget }),
        ...(vadSensitivity !== undefined && { vadSensitivity }),
      },
    });
    res.status(201).json(agent);
  } catch (err) {
    console.error('[Agents] POST /agents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/agents/:id — actualizar agente
router.put('/agents/:id', async (req, res) => {
  const {
    name, description, systemPrompt, voiceName, language, isActive,
    temperature, topP, topK, maxOutputTokens,
    enableAffectiveDialog, enableProactiveAudio, thinkingBudget, vadSensitivity,
  } = req.body as {
    name?: string;
    description?: string;
    systemPrompt?: string;
    voiceName?: string;
    language?: string;
    isActive?: boolean;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    enableAffectiveDialog?: boolean;
    enableProactiveAudio?: boolean;
    thinkingBudget?: number;
    vadSensitivity?: string;
  };

  try {
    const agent = await prisma.agent.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(systemPrompt !== undefined && { systemPrompt }),
        ...(voiceName !== undefined && { voiceName }),
        ...(language !== undefined && { language }),
        ...(isActive !== undefined && { isActive }),
        ...(temperature !== undefined && { temperature }),
        ...(topP !== undefined && { topP }),
        ...(topK !== undefined && { topK }),
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
        ...(enableAffectiveDialog !== undefined && { enableAffectiveDialog }),
        ...(enableProactiveAudio !== undefined && { enableProactiveAudio }),
        ...(thinkingBudget !== undefined && { thinkingBudget }),
        ...(vadSensitivity !== undefined && { vadSensitivity }),
      },
    });
    res.json(agent);
  } catch (err: unknown) {
    if (isPrismaNotFound(err)) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    console.error('[Agents] PUT /agents/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/agents/:id — soft delete (isActive = false)
router.delete('/agents/:id', async (req, res) => {
  try {
    await prisma.agent.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.status(204).send();
  } catch (err: unknown) {
    if (isPrismaNotFound(err)) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    console.error('[Agents] DELETE /agents/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function isPrismaNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2025'
  );
}

export default router;
