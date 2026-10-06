import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  Type,
} from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

// Ordered fallback chains: gemini-3.1-flash-lite first for lowest latency & highest availability
const INTERPRET_MODEL_CHAIN = [
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-flash-latest',
] as const;

const TTS_MODEL_CHAIN = [
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
] as const;

const LIVE_MODEL_CHAIN = [
  'gemini-3.8-live',
  'gemini-3.5-transcribe-live',
] as const;

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY não configurada no ambiente.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDemandError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  const upper = raw.toUpperCase();
  return (
    upper.includes('503') ||
    upper.includes('UNAVAILABLE') ||
    upper.includes('HIGH DEMAND') ||
    upper.includes('OVERLOADED') ||
    upper.includes('429') ||
    upper.includes('RESOURCE_EXHAUSTED') ||
    upper.includes('500') ||
    upper.includes('502') ||
    upper.includes('504') ||
    upper.includes('INTERNAL') ||
    upper.includes('FETCH FAILED')
  );
}

function formatFriendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const code = parsed?.error?.code || parsed?.code;
      const status = parsed?.error?.status || parsed?.status;
      if (code === 503 || status === 'UNAVAILABLE') {
        return 'O servidor de tradução está com alta demanda momentânea. Tente novamente em alguns segundos.';
      }
      if (code === 429 || status === 'RESOURCE_EXHAUSTED') {
        return 'Limite de requisições atingido temporariamente. Aguarde alguns instantes e tente novamente.';
      }
      if (parsed?.error?.message) {
        return String(parsed.error.message);
      }
    }
  } catch {
    // ignore JSON parse errors
  }

  if (isTransientDemandError(err)) {
    return 'Alta demanda temporária nos modelos de voz. Tente novamente em instantes.';
  }
  return raw || 'Erro ao processar a tradução simultânea.';
}

async function generateContentWithFallback(
  ai: GoogleGenAI,
  buildParams: (modelName: string) => Parameters<GoogleGenAI['models']['generateContent']>[0]
): Promise<{
  response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>;
  modelUsed: string;
}> {
  let lastError: unknown = null;

  for (let mIdx = 0; mIdx < INTERPRET_MODEL_CHAIN.length; mIdx++) {
    const modelName = INTERPRET_MODEL_CHAIN[mIdx];
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const params = buildParams(modelName);
        const response = await ai.models.generateContent(params);
        return { response, modelUsed: modelName };
      } catch (err: unknown) {
        lastError = err;
        console.warn(
          `[VoxVcarer] Tentativa ${attempt}/${maxAttempts} falhou no modelo ${modelName}:`,
          err instanceof Error ? err.message : err
        );

        // Immediately jump to next fallback model on first failure so user never waits long
        if (mIdx < INTERPRET_MODEL_CHAIN.length - 1 && attempt === 1) {
          break;
        }

        if (!isTransientDemandError(err)) {
          break;
        }

        if (attempt < maxAttempts) {
          await sleep(250);
        }
      }
    }
  }

  throw lastError || new Error('Todos os modelos de tradução estão temporariamente ocupados.');
}

export type OperationMode = 'ALTERNADO' | 'FIXO_PT_BR';
export type GenderMode = 'AUTO' | 'FEMININO' | 'MASCULINO';

