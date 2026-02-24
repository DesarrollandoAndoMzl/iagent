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
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// Extensiones que se leen directamente como texto UTF-8
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.yaml', '.yml',
  '.html', '.htm', '.xml', '.log', '.rtf', '.tex',
  '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h',
  '.css', '.scss', '.sql', '.sh', '.bat', '.env',
]);

async function extractContent(filePath: string, originalName: string): Promise<string> {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.pdf') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text || `[PDF] ${originalName} — sin texto extraíble`;
  }

  if (ext === '.docx') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mammoth = require('mammoth') as {
      extractRawText: (opts: { path: string }) => Promise<{ value: string }>;
    };
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || `[DOCX] ${originalName} — sin texto extraíble`;
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return fs.readFileSync(filePath, 'utf-8');
  }

  // Intentar leer como texto; si falla, devolver mensaje informativo
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Descartar si contiene demasiados caracteres no imprimibles (binario)
    const nonPrintable = (content.match(/[\x00-\x08\x0e-\x1f\x7f]/g) || []).length;
    if (nonPrintable / content.length > 0.05) {
      return `[${ext.toUpperCase() || 'BINARY'}] ${originalName} — archivo binario, contenido no extraíble como texto`;
    }
    return content;
  } catch {
    return `[${ext.toUpperCase() || 'FILE'}] ${originalName} — no fue posible extraer el contenido`;
  }
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
    const content = await extractContent(req.file.path, req.file.originalname);
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

    const content = await extractContent(req.file.path, req.file.originalname);
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
