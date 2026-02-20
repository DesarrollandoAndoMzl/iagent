import { Router } from 'express';
import { GoogleGenAI, Modality } from '@google/genai';

import { config } from '../config';

const router = Router();
const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_TEXT =
  'Hola, soy tu asistente de inteligencia artificial. ¿En qué puedo ayudarte hoy?';

// POST /api/tts/preview
router.post('/tts/preview', async (req, res) => {
  const { voiceName, text } = req.body as { voiceName?: string; text?: string };

  if (!voiceName) {
    res.status(400).json({ error: '"voiceName" is required' });
    return;
  }

  const promptText = text?.trim() || DEFAULT_TEXT;

  console.log(`[TTS] Preview | voice=${voiceName} text="${promptText.substring(0, 60)}..."`);

  try {
    const response = await ai.models.generateContent({
      model: TTS_MODEL,
      contents: [{ parts: [{ text: promptText }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const audioPart = parts.find((p) => p.inlineData?.data);

    if (!audioPart?.inlineData?.data) {
      console.error('[TTS] No audio part in response');
      res.status(500).json({ error: 'No audio returned from TTS model' });
      return;
    }

    res.json({
      audio: audioPart.inlineData.data,
      mimeType: audioPart.inlineData.mimeType ?? 'audio/pcm',
    });
  } catch (err) {
    console.error('[TTS] Preview error:', err);
    res.status(500).json({ error: 'TTS generation failed' });
  }
});

export default router;