function buildSystemInstruction(
  mode: OperationMode,
  genderOverride: GenderMode,
  acousticHintHz?: number | null
): string {
  const modeRule =
    mode === 'FIXO_PT_BR'
      ? `- MODO ATIVO: MODO FIXO PARA PESSOA 2 (Sempre PT-BR).
  - Qualquer entrada captada do emissor (seja em Inglês, Português ou mista) DEVE ser traduzida/adaptada e entregue SEMPRE em Português do Brasil (PT-BR) natural e fluente.`
      : `- MODO ATIVO: MODO ALTERNADO (Padrão).
  - Se a entrada for em Português (PT-BR) -> Traduza diretamente para o Inglês (EN).
  - Se a entrada for em Inglês (EN) -> Traduza diretamente para o Português (PT-BR).`;

  const genderRule =
    genderOverride === 'FEMININO'
      ? `- EMISSOR DEFINIDO COMO MULHER (FEMININO): Adapte rigorosamente a tradução final para o gênero FEMININO (ex: "Estou pronta", "Muito obrigada", "Fiquei cansada", "Estou certa").`
      : genderOverride === 'MASCULINO'
      ? `- EMISSOR DEFINIDO COMO HOMEM (MASCULINO): Adapte rigorosamente a tradução final para o gênero MASCULINO (ex: "Estou pronto", "Muito obrigado", "Fiquei cansado", "Estou certo").`
      : `- DETECÇÃO AUTOMÁTICA DE GÊNERO PELO TOM DE VOZ E CONTEXTO:
  - Analise o tom de voz (timbre vocal, frequência fundamental${
    acousticHintHz ? ` — referência acústica medida: ~${Math.round(acousticHintHz)} Hz` : ''
  }) e o contexto linguístico para identificar o sexo do emissor (MASCULINO ou FEMININO).
  - Se o emissor for MULHER: use adjetivos, particípios e flexões femininas (ex: "Estou pronta", "Muito obrigada").
  - Se o emissor for HOMEM: use adjetivos, particípios e flexões masculinas (ex: "Estou pronto", "Muito obrigado").`;

  return `Você é um intérprete simultâneo de voz em tempo real especializado na conversão entre Português do Brasil (PT-BR) e Inglês (EN).

Sua única função é ouvir o áudio ou ler a fala do emissor e entregar a tradução exata e natural para o ouvinte.

### 1. MODOS DE OPERAÇÃO
${modeRule}

### 2. REGRA DE CONCORDÂNCIA DE GÊNERO (CRÍTICO)
${genderRule}

### 3. FORMATO DA SAÍDA
- No campo de tradução final (ou na voz sintetizada), entregue APENAS o texto/áudio da tradução final.
- PROIBIDO incluir comentários, saudações, explicações ou metadados na tradução (ex: NÃO diga "A tradução é:", "A pessoa falou:", "Aqui está:").
- Mantenha a intenção, a emoção, o ritmo e o tom natural de uma conversa informal ou formal, dependendo do contexto.`;
}

const INTERPRETATION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    isSilenceOrNoise: {
      type: Type.BOOLEAN,
      description: 'True apenas se o áudio contiver exclusivamente silêncio ou ruído sem nenhuma fala compreensível.',
    },
    translation: {
      type: Type.STRING,
      description:
        'APENAS o texto da tradução final exata e natural, seguindo rigorosamente o modo de operação e a concordância de gênero do emissor. PROIBIDO incluir prefixos, comentários ou metadados.',
    },
    sourceTranscript: {
      type: Type.STRING,
      description: 'Transcrição exata do que o emissor falou no idioma original.',
    },
    detectedLanguage: {
      type: Type.STRING,
      description: 'Idioma identificado na fala de entrada: "PT-BR" ou "EN".',
    },
    targetLanguage: {
      type: Type.STRING,
      description: 'Idioma da tradução entregue: "PT-BR" ou "EN".',
    },
    detectedGender: {
      type: Type.STRING,
      description:
        'Gênero identificado do emissor com base no tom/timbre de voz e contexto: "FEMININO" ou "MASCULINO".',
    },
    detectedTone: {
      type: Type.STRING,
      description: 'Tom emocional e registro da fala (ex: "Natural e cordial", "Formal", "Informal", "Entusiasmado", "Urgente").',
    },
    genderAdaptations: {
      type: Type.ARRAY,
      items: {
        type: Type.STRING,
      },
      description:
        'Lista curta de flexões de gênero aplicadas ou preservadas na tradução (ex: ["pronta (feminino)", "obrigada (feminino)"]). Vazio se não houver palavras variáveis.',
    },
  },
  required: [
    'isSilenceOrNoise',
    'translation',
    'sourceTranscript',
    'detectedLanguage',
    'targetLanguage',
    'detectedGender',
    'detectedTone',
    'genderAdaptations',
  ],
};

function selectVoiceForGender(
  gender: string,
  preferredFemaleVoice = 'Kore',
  preferredMaleVoice = 'Fenrir'
): string {
  const normalized = (gender || '').toUpperCase();
  if (normalized.includes('FEM')) {
    return preferredFemaleVoice;
  }
  return preferredMaleVoice;
}

