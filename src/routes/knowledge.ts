import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { prisma } from '../lib/prisma';

const router = Router();

// Asegurar directorio de uploads
const UPLOAD_DIR = '/tmp/uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  dest: UPLOAD_DIR,
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.txt', '.md', '.pdf'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt, .md, and .pdf files are allowed'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// Lee el contenido de texto de un archivo subido
function extractContent(filePath: string, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.pdf') {
    return `[PDF] ${originalName} — contenido pendiente de extracción`;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

// GET /api/knowledge/global — lista documentos globales
router.get('/knowledge/global', async (_req, res) => {
  try {
    const docs = await prisma.knowledgeDoc.findMany({
      where: { isGlobal: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(docs);
  } catch (err) {
    console.error('[Knowledge] GET global error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/agents/:id/knowledge — lista documentos de un agente
router.get('/agents/:id/knowledge', async (req, res) => {
  try {
    const docs = await prisma.knowledgeDoc.findMany({
      where: { agentId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(docs);
  } catch (err) {
    console.error('[Knowledge] GET agent docs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/knowledge/global — upload doc global
router.post('/knowledge/global', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
    return;
  }

  try {
    const content = extractContent(req.file.path, req.file.originalname);
    const doc = await prisma.knowledgeDoc.create({
      data: {
        filename: req.file.originalname,
        content,
        isGlobal: true,
        agentId: null,
      },
    });
    res.status(201).json(doc);
  } catch (err) {
    console.error('[Knowledge] POST global upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => undefined);
  }
});

// POST /api/agents/:id/knowledge — upload doc para agente específico
router.post('/agents/:id/knowledge', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
    return;
  }

  try {
    const agent = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const content = extractContent(req.file.path, req.file.originalname);
    const doc = await prisma.knowledgeDoc.create({
      data: {
        filename: req.file.originalname,
        content,
        isGlobal: false,
        agentId: req.params.id,
      },
    });
    res.status(201).json(doc);
  } catch (err) {
    console.error('[Knowledge] POST agent upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => undefined);
  }
});

// DELETE /api/knowledge/:docId — eliminar documento
router.delete('/knowledge/:docId', async (req, res) => {
  try {
    await prisma.knowledgeDoc.delete({ where: { id: req.params.docId } });
    res.status(204).send();
  } catch (err: unknown) {
    if (isPrismaNotFound(err)) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    console.error('[Knowledge] DELETE error:', err);
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
