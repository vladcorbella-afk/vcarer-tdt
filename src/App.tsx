import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Mic,
  Square,
  Volume2,
  VolumeX,
  Copy,
  Check,
  Radio,
  Send,
  Trash2,
  Download,
  RefreshCw,
  AlertCircle,
  Search,
  Sparkles,
  History as HistoryIcon,
} from 'lucide-react';
import {
  OperationMode,
  GenderMode,
  EngineMode,
  InterpretationTurn,
  TestScenario,
} from './types/interpreter';
import {
  detectFundamentalPitchHz,
  float32ToPcm16Base64,
  Pcm24kPlayer,
  playWavBase64,
  stopCurrentPlayback,
  postJsonWithRetry,
  cleanClientErrorMessage,
} from './utils/audioUtils';
import { AcousticScope } from './components/AcousticScope';
import { ScenarioBench } from './components/ScenarioBench';
import { RulesProtocolSection } from './components/RulesProtocolSection';

type ActiveTab = 'interprete' | 'exemplos' | 'historico';

const INITIAL_HISTORY: InterpretationTurn[] = [
  {
    id: 'init-1',
    timestamp: '11:42',
    sourceTranscript: "I'm ready to start the review right now, thank you so much for waiting.",
    translation: 'Estou pronta para começar a revisão agora mesmo, muito obrigada por esperar.',
    detectedLanguage: 'EN',
    targetLanguage: 'PT-BR',
    detectedGender: 'FEMININO',
    detectedTone: 'Natural e cordial',
    genderAdaptations: ['pronta (feminino)', 'obrigada (feminino)'],
    acousticPitchHz: 210,
    audioWavBase64: null,
    voiceUsed: 'Kore',
    mode: 'ALTERNADO',
  },
  {
    id: 'init-2',
    timestamp: '11:43',
    sourceTranscript: 'Estou pronto para apresentar o cronograma técnico, muito obrigado a todos.',
    translation: 'I am ready to present the technical schedule, thank you very much everyone.',
    detectedLanguage: 'PT-BR',
    targetLanguage: 'EN',
    detectedGender: 'MASCULINO',
    detectedTone: 'Formal executivo',
    genderAdaptations: ['pronto → ready (masculino)'],
    acousticPitchHz: 116,
    audioWavBase64: null,
    voiceUsed: 'Fenrir',
    mode: 'ALTERNADO',
  },
];