async function synthesizeSpeechWav(
  ai: GoogleGenAI,
  text: string,
  voiceName: string,
  toneStyle: string
): Promise<string | null> {
  if (!text || !text.trim()) return null;

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
                // @ts-ignore - speechMetadata supported on Gemini 3.8 TTS
                speechMetadata: {
                  style: toneStyle || 'Natural, clear simultaneous interpreter delivery',
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
        return base64Audio;
      }
    } catch (err) {
      console.warn(
        `[VoxVcarer TTS] Falha no modelo ${ttsModel}:`,
        err instanceof Error ? err.message : err
      );
      if (!isTransientDemandError(err)) break;
    }
  }
  return null;
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);

  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // 1. Audio Interpretation Endpoint
  app.post('/api/interpret-audio', async (req, res) => {
    try {
      const {
        audioBase64,
        mimeType = 'audio/webm',
        mode = 'ALTERNADO',
        genderOverride = 'AUTO',
        acousticHintHz = null,
        conversationContext = [],
        synthesizeAudio = true,
        femaleVoice = 'Kore',
        maleVoice = 'Fenrir',
      } = req.body;

      if (!audioBase64) {
        res.status(400).json({ error: 'Áudio não fornecido.' });
        return;
      }

      const ai = getGenAIClient();
      const systemInstruction = buildSystemInstruction(
        mode as OperationMode,
        genderOverride as GenderMode,
        acousticHintHz
      );

      const contextText =
        Array.isArray(conversationContext) && conversationContext.length > 0
          ? `\nContexto recente da conversa (apenas para manter coerência de gênero e assunto):\n${conversationContext
              .slice(-4)
              .map(
                (c: { source: string; translation: string; gender: string }) =>
                  `[${c.gender}] "${c.source}" -> "${c.translation}"`
              )
              .join('\n')}`
          : '';

      const promptText = `Ouça atentamente o áudio do emissor.
1. Identifique pelo timbre/tom de voz no áudio${
        acousticHintHz
          ? ` (frequência vocal média medida em ${Math.round(acousticHintHz)} Hz)`
          : ''
      } e pelo contexto se o emissor é MULHER (FEMININO) ou HOMEM (MASCULINO).${
        genderOverride !== 'AUTO'
          ? ` Use obrigatoriamente o gênero ${genderOverride}.`
          : ''
      }
2. Aplique o modo ${
        mode === 'FIXO_PT_BR'
          ? 'FIXO PARA PESSOA 2 (entregue SEMPRE em Português do Brasil - PT-BR)'
          : 'ALTERNADO (PT-BR -> EN, ou EN -> PT-BR)'
      }.
3. Adapte rigorosamente todas as flexões de gênero (ex: pronto/pronta, obrigado/obrigada, cansado/cansada) ao gênero do emissor.
4. No campo "translation", retorne EXCLUSIVAMENTE a tradução final limpa, sem nenhum comentário ou introdução.${contextText}`;

      const { response } = await generateContentWithFallback(ai, (modelName) => ({
        model: modelName,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBase64,
              },
            },
            {
              text: promptText,
            },
          ],
        },
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: INTERPRETATION_RESPONSE_SCHEMA,
          temperature: 0.2,
          ...(modelName === 'gemini-3.8-flash'
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
        },
      }));

      const rawJson = response.text?.trim() || '{}';
      const parsed = JSON.parse(rawJson);

      if (parsed.isSilenceOrNoise || !parsed.translation?.trim()) {
        res.json({
          isSilenceOrNoise: true,
          translation: '',
          sourceTranscript: '',
          detectedLanguage: 'PT-BR',
          targetLanguage: mode === 'FIXO_PT_BR' ? 'PT-BR' : 'EN',
          detectedGender: genderOverride !== 'AUTO' ? genderOverride : 'FEMININO',
          detectedTone: 'Neutro',
          genderAdaptations: [],
          audioWavBase64: null,
          voiceUsed: null,
        });
        return;
      }

      const finalGender =
        genderOverride !== 'AUTO'
          ? genderOverride
          : parsed.detectedGender === 'MASCULINO'
          ? 'MASCULINO'
          : 'FEMININO';

      const voiceToUse = selectVoiceForGender(finalGender, femaleVoice, maleVoice);

      let audioWavBase64: string | null = null;
      if (synthesizeAudio) {
        audioWavBase64 = await synthesizeSpeechWav(
          ai,
          parsed.translation,
          voiceToUse,
          parsed.detectedTone || 'Natural conversational tone'
        );
      }

      res.json({
        ...parsed,
        detectedGender: finalGender,
        audioWavBase64,
        voiceUsed: voiceToUse,
      });
    } catch (error: unknown) {
      console.error('Error in /api/interpret-audio:', error);
      res.status(503).json({ error: formatFriendlyError(error) });
    }
  });

  // 2. Text / Scenario Interpretation Endpoint
  app.post('/api/interpret-text', async (req, res) => {
    try {
      const {
        text,
        mode = 'ALTERNADO',
        genderOverride = 'AUTO',
        acousticHintHz = null,
        conversationContext = [],
        synthesizeAudio = true,
        femaleVoice = 'Kore',
        maleVoice = 'Fenrir',
      } = req.body;

      if (!text || !text.trim()) {
        res.status(400).json({ error: 'Texto de entrada vazio.' });
        return;
      }

      const ai = getGenAIClient();
      const systemInstruction = buildSystemInstruction(
        mode as OperationMode,
        genderOverride as GenderMode,
        acousticHintHz
      );

      const contextText =
        Array.isArray(conversationContext) && conversationContext.length > 0
          ? `\nContexto recente:\n${conversationContext
              .slice(-4)
              .map(
                (c: { source: string; translation: string; gender: string }) =>
                  `[${c.gender}] "${c.source}" -> "${c.translation}"`
              )
              .join('\n')}`
          : '';

      const promptText = `Fala do emissor: "${text.trim()}"
1. Identifique o idioma de entrada ("PT-BR" ou "EN") e o gênero do emissor.${
        genderOverride !== 'AUTO'
          ? ` O gênero do emissor é obrigatoriamente ${genderOverride}.`
          : acousticHintHz
          ? ` Frequência vocal medida do emissor: ${Math.round(acousticHintHz)} Hz (${
              acousticHintHz >= 165
                ? 'faixa tipicamente feminina'
                : 'faixa tipicamente masculina'
            }).`
          : ''
      }
2. Aplique o modo ${
        mode === 'FIXO_PT_BR'
          ? 'FIXO PARA PESSOA 2 (entregue SEMPRE em Português do Brasil - PT-BR)'
          : 'ALTERNADO (Se PT-BR -> EN; Se EN -> PT-BR)'
      }.
3. Adapte rigorosamente a concordância de gênero (ex: "Estou pronta / Muito obrigada" para mulher; "Estou pronto / Muito obrigado" para homem).
4. No campo "translation", retorne APENAS a tradução final, sem comentários, saudações extras ou metadados.${contextText}`;

      const { response } = await generateContentWithFallback(ai, (modelName) => ({
        model: modelName,
        contents: promptText,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: INTERPRETATION_RESPONSE_SCHEMA,
          temperature: 0.2,
          ...(modelName === 'gemini-3.8-flash'
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
        },
      }));

      const rawJson = response.text?.trim() || '{}';
      const parsed = JSON.parse(rawJson);

      const finalGender =
        genderOverride !== 'AUTO'
          ? genderOverride
          : parsed.detectedGender === 'MASCULINO'
          ? 'MASCULINO'
          : 'FEMININO';

      const voiceToUse = selectVoiceForGender(finalGender, femaleVoice, maleVoice);

      let audioWavBase64: string | null = null;
      if (synthesizeAudio && parsed.translation) {
        audioWavBase64 = await synthesizeSpeechWav(
          ai,
          parsed.translation,
          voiceToUse,
          parsed.detectedTone || 'Natural conversational tone'
        );
      }

      res.json({
        ...parsed,
        isSilenceOrNoise: false,
        sourceTranscript: parsed.sourceTranscript || text.trim(),
        detectedGender: finalGender,
        audioWavBase64,
        voiceUsed: voiceToUse,
      });
    } catch (error: unknown) {
      console.error('Error in /api/interpret-text:', error);
      res.status(503).json({ error: formatFriendlyError(error) });
    }
  });

  // 3. Dedicated TTS Replay Endpoint
  app.post('/api/tts', async (req, res) => {
    try {
      const {
        text,
        gender = 'FEMININO',
        tone = 'Natural conversational tone',
        femaleVoice = 'Kore',
        maleVoice = 'Fenrir',
      } = req.body;
      if (!text || !text.trim()) {
        res.status(400).json({ error: 'Texto vazio para síntese de voz.' });
        return;
      }
      const ai = getGenAIClient();
      const voiceName = selectVoiceForGender(gender, femaleVoice, maleVoice);
      const audioWavBase64 = await synthesizeSpeechWav(ai, text, voiceName, tone);
      res.json({ audioWavBase64, voiceUsed: voiceName });
    } catch (error: unknown) {
      console.error('Error in /api/tts:', error);
      res.json({ audioWavBase64: null, voiceUsed: null });
    }
  });

  // Ensure any unknown /api/* route always returns JSON, never HTML/text
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Endpoint de API não encontrado.' });
  });

  // 4. WebSocket Server for Real-Time Gemini Live API (/ws/live)
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(
      request.url || '/',
      `http://${request.headers.host || 'localhost'}`
    );
    if (reqUrl.pathname === '/ws/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', async (clientWs: WebSocket, request) => {
    const reqUrl = new URL(
      request.url || '/',
      `http://${request.headers.host || 'localhost'}`
    );
    const mode = (reqUrl.searchParams.get('mode') || 'ALTERNADO') as OperationMode;
    const gender = (reqUrl.searchParams.get('gender') || 'AUTO') as GenderMode;
    const voiceName =
      reqUrl.searchParams.get('voice') ||
      (gender === 'MASCULINO' ? 'Fenrir' : 'Kore');

    let liveSession: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null =
      null;
    let isClosed = false;

    const connectLiveWithFallback = async () => {
      const ai = getGenAIClient();
      const systemInstruction = buildSystemInstruction(mode, gender, null);
      let lastErr: unknown = null;

      for (const liveModel of LIVE_MODEL_CHAIN) {
        try {
          const session = await ai.live.connect({
            model: liveModel,
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName },
                },
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              systemInstruction,
            },
            callbacks: {
              onopen: () => {
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'ready',
                      mode,
                      gender,
                      voiceName,
                      model: liveModel,
                    })
                  );
                }
              },
              onmessage: (message) => {
                if (clientWs.readyState !== WebSocket.OPEN) return;

                const parts = message.serverContent?.modelTurn?.parts || [];
                for (const part of parts) {
                  if (part.inlineData?.data) {
                    clientWs.send(
                      JSON.stringify({
                        type: 'audio',
                        audio: part.inlineData.data,
                      })
                    );
                  }
                }

                const inputTranscript = (
                  message.serverContent as Record<string, unknown>
                )?.inputTranscription as { text?: string } | undefined;
                if (inputTranscript?.text) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'inputTranscription',
                      text: inputTranscript.text,
                    })
                  );
                }

                const outputTranscript = (
                  message.serverContent as Record<string, unknown>
                )?.outputTranscription as { text?: string } | undefined;
                if (outputTranscript?.text) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'outputTranscription',
                      text: outputTranscript.text,
                    })
                  );
                }

                if (message.serverContent?.turnComplete) {
                  clientWs.send(JSON.stringify({ type: 'turnComplete' }));
                }

                if (message.serverContent?.interrupted) {
                  clientWs.send(JSON.stringify({ type: 'interrupted' }));
                }
              },
              onerror: (err: unknown) => {
                console.error(`Gemini Live session error (${liveModel}):`, err);
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'error',
                      error: formatFriendlyError(err),
                    })
                  );
                }
              },
              onclose: () => {
                if (!isClosed && clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: 'closed' }));
                }
              },
            },
          });
          return session;
        } catch (err) {
          lastErr = err;
          console.warn(`Live connect failed on ${liveModel}, trying next...`, err);
          await sleep(250);
        }
      }
      throw lastErr || new Error('Serviço Live temporariamente indisponível.');
    };

    try {
      liveSession = await connectLiveWithFallback();

      clientWs.on('message', (raw) => {
        try {
          const payload = JSON.parse(raw.toString());
          if (payload.audio && liveSession) {
            liveSession.sendRealtimeInput({
              audio: {
                data: payload.audio,
                mimeType: 'audio/pcm;rate=16000',
              },
            });
          } else if (payload.text && liveSession) {
            liveSession.sendRealtimeInput({
              text: payload.text,
            });
          }
        } catch (e) {
          console.error('Failed to process client WebSocket message:', e);
        }
      });

      clientWs.on('close', () => {
        isClosed = true;
        if (liveSession) {
          try {
            liveSession.close();
          } catch {
            // ignore close error
          }
        }
      });
    } catch (error: unknown) {
      console.error('Failed to initialize Gemini Live session:', error);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: 'error',
            error: formatFriendlyError(error),
          })
        );
        clientWs.close();
      }
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`VoxVcarer Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
