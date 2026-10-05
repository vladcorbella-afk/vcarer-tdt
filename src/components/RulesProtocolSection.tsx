import React from 'react';

const GENDER_INFLECTION_EXAMPLES = [
  {
    english: "I'm ready to start now.",
    feminine: 'Estou pronta para começar agora.',
    masculine: 'Estou pronto para começar agora.',
  },
  {
    english: 'Thank you very much for your help.',
    feminine: 'Muito obrigada pela sua ajuda.',
    masculine: 'Muito obrigado pela sua ajuda.',
  },
  {
    english: 'I was exhausted after the trip, but I am pleased.',
    feminine: 'Fiquei exausta depois da viagem, mas estou satisfeita.',
    masculine: 'Fiquei exausto depois da viagem, mas estou satisfeito.',
  },
  {
    english: "I'm sure we made the right decision.",
    feminine: 'Estou certa de que tomamos a decisão correta.',
    masculine: 'Estou certo de que tomamos a decisão correta.',
  },
];

export const RulesProtocolSection: React.FC = () => {
  return (
    <section className="space-y-4 pt-4">
      <div className="border-b border-slate-800 pb-3">
        <h2 className="text-base sm:text-lg font-semibold text-slate-100">
          Regras de Concordância e Modos do VoxVcarer
        </h2>
        <p className="text-xs sm:text-sm text-slate-400 mt-1">
          Resumo rápido de como a tradução simultânea adapta o gênero do emissor e entrega apenas a fala traduzida.
        </p>
      </div>

      {/* 3 Compact Rule Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        <div className="border border-slate-800 bg-[#111827] rounded-xl p-4 space-y-1.5">
          <div className="text-xs font-mono text-emerald-400">01 · Modos de Operação</div>
          <h3 className="text-sm font-semibold text-slate-100">Alternado vs. Fixo PT-BR</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            No <strong>Modo Alternado</strong>, PT-BR vira EN e EN vira PT-BR. No <strong>Modo Fixo Pessoa 2</strong>, qualquer fala captada é entregue sempre em Português (PT-BR).
          </p>
        </div>

        <div className="border border-slate-800 bg-[#111827] rounded-xl p-4 space-y-1.5">
          <div className="text-xs font-mono text-rose-300">02 · Concordância Vocal</div>
          <h3 className="text-sm font-semibold text-slate-100">Mulher vs. Homem</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            Identifica o sexo pelo tom de voz e contexto: usa flexões femininas (<em>pronta, obrigada</em>) para mulher e masculinas (<em>pronto, obrigado</em>) para homem.
          </p>
        </div>

        <div className="border border-slate-800 bg-[#111827] rounded-xl p-4 space-y-1.5">
          <div className="text-xs font-mono text-sky-300">03 · Saída Limpa</div>
          <h3 className="text-sm font-semibold text-slate-100">Sem Comentários</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            Entrega apenas o texto e áudio da tradução final, mantendo a emoção original e sem frases como <em>"A tradução é:"</em>.
          </p>
        </div>
      </div>

      {/* Responsive Comparison Grid (Replaces wide table so mobile/tablet never overflow) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {GENDER_INFLECTION_EXAMPLES.map((row, idx) => (
          <div
            key={idx}
            className="border border-slate-800 bg-[#111827] rounded-xl p-4 space-y-2 text-xs sm:text-sm"
          >
            <div className="text-slate-400 italic break-words">
              EN: "{row.english}"
            </div>
            <div className="pt-1 border-t border-slate-800/80 space-y-1">
              <div className="text-rose-200 break-words">
                <strong className="font-semibold">Mulher:</strong> "{row.feminine}"
              </div>
              <div className="text-sky-200 break-words">
                <strong className="font-semibold">Homem:</strong> "{row.masculine}"
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