export default function App() {
  // Navigation Tab State (keeps mobile & tablet clean and single-screen)
  const [activeTab, setActiveTab] = useState<ActiveTab>('interprete');

  // Core Interpreter State
  const [operationMode, setOperationMode] = useState<OperationMode>('ALTERNADO');
  const [genderMode, setGenderMode] = useState<GenderMode>('AUTO');
  const [engineMode, setEngineMode] = useState<EngineMode>('TURN_PRECISION');
  const [autoSpeak, setAutoSpeak] = useState<boolean>(true);
  const [autoVadPause, setAutoVadPause] = useState<boolean>(true);

  // Audio & Processing State
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isLiveConnected, setIsLiveConnected] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isPlayingOutput, setIsPlayingOutput] = useState<boolean>(false);
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Acoustic Telemetry State
  const [spectrumBars, setSpectrumBars] = useState<number[]>(Array(24).fill(15));
  const [currentPitchHz, setCurrentPitchHz] = useState<number | null>(null);

  // Output & History State
  const [history, setHistory] = useState<InterpretationTurn[]>(INITIAL_HISTORY);
  const [currentTurn, setCurrentTurn] = useState<InterpretationTurn | null>(INITIAL_HISTORY[0]);
  const [liveInputTranscript, setLiveInputTranscript] = useState<string>('');
  const [liveOutputTranscript, setLiveOutputTranscript] = useState<string>('');

  // Direct Input State
  const [directInputText, setDirectInputText] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [replayingTurnId, setReplayingTurnId] = useState<string | null>(null);

  // History Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [historyGenderFilter, setHistoryGenderFilter] = useState<'ALL' | 'FEMININO' | 'MASCULINO'>('ALL');

  // Refs for audio capture, VAD, pitch tracking, and Live WebSocket
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const pitchSamplesRef = useRef<number[]>([]);
  const vadSilenceStartRef = useRef<number | null>(null);
  const hasSpokenInTurnRef = useRef<boolean>(false);
  const autoVadRef = useRef<boolean>(autoVadPause);
  const operationModeRef = useRef<OperationMode>(operationMode);
  const genderModeRef = useRef<GenderMode>(genderMode);
  const autoSpeakRef = useRef<boolean>(autoSpeak);
  const historyRef = useRef<InterpretationTurn[]>(history);

  // Live API WebSocket Refs
  const liveWsRef = useRef<WebSocket | null>(null);
  const liveInputCtxRef = useRef<AudioContext | null>(null);
  const livePlayerRef = useRef<Pcm24kPlayer | null>(null);
  const liveInBufferRef = useRef<string>('');
  const liveOutBufferRef = useRef<string>('');

  useEffect(() => {
    autoVadRef.current = autoVadPause;
  }, [autoVadPause]);

  useEffect(() => {
    operationModeRef.current = operationMode;
  }, [operationMode]);

  useEffect(() => {
    genderModeRef.current = genderMode;
  }, [genderMode]);

  useEffect(() => {
    autoSpeakRef.current = autoSpeak;
  }, [autoSpeak]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const formatNowTime = () => {
    const now = new Date();
    return now.toTimeString().slice(0, 5);
  };

  const stopMicrophoneResources = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setSpectrumBars(Array(24).fill(15));
  }, []);

  const stopLiveSession = useCallback(() => {
    if (liveWsRef.current) {
      try {
        liveWsRef.current.close();
      } catch {
        // ignore
      }
      liveWsRef.current = null;
    }
    if (liveInputCtxRef.current && liveInputCtxRef.current.state !== 'closed') {
      liveInputCtxRef.current.close().catch(() => {});
      liveInputCtxRef.current = null;
    }
    if (livePlayerRef.current) {
      livePlayerRef.current.close();
      livePlayerRef.current = null;
    }
    stopMicrophoneResources();
    setIsLiveConnected(false);
  }, [stopMicrophoneResources]);

  useEffect(() => {
    return () => {
      stopLiveSession();
      stopCurrentPlayback();
    };
  }, [stopLiveSession]);

  // Process recorded audio blob via /api/interpret-audio
  const processRecordedAudioBlob = useCallback(
    async (blob: Blob, mimeType: string, medianPitchHz: number | null) => {
      if (blob.size < 800) {
        return;
      }
      setIsProcessing(true);
      setErrorMessage(null);

      try {
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const slice = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, Array.from(slice));
        }
        const audioBase64 = btoa(binary);

        const recentContext = historyRef.current.slice(0, 4).map((h) => ({
          source: h.sourceTranscript,
          translation: h.translation,
          gender: h.detectedGender,
        }));

        const data = await postJsonWithRetry<Record<string, any>>(
          '/api/interpret-audio',
          {
            audioBase64,
            mimeType,
            mode: operationModeRef.current,
            genderOverride: genderModeRef.current,
            acousticHintHz: medianPitchHz,
            conversationContext: recentContext,
            synthesizeAudio: true,
          },
          2
        );

        if (data.isSilenceOrNoise || !data.translation?.trim()) {
          setErrorMessage('Nenhuma fala nítida detectada. Fale mais próximo ao microfone.');
          return;
        }

        const newTurn: InterpretationTurn = {
          id: `turn-${Date.now()}`,
          timestamp: formatNowTime(),
          sourceTranscript: data.sourceTranscript || '(Áudio captado)',
          translation: data.translation.trim(),
          detectedLanguage: data.detectedLanguage === 'EN' ? 'EN' : 'PT-BR',
          targetLanguage: data.targetLanguage === 'EN' ? 'EN' : 'PT-BR',
          detectedGender: data.detectedGender === 'MASCULINO' ? 'MASCULINO' : 'FEMININO',
          detectedTone: data.detectedTone || 'Natural',
          genderAdaptations: Array.isArray(data.genderAdaptations) ? data.genderAdaptations : [],
          acousticPitchHz: medianPitchHz ? Math.round(medianPitchHz) : null,
          audioWavBase64: data.audioWavBase64 || null,
          voiceUsed: data.voiceUsed || (data.detectedGender === 'MASCULINO' ? 'Fenrir' : 'Kore'),
          mode: operationModeRef.current,
        };

        setCurrentTurn(newTurn);
        setHistory((prev) => [newTurn, ...prev]);

        if (autoSpeakRef.current) {
          await playWavBase64(
            newTurn.audioWavBase64,
            newTurn.translation,
            newTurn.targetLanguage,
            () => setIsPlayingOutput(true),
            () => setIsPlayingOutput(false),
            newTurn.detectedGender
          );
        }
      } catch (err: unknown) {
        setErrorMessage(cleanClientErrorMessage(err));
      } finally {
        setIsProcessing(false);
      }
    },
    []
  );

  // Start Turn Precision Microphone Recording
  const startTurnRecording = async () => {
    setErrorMessage(null);
    stopCurrentPlayback();
    setIsPlayingOutput(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const timeDomainData = new Float32Array(analyser.fftSize);
      const freqData = new Uint8Array(analyser.frequencyBinCount);

      pitchSamplesRef.current = [];
      vadSilenceStartRef.current = null;
      hasSpokenInTurnRef.current = false;

      const supportedMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType: supportedMime });
      recordedChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const chunks = recordedChunksRef.current;
        const samples = pitchSamplesRef.current.slice().sort((a, b) => a - b);
        const medianPitch =
          samples.length > 0 ? samples[Math.floor(samples.length / 2)] : null;

        stopMicrophoneResources();
        setIsRecording(false);

        if (chunks.length > 0) {
          const audioBlob = new Blob(chunks, { type: supportedMime.split(';')[0] });
          processRecordedAudioBlob(audioBlob, supportedMime.split(';')[0], medianPitch);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(150);
      setIsRecording(true);

      const monitorAcoustics = () => {
        if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') return;

        analyser.getFloatTimeDomainData(timeDomainData);
        analyser.getByteFrequencyData(freqData);

        const nextBars: number[] = [];
        const step = Math.floor(freqData.length / 36);
        for (let i = 0; i < 24; i++) {
          const raw = freqData[i * step] || 0;
          const pct = Math.max(15, Math.min(100, Math.round((raw / 255) * 100)));
          nextBars.push(pct);
        }
        setSpectrumBars(nextBars);

        const pitch = detectFundamentalPitchHz(timeDomainData, audioCtx.sampleRate);
        if (pitch) {
          setCurrentPitchHz(pitch);
          pitchSamplesRef.current.push(pitch);
          hasSpokenInTurnRef.current = true;
          vadSilenceStartRef.current = null;
        } else if (hasSpokenInTurnRef.current && autoVadRef.current) {
          let rms = 0;
          for (let i = 0; i < timeDomainData.length; i++) {
            rms += timeDomainData[i] * timeDomainData[i];
          }
          rms = Math.sqrt(rms / timeDomainData.length);
          if (rms < 0.015) {
            if (!vadSilenceStartRef.current) {
              vadSilenceStartRef.current = performance.now();
            } else if (performance.now() - vadSilenceStartRef.current > 1350) {
              if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                mediaRecorderRef.current.stop();
                return;
              }
            }
          } else {
            vadSilenceStartRef.current = null;
          }
        }

        animFrameRef.current = requestAnimationFrame(monitorAcoustics);
      };

      animFrameRef.current = requestAnimationFrame(monitorAcoustics);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? `Permissão de microfone necessária: ${err.message}`
          : 'Não foi possível acessar o microfone.';
      setErrorMessage(msg);
      setIsRecording(false);
    }
  };

  const stopTurnRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    } else {
      stopMicrophoneResources();
      setIsRecording(false);
    }
  };

  // Start / Stop Gemini Live WebSocket Simultaneous Stream
  const toggleLiveStreamSession = async () => {
    if (isLiveConnected) {
      stopLiveSession();
      return;
    }

    setErrorMessage(null);
    stopCurrentPlayback();
    setLiveInputTranscript('');
    setLiveOutputTranscript('');
    liveInBufferRef.current = '';
    liveOutBufferRef.current = '';

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const voiceParam = genderMode === 'MASCULINO' ? 'Fenrir' : 'Kore';
      const wsUrl = `${protocol}//${window.location.host}/ws/live?mode=${operationMode}&gender=${genderMode}&voice=${voiceParam}`;

      const ws = new WebSocket(wsUrl);
      liveWsRef.current = ws;
      const player = new Pcm24kPlayer();
      livePlayerRef.current = player;

      ws.onopen = () => {
        setIsLiveConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'audio' && msg.audio) {
            if (autoSpeakRef.current) {
              player.playChunkBase64(msg.audio);
            }
          } else if (msg.type === 'inputTranscription' && msg.text) {
            liveInBufferRef.current += msg.text;
            setLiveInputTranscript(liveInBufferRef.current.trim());
          } else if (msg.type === 'outputTranscription' && msg.text) {
            liveOutBufferRef.current += msg.text;
            setLiveOutputTranscript(liveOutBufferRef.current.trim());
          } else if (msg.type === 'turnComplete') {
            const finalOut = liveOutBufferRef.current.trim();
            const finalIn = liveInBufferRef.current.trim();
            if (finalOut) {
              const samples = pitchSamplesRef.current.slice().sort((a, b) => a - b);
              const medianPitch =
                samples.length > 0 ? Math.round(samples[Math.floor(samples.length / 2)]) : null;
              const inferredGender: 'FEMININO' | 'MASCULINO' =
                genderModeRef.current !== 'AUTO'
                  ? genderModeRef.current
                  : medianPitch && medianPitch < 160
                  ? 'MASCULINO'
                  : 'FEMININO';

              const turnObj: InterpretationTurn = {
                id: `live-${Date.now()}`,
                timestamp: formatNowTime(),
                sourceTranscript: finalIn || '(Stream de voz simultâneo)',
                translation: finalOut,
                detectedLanguage: 'PT-BR',
                targetLanguage: operationModeRef.current === 'FIXO_PT_BR' ? 'PT-BR' : 'EN',
                detectedGender: inferredGender,
                detectedTone: 'Simultâneo em tempo real',
                genderAdaptations: [],
                acousticPitchHz: medianPitch,
                audioWavBase64: null,
                voiceUsed: voiceParam,
                mode: operationModeRef.current,
              };
              setCurrentTurn(turnObj);
              setHistory((prev) => [turnObj, ...prev]);
            }
            liveInBufferRef.current = '';
            liveOutBufferRef.current = '';
            pitchSamplesRef.current = [];
          } else if (msg.type === 'interrupted') {
            player.interrupt();
          } else if (msg.type === 'error' && msg.error) {
            setErrorMessage(msg.error);
          }
        } catch (err) {
          console.error('Error parsing Live WS message:', err);
        }
      };

      ws.onerror = () => {
        setErrorMessage('Conexão Live ocupada. Use o modo Turno de Voz para tradução imediata.');
        stopLiveSession();
      };

      ws.onclose = () => {
        stopLiveSession();
      };

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      liveInputCtxRef.current = inputCtx;
      const source = inputCtx.createMediaStreamSource(stream);
      const analyser = inputCtx.createAnalyser();
      analyser.fftSize = 1024;
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(inputCtx.destination);

      const freqData = new Uint8Array(analyser.frequencyBinCount);

      processor.onaudioprocess = (e) => {
        const inputBuffer = e.inputBuffer.getChannelData(0);
        const pitch = detectFundamentalPitchHz(inputBuffer, 16000);
        if (pitch) {
          setCurrentPitchHz(pitch);
          pitchSamplesRef.current.push(pitch);
        }

        analyser.getByteFrequencyData(freqData);
        const nextBars: number[] = [];
        const step = Math.floor(freqData.length / 28);
        for (let i = 0; i < 24; i++) {
          const raw = freqData[i * step] || 0;
          nextBars.push(Math.max(15, Math.min(100, Math.round((raw / 255) * 100))));
        }
        setSpectrumBars(nextBars);

        if (ws.readyState === WebSocket.OPEN) {
          const base64Pcm = float32ToPcm16Base64(inputBuffer);
          ws.send(JSON.stringify({ audio: base64Pcm }));
        }
      };
    } catch (err: unknown) {
      setErrorMessage(cleanClientErrorMessage(err));
      stopLiveSession();
    }
  };

  // Interpret Text or Preset Scenario
  const runTextOrScenarioInterpretation = async (
    textToInterpret: string,
    overrideGender?: GenderMode,
    simulatedPitchHz?: number | null,
    scenarioId?: string
  ) => {
    if (!textToInterpret.trim() || isProcessing) return;

    setIsProcessing(true);
    setErrorMessage(null);
    if (scenarioId) setActiveScenarioId(scenarioId);
    if (simulatedPitchHz) setCurrentPitchHz(simulatedPitchHz);

    try {
      const effectiveGender = overrideGender || genderMode;
      const recentContext = history.slice(0, 4).map((h) => ({
        source: h.sourceTranscript,
        translation: h.translation,
        gender: h.detectedGender,
      }));

      const data = await postJsonWithRetry<Record<string, any>>(
        '/api/interpret-text',
        {
          text: textToInterpret.trim(),
          mode: operationMode,
          genderOverride: effectiveGender,
          acousticHintHz: simulatedPitchHz ?? currentPitchHz,
          conversationContext: recentContext,
          synthesizeAudio: true,
        },
        2
      );

      const newTurn: InterpretationTurn = {
        id: `turn-${Date.now()}`,
        timestamp: formatNowTime(),
        sourceTranscript: data.sourceTranscript || textToInterpret.trim(),
        translation: data.translation.trim(),
        detectedLanguage: data.detectedLanguage === 'EN' ? 'EN' : 'PT-BR',
        targetLanguage: data.targetLanguage === 'EN' ? 'EN' : 'PT-BR',
        detectedGender: data.detectedGender === 'MASCULINO' ? 'MASCULINO' : 'FEMININO',
        detectedTone: data.detectedTone || 'Natural',
        genderAdaptations: Array.isArray(data.genderAdaptations) ? data.genderAdaptations : [],
        acousticPitchHz: simulatedPitchHz ?? (currentPitchHz ? Math.round(currentPitchHz) : null),
        audioWavBase64: data.audioWavBase64 || null,
        voiceUsed: data.voiceUsed || (data.detectedGender === 'MASCULINO' ? 'Fenrir' : 'Kore'),
        mode: operationMode,
      };

      setCurrentTurn(newTurn);
      setHistory((prev) => [newTurn, ...prev]);
      setActiveTab('interprete');

      if (autoSpeak) {
        await playWavBase64(
          newTurn.audioWavBase64,
          newTurn.translation,
          newTurn.targetLanguage,
          () => setIsPlayingOutput(true),
          () => setIsPlayingOutput(false),
          newTurn.detectedGender
        );
      }
    } catch (err: unknown) {
      setErrorMessage(cleanClientErrorMessage(err));
    } finally {
      setIsProcessing(false);
      setActiveScenarioId(null);
    }
  };

  const handleRunScenario = (scenario: TestScenario) => {
    const effectiveGender: GenderMode =
      genderMode === 'AUTO' ? scenario.gender : genderMode;
    runTextOrScenarioInterpretation(
      scenario.inputText,
      effectiveGender,
      scenario.simulatedPitchHz,
      scenario.id
    );
  };

  const handleDirectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!directInputText.trim()) return;
    const text = directInputText;
    setDirectInputText('');
    runTextOrScenarioInterpretation(text);
  };

  const handleReplayTurnAudio = async (turn: InterpretationTurn) => {
    if (replayingTurnId === turn.id && isPlayingOutput) {
      stopCurrentPlayback();
      setIsPlayingOutput(false);
      setReplayingTurnId(null);
      return;
    }

    setReplayingTurnId(turn.id);
    if (turn.audioWavBase64) {
      await playWavBase64(
        turn.audioWavBase64,
        turn.translation,
        turn.targetLanguage,
        () => setIsPlayingOutput(true),
        () => {
          setIsPlayingOutput(false);
          setReplayingTurnId(null);
        },
        turn.detectedGender
      );
      return;
    }

    try {
      setIsPlayingOutput(true);
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: turn.translation,
          gender: turn.detectedGender,
          tone: turn.detectedTone,
        }),
      });
      const data = await res.json();
      if (res.ok && data.audioWavBase64) {
        setHistory((prev) =>
          prev.map((item) =>
            item.id === turn.id ? { ...item, audioWavBase64: data.audioWavBase64 } : item
          )
        );
        if (currentTurn?.id === turn.id) {
          setCurrentTurn((prev) =>
            prev ? { ...prev, audioWavBase64: data.audioWavBase64 } : prev
          );
        }
        await playWavBase64(
          data.audioWavBase64,
          turn.translation,
          turn.targetLanguage,
          () => setIsPlayingOutput(true),
          () => {
            setIsPlayingOutput(false);
            setReplayingTurnId(null);
          },
          turn.detectedGender
        );
      } else {
        await playWavBase64(
          null,
          turn.translation,
          turn.targetLanguage,
          () => setIsPlayingOutput(true),
          () => {
            setIsPlayingOutput(false);
            setReplayingTurnId(null);
          },
          turn.detectedGender
        );
      }
    } catch {
      setIsPlayingOutput(false);
      setReplayingTurnId(null);
    }
  };

  const handleCopyTranslation = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 1800);
  };

  const handleExportSession = () => {
    const content = history
      .map(
        (t) =>
          `[${t.timestamp}] (${t.mode} | Emissor: ${t.detectedGender}${
            t.acousticPitchHz ? ` ~${t.acousticPitchHz}Hz` : ''
          } | ${t.detectedLanguage} -> ${t.targetLanguage})\nEmissor: ${
            t.sourceTranscript
          }\nTradução Pura: ${t.translation}\n`
      )
      .join('\n----------------------------------------\n');

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voxvcarer-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredHistory = history.filter((item) => {
    const matchesGender =
      historyGenderFilter === 'ALL' || item.detectedGender === historyGenderFilter;
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      item.translation.toLowerCase().includes(q) ||
      item.sourceTranscript.toLowerCase().includes(q);
    return matchesGender && matchesSearch;
  });

  const displayedOutputText =
    engineMode === 'LIVE_STREAM' && isLiveConnected && liveOutputTranscript
      ? liveOutputTranscript
      : currentTurn?.translation || '';

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-[#0B0F17] text-slate-100 flex flex-col pb-16 md:pb-0">
      {/* 3-Zone Top Navigation Bar */}
      <header className="w-full flex items-center justify-between px-4 sm:px-6 h-14 border-b border-slate-800/90 bg-[#0B0F17]">
        {/* Zone 1: Brand Title */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('interprete');
          }}
          className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap"
        >
          VoxVcarer
        </a>

        {/* Zone 2: Desktop & Tablet Navigation Links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <button
            type="button"
            onClick={() => setActiveTab('interprete')}
            className={`py-1 transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'interprete'
                ? 'text-emerald-400 underline underline-offset-8 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            Intérprete
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('exemplos')}
            className={`py-1 transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'exemplos'
                ? 'text-emerald-400 underline underline-offset-8 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            Exemplos e Regras
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('historico')}
            className={`py-1 transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'historico'
                ? 'text-emerald-400 underline underline-offset-8 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            Histórico ({history.length})
          </button>
        </nav>

        {/* Zone 3: Quick Voice Toggle Action */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (autoSpeak) stopCurrentPlayback();
              setAutoSpeak((v) => !v);
            }}
            className={`min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
              autoSpeak
                ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                : 'border-slate-800 bg-[#111827] text-slate-400'
            }`}
          >
            {autoSpeak ? (
              <>
                <Volume2 className="w-3.5 h-3.5 shrink-0" />
                <span>Voz Ativa</span>
              </>
            ) : (
              <>
                <VolumeX className="w-3.5 h-3.5 shrink-0" />
                <span>Mudo</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Responsive Container */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-3.5 sm:px-6 py-4 sm:py-6 space-y-4">
        {errorMessage && (
          <div className="border border-red-500/40 bg-red-950/30 text-red-200 rounded-xl px-4 py-3 text-xs sm:text-sm flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span className="break-words">{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="min-h-[36px] px-2 text-xs text-red-300 hover:text-white underline shrink-0 cursor-pointer"
            >
              Fechar
            </button>
          </div>
        )}

        {/* TAB 1: INTÉRPRETE (Main Single-Screen Mobile/Tablet/Desktop View) */}
        {activeTab === 'interprete' && (
          <div className="space-y-4">
            {/* Compact 2-Card Mode & Gender Selector Bar */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Operation Mode */}
              <div className="bg-[#111827] border border-slate-800 rounded-xl p-2.5">
                <div className="text-[11px] text-slate-400 font-medium px-1 mb-1.5">
                  1. Modo de Operação
                </div>
                <div className="grid grid-cols-2 gap-1.5 bg-[#0B0F17] p-1 rounded-lg border border-slate-800/80">
                  <button
                    type="button"
                    onClick={() => setOperationMode('ALTERNADO')}
                    className={`min-h-[42px] px-2 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer text-center leading-tight ${
                      operationMode === 'ALTERNADO'
                        ? 'bg-emerald-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    Alternado (PT ↔ EN)
                  </button>
                  <button
                    type="button"
                    onClick={() => setOperationMode('FIXO_PT_BR')}
                    className={`min-h-[42px] px-2 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer text-center leading-tight ${
                      operationMode === 'FIXO_PT_BR'
                        ? 'bg-emerald-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    Fixo Pessoa 2 (Só PT-BR)
                  </button>
                </div>
              </div>

              {/* Speaker Gender Agreement */}
              <div className="bg-[#111827] border border-slate-800 rounded-xl p-2.5">
                <div className="text-[11px] text-slate-400 font-medium px-1 mb-1.5">
                  2. Concordância de Gênero (Emissor)
                </div>
                <div className="grid grid-cols-3 gap-1.5 bg-[#0B0F17] p-1 rounded-lg border border-slate-800/80">
                  <button
                    type="button"
                    onClick={() => setGenderMode('AUTO')}
                    className={`min-h-[42px] px-2 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer text-center leading-tight ${
                      genderMode === 'AUTO'
                        ? 'bg-slate-200 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    Auto (Voz)
                  </button>
                  <button
                    type="button"
                    onClick={() => setGenderMode('FEMININO')}
                    className={`min-h-[42px] px-2 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer text-center leading-tight ${
                      genderMode === 'FEMININO'
                        ? 'bg-rose-400 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    Mulher (Fem.)
                  </button>
                  <button
                    type="button"
                    onClick={() => setGenderMode('MASCULINO')}
                    className={`min-h-[42px] px-2 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer text-center leading-tight ${
                      genderMode === 'MASCULINO'
                        ? 'bg-sky-400 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    Homem (Masc.)
                  </button>
                </div>
              </div>
            </div>

            {/* Responsive Split Stage: Output Display + Voice Capture */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
              {/* Listener Pure Output Stage (7 cols on Desktop, Top on Mobile/Tablet) */}
              <div className="lg:col-span-7 flex flex-col justify-between border border-slate-800 bg-[#111827] rounded-2xl p-4 sm:p-6">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400 font-mono tabular-nums">
                      <span className="text-emerald-400 font-semibold">
                        TRADUÇÃO FINAL
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {operationMode === 'FIXO_PT_BR'
                          ? 'Sempre PT-BR'
                          : currentTurn
                          ? `${currentTurn.detectedLanguage} → ${currentTurn.targetLanguage}`
                          : 'PT-BR ↔ EN'}
                      </span>
                    </div>

                    {currentTurn && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleReplayTurnAudio(currentTurn)}
                          className="min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <Volume2
                            className={`w-4 h-4 shrink-0 ${
                              isPlayingOutput ? 'text-sky-400 animate-pulse' : ''
                            }`}
                          />
                          <span>{isPlayingOutput ? 'Tocando...' : 'Ouvir'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            handleCopyTranslation(currentTurn.id, currentTurn.translation)
                          }
                          className="min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          {copiedId === currentTurn.id ? (
                            <>
                              <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                              <span>Copiado</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-4 h-4 shrink-0" />
                              <span>Copiar</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Pure Output Box (Rule 3: Only the final translation, zero metadata inside) */}
                  <div className="my-4 min-h-[140px] sm:min-h-[180px] flex flex-col justify-center bg-[#0B0F17] border border-slate-800/90 rounded-xl p-4 sm:p-6">
                    {isProcessing ? (
                      <div className="space-y-2.5" aria-live="polite">
                        <div className="h-5 w-4/5 bg-slate-800 rounded animate-pulse" />
                        <div className="h-5 w-1/2 bg-slate-800/60 rounded animate-pulse" />
                      </div>
                    ) : displayedOutputText ? (
                      <p
                        className="text-xl sm:text-2xl md:text-3xl font-semibold text-slate-50 leading-snug break-words select-all"
                        aria-live="polite"
                      >
                        {displayedOutputText}
                      </p>
                    ) : (
                      <p className="text-sm sm:text-base text-slate-500">
                        Toque no botão de microfone ou digite abaixo. Apenas a tradução exata será exibida e falada aqui.
                      </p>
                    )}
                  </div>
                </div>

                {/* Unboxed Clean Telemetry Line */}
                {currentTurn && (
                  <div className="pt-3 border-t border-slate-800/80 space-y-1.5 text-xs text-slate-400">
                    <div className="text-slate-300 italic break-words">
                      Emissor ({currentTurn.detectedLanguage}): "
                      {engineMode === 'LIVE_STREAM' && isLiveConnected && liveInputTranscript
                        ? liveInputTranscript
                        : currentTurn.sourceTranscript}
                      "
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 font-mono tabular-nums text-[11px] text-slate-400">
                      <span
                        className={
                          currentTurn.detectedGender === 'FEMININO'
                            ? 'text-rose-300 font-semibold'
                            : 'text-sky-300 font-semibold'
                        }
                      >
                        {currentTurn.detectedGender === 'FEMININO' ? 'Mulher (Fem.)' : 'Homem (Masc.)'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>Voz: {currentTurn.voiceUsed || 'Kore'}</span>
                      {currentTurn.genderAdaptations.length > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-emerald-300">
                            {currentTurn.genderAdaptations.join(', ')}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Speaker Capture Card (5 cols on Desktop) */}
              <div className="lg:col-span-5 flex flex-col justify-between border border-slate-800 bg-[#111827] rounded-2xl p-4 sm:p-5 space-y-4">
                <div className="space-y-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-100">
                      Captação do Emissor
                    </span>

                    {/* Compact Engine Switch */}
                    <div className="inline-flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded-lg">
                      <button
                        type="button"
                        onClick={() => {
                          if (isLiveConnected) stopLiveSession();
                          setEngineMode('TURN_PRECISION');
                        }}
                        className={`min-h-[32px] px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                          engineMode === 'TURN_PRECISION'
                            ? 'bg-slate-800 text-slate-100'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Por Turno
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (isRecording) stopTurnRecording();
                          setEngineMode('LIVE_STREAM');
                        }}
                        className={`min-h-[32px] px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                          engineMode === 'LIVE_STREAM'
                            ? 'bg-slate-800 text-slate-100'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Live Contínuo
                      </button>
                    </div>
                  </div>

                  {/* Primary Big Touch Microphone Button */}
                  {engineMode === 'TURN_PRECISION' ? (
                    <div className="space-y-2">
                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={isRecording ? stopTurnRecording : startTurnRecording}
                        className={`w-full min-h-[54px] px-4 py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2.5 transition-colors cursor-pointer ${
                          isRecording
                            ? 'bg-red-500 text-slate-950 hover:bg-red-400'
                            : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-50'
                        }`}
                      >
                        {isRecording ? (
                          <>
                            <Square className="w-4 h-4 fill-current shrink-0" />
                            <span>Finalizar e Traduzir Agora</span>
                          </>
                        ) : isProcessing ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                            <span>Traduzindo Fala...</span>
                          </>
                        ) : (
                          <>
                            <Mic className="w-5 h-5 shrink-0" />
                            <span>Toque para Falar (Microfone)</span>
                          </>
                        )}
                      </button>

                      <div className="flex items-center justify-between text-xs text-slate-400 px-1">
                        <span>Pausa automática (1.3s)</span>
                        <button
                          type="button"
                          onClick={() => setAutoVadPause((v) => !v)}
                          className="text-emerald-400 hover:underline font-medium cursor-pointer"
                        >
                          {autoVadPause ? 'Ativada' : 'Desativada (Manual)'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={toggleLiveStreamSession}
                      className={`w-full min-h-[54px] px-4 py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2.5 transition-colors cursor-pointer ${
                        isLiveConnected
                          ? 'bg-red-500 text-slate-950 hover:bg-red-400'
                          : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                      }`}
                    >
                      <Radio className={`w-5 h-5 shrink-0 ${isLiveConnected ? 'animate-pulse' : ''}`} />
                      <span>
                        {isLiveConnected ? 'Encerrar Stream Live' : 'Iniciar Stream Simultâneo'}
                      </span>
                    </button>
                  )}

                  {/* Integrated Compact Acoustic Visualizer */}
                  <AcousticScope
                    isRecording={isRecording}
                    isLiveConnected={isLiveConnected}
                    isSynthesizing={isProcessing}
                    isPlayingOutput={isPlayingOutput}
                    bars={spectrumBars}
                    currentPitchHz={currentPitchHz}
                    lockedGender={genderMode}
                    lastDetectedGender={currentTurn?.detectedGender || null}
                  />
                </div>

                {/* Simple Direct Text Input */}
                <form onSubmit={handleDirectSubmit} className="pt-3 border-t border-slate-800">
                  <label
                    htmlFor="direct-speech-input"
                    className="block text-xs font-medium text-slate-400 mb-1.5"
                  >
                    Ou digite uma frase para traduzir:
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="direct-speech-input"
                      type="text"
                      value={directInputText}
                      onChange={(e) => setDirectInputText(e.target.value)}
                      placeholder="Ex: I'm ready, thank you!"
                      className="min-w-0 flex-1 min-h-[44px] bg-[#0B0F17] border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                    />
                    <button
                      type="submit"
                      disabled={isProcessing || !directInputText.trim()}
                      className="min-h-[44px] px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-semibold text-slate-100 inline-flex items-center justify-center gap-1.5 transition-colors shrink-0 cursor-pointer"
                    >
                      <Send className="w-4 h-4 shrink-0" />
                      <span>Enviar</span>
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: EXEMPLOS E REGRAS (Responsive Cards, No Overflow) */}
        {activeTab === 'exemplos' && (
          <div className="space-y-6">
            <ScenarioBench
              activeMode={operationMode}
              isProcessing={isProcessing}
              activeScenarioId={activeScenarioId}
              onRunScenario={handleRunScenario}
            />
            <RulesProtocolSection />
          </div>
        )}

        {/* TAB 3: HISTÓRICO (Responsive Stacked Cards instead of wide table) */}
        {activeTab === 'historico' && (
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
              <div>
                <h2 className="text-base sm:text-lg font-semibold text-slate-100">
                  Histórico de Traduções ({filteredHistory.length})
                </h2>
                <p className="text-xs sm:text-sm text-slate-400">
                  Toque em qualquer tradução para ouvir novamente ou copiar.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={history.length === 0}
                  onClick={handleExportSession}
                  className="min-h-[40px] px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-800 bg-[#111827] hover:bg-slate-800 text-slate-200 disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>Baixar .TXT</span>
                </button>

                <button
                  type="button"
                  disabled={history.length === 0}
                  onClick={() => {
                    stopCurrentPlayback();
                    setHistory([]);
                    setCurrentTurn(null);
                  }}
                  className="min-h-[40px] px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-800 bg-[#111827] hover:bg-red-950/40 text-slate-400 hover:text-red-300 disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Limpar</span>
                </button>
              </div>
            </div>

            {/* Filter Bar */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Buscar no histórico..."
                  className="w-full min-h-[42px] bg-[#111827] border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs sm:text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-3 gap-1 p-1 bg-[#111827] border border-slate-800 rounded-xl">
                <button
                  type="button"
                  onClick={() => setHistoryGenderFilter('ALL')}
                  className={`min-h-[34px] px-3 py-1 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                    historyGenderFilter === 'ALL'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Todos
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryGenderFilter('FEMININO')}
                  className={`min-h-[34px] px-3 py-1 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                    historyGenderFilter === 'FEMININO'
                      ? 'bg-slate-800 text-rose-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Mulher
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryGenderFilter('MASCULINO')}
                  className={`min-h-[34px] px-3 py-1 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                    historyGenderFilter === 'MASCULINO'
                      ? 'bg-slate-800 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Homem
                </button>
              </div>
            </div>

            {filteredHistory.length === 0 ? (
              <div className="border border-slate-800 bg-[#111827] rounded-2xl p-8 text-center space-y-3">
                <p className="text-sm text-slate-400">
                  Nenhum turno encontrado no histórico.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setHistoryGenderFilter('ALL');
                    setHistory(INITIAL_HISTORY);
                    setCurrentTurn(INITIAL_HISTORY[0]);
                  }}
                  className="min-h-[42px] px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition-colors cursor-pointer"
                >
                  Restaurar Exemplos Iniciais
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {filteredHistory.map((turn) => {
                  const isPlayingThis = replayingTurnId === turn.id && isPlayingOutput;
                  return (
                    <div
                      key={turn.id}
                      className="border border-slate-800 bg-[#111827] rounded-xl p-4 flex flex-col justify-between gap-3"
                    >
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums text-slate-400">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={
                                turn.detectedGender === 'FEMININO'
                                  ? 'text-rose-300 font-semibold'
                                  : 'text-sky-300 font-semibold'
                              }
                            >
                              {turn.detectedGender === 'FEMININO' ? 'Mulher' : 'Homem'}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>
                              {turn.detectedLanguage} → {turn.targetLanguage}
                            </span>
                            {turn.acousticPitchHz && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{turn.acousticPitchHz} Hz</span>
                              </>
                            )}
                          </div>
                          <span>{turn.timestamp}</span>
                        </div>

                        <p className="text-base font-semibold text-slate-100 leading-snug break-words">
                          {turn.translation}
                        </p>

                        <p className="text-xs text-slate-400 italic break-words">
                          Original: "{turn.sourceTranscript}"
                        </p>
                      </div>

                      <div className="pt-2.5 border-t border-slate-800/80 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleReplayTurnAudio(turn)}
                          className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <Volume2
                            className={`w-4 h-4 shrink-0 ${
                              isPlayingThis ? 'text-sky-400 animate-pulse' : ''
                            }`}
                          />
                          <span>{isPlayingThis ? 'Tocando...' : 'Ouvir'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleCopyTranslation(turn.id, turn.translation)}
                          className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          {copiedId === turn.id ? (
                            <>
                              <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                              <span>Copiado</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-4 h-4 shrink-0" />
                              <span>Copiar</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </main>

      {/* Mobile Ergonomic Bottom Navigation Bar (md:hidden, height 56px <= 15% viewport cap) */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-14 bg-[#0B0F17]/95 backdrop-blur-md border-t border-slate-800 grid grid-cols-3 items-center px-2"
        aria-label="Navegação Mobile"
      >
        <button
          type="button"
          onClick={() => setActiveTab('interprete')}
          className={`min-h-[44px] flex flex-col items-center justify-center rounded-lg transition-colors cursor-pointer ${
            activeTab === 'interprete' ? 'text-emerald-400' : 'text-slate-400'
          }`}
        >
          <Mic className="w-5 h-5" />
          <span className="text-[11px] font-medium mt-0.5">Intérprete</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('exemplos')}
          className={`min-h-[44px] flex flex-col items-center justify-center rounded-lg transition-colors cursor-pointer ${
            activeTab === 'exemplos' ? 'text-emerald-400' : 'text-slate-400'
          }`}
        >
          <Sparkles className="w-5 h-5" />
          <span className="text-[11px] font-medium mt-0.5">Exemplos</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('historico')}
          className={`min-h-[44px] flex flex-col items-center justify-center rounded-lg transition-colors cursor-pointer ${
            activeTab === 'historico' ? 'text-emerald-400' : 'text-slate-400'
          }`}
        >
          <HistoryIcon className="w-5 h-5" />
          <span className="text-[11px] font-medium mt-0.5">
            Histórico ({history.length})
          </span>
        </button>
      </nav>
    </div>
  );
}
