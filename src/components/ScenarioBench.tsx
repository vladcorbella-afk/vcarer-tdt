import React from 'react';
import { Play, Volume2 } from 'lucide-react';
import { BILINGUAL_TEST_SCENARIOS, OperationMode, TestScenario } from '../types/interpreter';

interface ScenarioBenchProps {
  activeMode: OperationMode;
  isProcessing: boolean;
  activeScenarioId: string | null;
  onRunScenario: (scenario: TestScenario) => void;
}

export const ScenarioBench: React.FC<ScenarioBenchProps> = ({
  activeMode,
  isProcessing,
  activeScenarioId,
  onRunScenario,
}) => {
  return (
    <section className="space-y-4">
      <div className="border-b border-slate-800 pb-3">
        <h2 className="text-base sm:text-lg font-semibold text-slate-100">
          Exemplos Rápidos de Concordância (Mulher vs. Homem)
        </h2>
        <p className="text-xs sm:text-sm text-slate-400 mt-1">
          Toque em um exemplo para ouvir a tradução no modo ativo (
          {activeMode === 'ALTERNADO' ? 'Alternado PT ↔ EN' : 'Fixo Pessoa 2 — Sempre PT-BR'}).
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {BILINGUAL_TEST_SCENARIOS.map((scenario) => {
          const isCurrent = activeScenarioId === scenario.id && isProcessing;
          const expectedTarget =
            activeMode === 'FIXO_PT_BR'
              ? 'PT-BR'
              : scenario.sourceLang === 'PT-BR'
              ? 'EN'
              : 'PT-BR';

          return (
            <div
              key={scenario.id}
              className="flex flex-col justify-between border border-slate-800 bg-[#111827] rounded-xl p-4"
            >
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400 font-mono tabular-nums">
                  <span
                    className={
                      scenario.gender === 'FEMININO'
                        ? 'text-rose-300 font-semibold'
                        : 'text-sky-300 font-semibold'
                    }
                  >
                    {scenario.gender === 'FEMININO' ? 'Mulher' : 'Homem'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{scenario.simulatedPitchHz} Hz</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {scenario.sourceLang} → {expectedTarget}
                  </span>
                </div>

                <h3 className="text-sm font-semibold text-slate-100">
                  {scenario.title}
                </h3>

                <p className="text-sm text-slate-300 leading-relaxed italic break-words">
                  "{scenario.inputText}"
                </p>

                <p className="text-xs text-slate-400">{scenario.highlightNote}</p>
              </div>

              <button
                type="button"
                disabled={isProcessing}
                onClick={() => onRunScenario(scenario)}
                className="mt-4 w-full min-h-[44px] px-4 py-2.5 text-xs font-semibold rounded-lg bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-50 inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                {isCurrent ? (
                  <>
                    <Volume2 className="w-4 h-4 animate-pulse shrink-0" />
                    <span>Traduzindo...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-current shrink-0" />
                    <span>Testar e Ouvir</span>
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
};
