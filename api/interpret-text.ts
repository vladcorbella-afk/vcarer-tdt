import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const INTERPRET_MODEL_CHAIN = [
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-flash-latest',
] as const;

const TTS_MODEL_CHAIN = [
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
] as const;

function getGenAIClient(): GoogleGenAI {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY não configurada no servidor. Na Vercel, adicione GEMINI_API_KEY em Settings > Environment Variables e faça Redeploy.'
    );
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

function buildSystemInstruction(
  mode: string,
  genderOverride: string,
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
      description: 'True apenas se o áudio contiver exclusivamente silêncio ou ruído.',
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
      description: 'Gênero identificado do emissor: "FEMININO" ou "MASCULINO".',
    },
    detectedTone: {
      type: Type.STRING,
      description: 'Tom emocional e registro da fala.',
    },
    genderAdaptations: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Lista curta de flexões de gênero aplicadas na tradução.',
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
                // @ts-ignore
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
      if (base64Audio) return base64Audio;
    } catch {
      // fallback to next TTS model or client speechSynthesis
    }
  }
  return null;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido. Use POST.' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const {
      text,
      mode = 'ALTERNADO',
      genderOverride = 'AUTO',
      acousticHintHz = null,
      conversationContext = [],
      synthesizeAudio = true,
      femaleVoice = 'Kore',
      maleVoice = 'Fenrir',
    } = body;

    if (!text || !text.trim()) {
      res.status(400).json({ error: 'Texto de entrada vazio.' });
      return;
    }

    const ai = getGenAIClient();
    const systemInstruction = buildSystemInstruction(mode, genderOverride, acousticHintHz);

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
            acousticHintHz >= 165 ? 'faixa tipicamente feminina' : 'faixa tipicamente masculina'
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

    let response: any = null;
    let lastError: unknown = null;

    for (const modelName of INTERPRET_MODEL_CHAIN) {
      try {
        response = await ai.models.generateContent({
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
        });
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!response) {
      throw lastError || new Error('Modelos de tradução temporariamente ocupados.');
    }

    const rawJson = response.text?.trim() || '{}';
    const parsed = JSON.parse(rawJson);

    const finalGender =
      genderOverride !== 'AUTO'
        ? genderOverride
        : parsed.detectedGender === 'MASCULINO'
        ? 'MASCULINO'
        : 'FEMININO';

    const voiceToUse = finalGender === 'FEMININO' ? femaleVoice : maleVoice;

    let audioWavBase64: string | null = null;
    if (synthesizeAudio && parsed.translation) {
      audioWavBase64 = await synthesizeSpeechWav(
        ai,
        parsed.translation,
        voiceToUse,
        parsed.detectedTone || 'Natural conversational tone'
      );
    }

    res.status(200).json({
      ...parsed,
      isSilenceOrNoise: false,
      sourceTranscript: parsed.sourceTranscript || text.trim(),
      detectedGender: finalGender,
      audioWavBase64,
      voiceUsed: voiceToUse,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Erro ao processar tradução.';
    res.status(503).json({ error: msg });
  }
}
