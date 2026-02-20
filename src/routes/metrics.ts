import { Router } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

// GET /api/metrics/calls — lista todas las llamadas con filtros
router.get('/metrics/calls', async (req, res) => {
  const { agentId, dateFrom, dateTo, status } = req.query as {
    agentId?: string;
    dateFrom?: string;
    dateTo?: string;
    status?: string;
  };

  try {
    const calls = await prisma.callSession.findMany({
      where: {
        ...(agentId && { agentId }),
        ...(status && { status }),
        ...(dateFrom || dateTo
          ? {
              startedAt: {
                ...(dateFrom && { gte: new Date(dateFrom) }),
                ...(dateTo && { lte: new Date(dateTo) }),
              },
            }
          : {}),
      },
      include: { agent: { select: { id: true, name: true } } },
      orderBy: { startedAt: 'desc' },
    });
    res.json(calls);
  } catch (err) {
    console.error('[Metrics] GET /calls error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/metrics/calls/:id — detalle de una llamada
router.get('/metrics/calls/:id', async (req, res) => {
  try {
    const call = await prisma.callSession.findUnique({
      where: { id: req.params.id },
      include: { agent: { select: { id: true, name: true } } },
    });
    if (!call) {
      res.status(404).json({ error: 'Call session not found' });
      return;
    }
    res.json(call);
  } catch (err) {
    console.error('[Metrics] GET /calls/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/metrics/summary — resumen general
router.get('/metrics/summary', async (_req, res) => {
  try {
    const [totalCalls, completedSessions, agents] = await Promise.all([
      prisma.callSession.count(),
      prisma.callSession.findMany({
        where: { status: 'completed', durationSeconds: { not: null } },
        select: { durationSeconds: true, estimatedCost: true, agentId: true },
      }),
      prisma.agent.findMany({ select: { id: true, name: true } }),
    ]);

    const totalDuration = completedSessions.reduce(
      (sum: number, s: { durationSeconds: number | null }) => sum + (s.durationSeconds ?? 0),
      0,
    );
    const totalCost = completedSessions.reduce(
      (sum: number, s: { estimatedCost: number | null }) => sum + (s.estimatedCost ?? 0),
      0,
    );
    const avgDuration =
      completedSessions.length > 0
        ? Math.round(totalDuration / completedSessions.length)
        : 0;

    // Agrupar por agente
    const agentMap = Object.fromEntries(agents.map((a: { id: string; name: string }) => [a.id, a.name]));
    const byAgent: Record<string, { name: string; calls: number; totalCost: number }> = {};
    for (const s of completedSessions) {
      if (!byAgent[s.agentId]) {
        byAgent[s.agentId] = { name: agentMap[s.agentId] ?? s.agentId, calls: 0, totalCost: 0 };
      }
      byAgent[s.agentId].calls += 1;
      byAgent[s.agentId].totalCost += s.estimatedCost ?? 0;
    }

    res.json({
      totalCalls,
      completedCalls: completedSessions.length,
      avgDurationSeconds: avgDuration,
      totalCostUsd: Math.round(totalCost * 10000) / 10000,
      byAgent: Object.values(byAgent),
    });
  } catch (err) {
    console.error('[Metrics] GET /summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
