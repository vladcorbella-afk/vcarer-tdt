export type OperationMode = 'ALTERNADO' | 'FIXO_PT_BR';
export type GenderMode = 'AUTO' | 'FEMININO' | 'MASCULINO';
export type EngineMode = 'TURN_PRECISION' | 'LIVE_STREAM';

export interface InterpretationTurn {
  id: string;
  timestamp: string;
  sourceTranscript: string;
  translation: string;
  detectedLanguage: 'PT-BR' | 'EN';
  targetLanguage: 'PT-BR' | 'EN';
  detectedGender: 'FEMININO' | 'MASCULINO';
  detectedTone: string;
  genderAdaptations: string[];
  acousticPitchHz: number | null;
  audioWavBase64: string | null;
  voiceUsed: string | null;
  mode: OperationMode;
}

export interface TestScenario {
  id: string;
  title: string;
  speakerLabel: string;
  gender: 'FEMININO' | 'MASCULINO';
  simulatedPitchHz: number;
  sourceLang: 'EN' | 'PT-BR';
  inputText: string;
  highlightNote: string;
}

export const BILINGUAL_TEST_SCENARIOS: TestScenario[] = [
  {
    id: 'fem-en-ready',
    title: 'Concordância Feminina (Pronta / Obrigada)',
    speakerLabel: 'Emissora Mulher · Voz ~212 Hz',
    gender: 'FEMININO',
    simulatedPitchHz: 212,
    sourceLang: 'EN',
    inputText: "I'm completely ready for the presentation, thank you so much for waiting for me.",
    highlightNote: 'Exige flexão feminina: "pronta" e "muito obrigada"',
  },
  {
    id: 'masc-en-ready',
    title: 'Concordância Masculina (Pronto / Obrigado)',
    speakerLabel: 'Emissor Homem · Voz ~118 Hz',
    gender: 'MASCULINO',
    simulatedPitchHz: 118,
    sourceLang: 'EN',
    inputText: "I'm completely ready for the presentation, thank you so much for waiting for me.",
    highlightNote: 'Exige flexão masculina: "pronto" e "muito obrigado"',
  },
  {
    id: 'fem-en-tired',
    title: 'Particípios e Adjetivos no Feminino',
    speakerLabel: 'Emissora Mulher · Voz ~198 Hz',
    gender: 'FEMININO',
    simulatedPitchHz: 198,
    sourceLang: 'EN',
    inputText: "I got a little lost on the way here and I'm tired, but I'm very excited to meet you all.",
    highlightNote: 'Exige "perdida", "cansada" e "animada"',
  },
  {
    id: 'masc-en-tired',
    title: 'Particípios e Adjetivos no Masculino',
    speakerLabel: 'Emissor Homem · Voz ~124 Hz',
    gender: 'MASCULINO',
    simulatedPitchHz: 124,
    sourceLang: 'EN',
    inputText: "I got a little lost on the way here and I'm tired, but I'm very excited to meet you all.",
    highlightNote: 'Exige "perdido", "cansado" e "animado"',
  },
  {
    id: 'pt-to-en-alternating',
    title: 'Conversão PT-BR → EN (ou Fixo PT-BR)',
    speakerLabel: 'Emissora Mulher · Voz ~205 Hz',
    gender: 'FEMININO',
    simulatedPitchHz: 205,
    sourceLang: 'PT-BR',
    inputText: 'Estou pronta para assinar o contrato hoje mesmo. Muito obrigada pela confiança em nosso trabalho.',
    highlightNote: 'Em Modo Alternado traduz para EN; em Modo Fixo mantém em PT-BR',
  },
  {
    id: 'masc-pt-to-en',
    title: 'Executivo Formal PT-BR → EN',
    speakerLabel: 'Emissor Homem · Voz ~110 Hz',
    gender: 'MASCULINO',
    simulatedPitchHz: 110,
    sourceLang: 'PT-BR',
    inputText: 'Fiquei muito satisfeito com os resultados do trimestre. Estou certo de que avançaremos rápido.',
    highlightNote: 'Preserva registro formal executivo na tradução',
  },
];
