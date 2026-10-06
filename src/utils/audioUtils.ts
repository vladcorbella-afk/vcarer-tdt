/**
 * Acoustic pitch detection (Autocorrelation F0 estimation),
 * 16kHz PCM encoding for Gemini Live API, and 24kHz gapless playback.
 */

export function detectFundamentalPitchHz(buffer: Float32Array, sampleRate: number): number | null {
  const size = buffer.length;
  let rms = 0;
  for (let i = 0; i < size; i++) {
    const val = buffer[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / size);
  // Ignore quiet background noise
  if (rms < 0.018) return null;

  let r1 = 0;
  let r2 = size - 1;
  const thres = 0.2;
  for (let i = 0; i < size / 2; i++) {
    if (Math.abs(buffer[i]) < thres) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < size / 2; i++) {
    if (Math.abs(buffer[size - i]) < thres) {
      r2 = size - i;
      break;
    }
  }

  const trimmed = buffer.slice(r1, r2);
  const newSize = trimmed.length;
  if (newSize < 64) return null;

  const c = new Float32Array(newSize).fill(0);
  for (let i = 0; i < newSize; i++) {
    for (let j = 0; j < newSize - i; j++) {
      c[i] = c[i] + trimmed[j] * trimmed[j + i];
    }
  }

  let d = 0;
  while (d < newSize - 1 && c[d] > c[d + 1]) {
    d++;
  }
  let maxval = -1;
  let maxpos = -1;
  for (let i = d; i < newSize; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }

  if (maxpos <= 0) return null;
  let T0 = maxpos;

  // Parabolic interpolation for higher precision
  if (T0 > 0 && T0 < newSize - 1) {
    const x1 = c[T0 - 1];
    const x2 = c[T0];
    const x3 = c[T0 + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) {
      T0 = T0 - b / (2 * a);
    }
  }

  const freq = sampleRate / T0;
  // Human vocal fundamental range filter (75 Hz to 340 Hz)
  if (freq >= 75 && freq <= 340) {
    return freq;
  }
  return null;
}

export function float32ToPcm16Base64(float32Array: Float32Array): string {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

export class Pcm24kPlayer {
  private ctx: AudioContext | null = null;
  private nextStartTime = 0;
  private activeNodes: AudioBufferSourceNode[] = [];

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      this.nextStartTime = 0;
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  playChunkBase64(base64Pcm: string): void {
    const ctx = this.ensureContext();
    const binary = atob(base64Pcm);
    const byteLength = binary.length;
    const sampleCount = Math.floor(byteLength / 2);
    if (sampleCount === 0) return;

    const bytes = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const int16 = new Int16Array(bytes.buffer, 0, sampleCount);
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    const audioBuffer = ctx.createBuffer(1, sampleCount, 24000);
    audioBuffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (this.nextStartTime < now) {
      this.nextStartTime = now + 0.02;
    }

    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
    this.activeNodes.push(source);

    source.onended = () => {
      this.activeNodes = this.activeNodes.filter((n) => n !== source);
    };
  }

  interrupt(): void {
    for (const node of this.activeNodes) {
      try {
        node.stop();
        node.disconnect();
      } catch {
        // ignore already stopped
      }
    }
    this.activeNodes = [];
    if (this.ctx) {
      this.nextStartTime = this.ctx.currentTime;
    }
  }

  close(): void {
    this.interrupt();
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close();
    }
    this.ctx = null;
  }
}

let currentAudioElement: HTMLAudioElement | null = null;

export function stopCurrentPlayback(): void {
  if (currentAudioElement) {
    currentAudioElement.pause();
    currentAudioElement.currentTime = 0;
    currentAudioElement = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

export async function playWavBase64(
  base64Wav: string | null,
  fallbackText?: string,
  targetLang: 'PT-BR' | 'EN' = 'PT-BR',
  onStart?: () => void,
  onEnd?: () => void,
  gender: 'FEMININO' | 'MASCULINO' = 'FEMININO'
): Promise<void> {
  stopCurrentPlayback();

  if (base64Wav) {
    try {
      const binary = atob(base64Wav);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudioElement = audio;

      audio.onplay = () => onStart?.();
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (currentAudioElement === audio) currentAudioElement = null;
        onEnd?.();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        if (currentAudioElement === audio) currentAudioElement = null;
        onEnd?.();
      };

      await audio.play();
      return;
    } catch (e) {
      console.warn('WAV playback fallback to SpeechSynthesis:', e);
    }
  }

  if (fallbackText && typeof window !== 'undefined' && 'speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(fallbackText);
    const langPrefix = targetLang === 'PT-BR' ? 'pt' : 'en';
    utterance.lang = targetLang === 'PT-BR' ? 'pt-BR' : 'en-US';
    utterance.pitch = gender === 'FEMININO' ? 1.08 : 0.92;

    const voices = window.speechSynthesis.getVoices();
    const langVoices = voices.filter((v) =>
      v.lang.toLowerCase().startsWith(langPrefix)
    );
    if (langVoices.length > 0) {
      const preferred = langVoices.find((v) => {
        const name = v.name.toLowerCase();
        if (gender === 'FEMININO') {
          return (
            name.includes('luciana') ||
            name.includes('francisca') ||
            name.includes('maria') ||
            name.includes('samantha') ||
            name.includes('victoria') ||
            name.includes('female')
          );
        }
        return (
          name.includes('daniel') ||
          name.includes('antonio') ||
          name.includes('felipe') ||
          name.includes('alex') ||
          name.includes('david') ||
          name.includes('male')
        );
      });
      if (preferred) {
        utterance.voice = preferred;
      } else {
        utterance.voice = langVoices[0];
      }
    }

    utterance.onstart = () => onStart?.();
    utterance.onend = () => onEnd?.();
    utterance.onerror = () => onEnd?.();
    window.speechSynthesis.speak(utterance);
  } else {
    onEnd?.();
  }
}

export function cleanClientErrorMessage(rawError: unknown): string {
  if (!rawError) return 'Erro desconhecido na tradução.';

  let str = '';
  if (rawError instanceof Error) {
    str = rawError.message;
  } else if (typeof rawError === 'string') {
    str = rawError;
  } else if (typeof rawError === 'object') {
    const obj = rawError as Record<string, any>;
    if (typeof obj.message === 'string') {
      str = obj.message;
    } else if (obj.error && typeof obj.error.message === 'string') {
      str = obj.error.message;
    } else if (typeof obj.error === 'string') {
      str = obj.error;
    } else if (typeof obj.code === 'string') {
      str = obj.code;
    } else {
      try {
        str = JSON.stringify(rawError);
      } catch {
        str = 'Erro de comunicação com o servidor.';
      }
    }
  } else {
    str = String(rawError);
  }

  if (
    str.includes('[object Object]') ||
    str.includes('NOT_FOUND') ||
    str.includes('The page could not be found') ||
    str.includes('The page c')
  ) {
    return 'Rota /api não encontrada no deploy atual da Vercel. Faça o commit/deploy das novas funções /api e verifique a variável GEMINI_API_KEY na Vercel.';
  }

  if (str.includes('Unexpected token') || str.includes('is not valid JSON')) {
    return 'O servidor está reiniciando ou reconectando. Aguarde 2 segundos e tente novamente.';
  }

  try {
    const match = str.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed?.error?.code === 503 || parsed?.error?.status === 'UNAVAILABLE') {
        return 'Alta demanda momentânea no modelo de voz. Tentando reconexão automática — tente novamente em alguns segundos.';
      }
      if (parsed?.error?.code === 'NOT_FOUND' || parsed?.code === 'NOT_FOUND') {
        return 'Rota /api não encontrada no deploy da Vercel. Atualize o deploy com a pasta /api e configure GEMINI_API_KEY na Vercel.';
      }
      if (typeof parsed?.error?.message === 'string') {
        return parsed.error.message;
      }
      if (typeof parsed?.message === 'string') {
        return parsed.message;
      }
    }
  } catch {
    // ignore
  }
  return str;
}

export async function postJsonWithRetry<T>(
  url: string,
  payload: unknown,
  maxAttempts = 2
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const rawText = await response.text();
      let data: Record<string, any> | null = null;

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 700 * attempt));
          continue;
        }
        throw new Error(cleanClientErrorMessage(rawText));
      }

      if (!response.ok) {
        const extractedError =
          data?.error ?? data?.message ?? `Erro HTTP ${response.status}`;
        const msg = cleanClientErrorMessage(extractedError);
        if (
          (response.status === 503 ||
            response.status === 429 ||
            response.status === 502 ||
            response.status === 504) &&
          attempt < maxAttempts
        ) {
          await new Promise((r) => setTimeout(r, 600 * attempt));
          continue;
        }
        throw new Error(msg);
      }
      return data as T;
    } catch (err: unknown) {
      lastError =
        err instanceof Error
          ? new Error(cleanClientErrorMessage(err.message))
          : new Error(cleanClientErrorMessage(err));
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }

  throw lastError || new Error('Falha de comunicação com o servidor de tradução.');
}
