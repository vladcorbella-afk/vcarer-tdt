import { GoogleGenAI } from '@google/genai';

const TTS_MODEL_CHAIN = [
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
] as const;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido. Use POST.' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const {
      text,
      gender = 'FEMININO',
      tone = 'Natural conversational tone',
      femaleVoice = 'Kore',
      maleVoice = 'Fenrir',
    } = body;

    if (!text || !text.trim()) {
      res.status(400).json({ error: 'Texto vazio para síntese de voz.' });
      return;
    }

    const apiKey =
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.VITE_GEMINI_API_KEY;

    if (!apiKey) {
      res.status(200).json({ audioWavBase64: null, voiceUsed: null });
      return;
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const voiceName = String(gender).toUpperCase().includes('FEM')
      ? femaleVoice
      : maleVoice;

    for (const ttsModel of TTS_MODEL_CHAIN) {
      try {
        const ttsResponse = await ai.models.generateContent({
          model: ttsModel,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: text.trim(),
                  // @ts-ignore
                  speechMetadata: {
                    style: tone || 'Natural, clear simultaneous interpreter delivery',
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        });

        const base64Audio =
          ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) {
          res.status(200).json({ audioWavBase64: base64Audio, voiceUsed: voiceName });
          return;
        }
      } catch {
        // try next model
      }
    }

    res.status(200).json({ audioWavBase64: null, voiceUsed: voiceName });
  } catch {
    res.status(200).json({ audioWavBase64: null, voiceUsed: null });
  }
}
