import React from 'react';
import { GenderMode } from '../types/interpreter';

interface AcousticScopeProps {
  isRecording: boolean;
  isLiveConnected: boolean;
  isSynthesizing: boolean;
  isPlayingOutput: boolean;
  bars: number[];
  currentPitchHz: number | null;
  lockedGender: GenderMode;
  lastDetectedGender: 'FEMININO' | 'MASCULINO' | null;
}

export const AcousticScope: React.FC<AcousticScopeProps> = ({
  isRecording,
  isLiveConnected,
  isSynthesizing,
  isPlayingOutput,
  bars,
  currentPitchHz,
  lockedGender,
  lastDetectedGender,
}) => {
  const isActive = isRecording || isLiveConnected;

  const genderLabel =
    lockedGender !== 'AUTO'
      ? lockedGender === 'FEMININO'
        ? 'Fixo: Mulher'
        : 'Fixo: Homem'
      : currentPitchHz
      ? currentPitchHz >= 165
        ? 'Voz Feminina'
        : 'Voz Masculina'
      : lastDetectedGender
      ? lastDetectedGender === 'FEMININO'
        ? 'Mulher (Fem.)'
        : 'Homem (Masc.)'
      : 'Auto (Tom de Voz)';

  const statusText = isPlayingOutput
    ? 'Reproduzindo tradução'
    : isSynthesizing
    ? 'Traduzindo fala...'
    : isLiveConnected
    ? 'Live simultâneo ativo'
    : isRecording
    ? 'Ouvindo emissor...'
    : 'Pronto para ouvir';

  return (
    <div className="w-full bg-[#0B0F17] border border-slate-800/80 rounded-xl p-3.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              isPlayingOutput
                ? 'bg-sky-400 animate-pulse'
                : isActive
                ? 'bg-emerald-400 animate-pulse'
                : isSynthesizing
                ? 'bg-amber-400 animate-pulse'
                : 'bg-slate-600'
            }`}
            aria-hidden="true"
          />
          <span className="font-medium text-slate-200 truncate">{statusText}</span>
        </div>

        <div className="flex items-center gap-1.5 text-slate-400 font-mono tabular-nums shrink-0">
          <span>{currentPitchHz ? `${Math.round(currentPitchHz)} Hz` : '-- Hz'}</span>
          <span aria-hidden="true">·</span>
          <span className="font-sans text-slate-300">{genderLabel}</span>
        </div>
      </div>

      {/* Compact 16-Bar Visualizer */}
      <div
        className="mt-2.5 h-10 flex items-end justify-between gap-1 px-1"
        aria-label="Nível de voz"
      >
        {bars.slice(0, 16).map((val, idx) => {
          const heightPct = isActive || isPlayingOutput ? Math.max(15, Math.min(100, val)) : 15;
          const barColor = isPlayingOutput
            ? 'bg-sky-400'
            : isActive
            ? 'bg-emerald-400'
            : isSynthesizing
            ? 'bg-amber-400/80'
            : 'bg-slate-800';

          return (
            <div key={idx} className="flex-1 h-full flex items-end">
              <div
                className={`w-full rounded-sm transition-transform duration-100 origin-bottom ${barColor}`}
                style={{
                  height: '100%',
                  transform: `scaleY(${heightPct / 100})`,
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};
