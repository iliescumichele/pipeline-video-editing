import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { Candidate, Route as ModelRoute, RoutingFile } from '../../../src/lib/routing';
import { BlindVote } from '../components/vote';
import { q } from '../lib/queries';
import { useStartJob } from '../lib/jobs';
import { useToast } from '../lib/toast';
import { pct, TASK_NAMES, when } from '../lib/util';
import { saveRouting } from '../server/api.functions';

export const Route = createFileRoute('/modelli')({
  loader: ({ context }) => Promise.all([context.queryClient.ensureQueryData(q.routing()), context.queryClient.ensureQueryData(q.bench())]),
  component: Models,
});

type Option = Pick<Candidate, 'id' | 'label'> & ModelRoute;

function Models() {
  const { data: routing } = useSuspenseQuery(q.routing());
  const { data: bench } = useSuspenseQuery(q.bench());
  const qc = useQueryClient();
  const show = useToast();
  const [draft, setDraft] = useState<RoutingFile>(routing);
  useEffect(() => setDraft(routing), [routing]);
  const options: Option[] = [...draft.candidates, { id: 'clef', label: 'Clef-Flash (locale, solo smistamento)', provider: 'clef' }];
  const pick = (task: string, id: string) => {
    const c = options.find((o) => o.id === id);
    if (!c) return;
    const { id: _i, label: _l, ...route } = c;
    setDraft({ ...draft, tasks: { ...draft.tasks, [task]: route } });
  };
  const current = (r: ModelRoute) => options.find((o) => o.provider === r.provider && (o.model ?? null) === (r.model ?? null) && (o.effort ?? null) === (r.effort ?? null))?.id ?? '';
  const s = bench.summary;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Chi fa cosa</h2>
          <span className="spacer" />
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await saveRouting({ data: draft });
                show('Salvato: vale dal prossimo lavoro');
                await qc.invalidateQueries({ queryKey: ['routing'] });
              } catch (e) {
                show((e as Error).message);
              }
            }}
          >
            Salva
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Compito</th>
              <th>Modello</th>
              <th>Dal banco di prova</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(draft.tasks).map(([task, r]) => {
              const rows = s?.rows.filter((x) => x.task === task) ?? [];
              const best = rows.filter((x) => x.judge != null).sort((a, b) => b.judge! - a.judge!)[0];
              return (
                <tr key={task}>
                  <td>{TASK_NAMES[task] ?? task}</td>
                  <td style={{ width: 340 }}>
                    <select value={current(r)} onChange={(e) => pick(task, e.target.value)}>
                      {!current(r) && <option value="">{`${r.provider} ${r.model ?? ''} ${r.effort ?? ''}`}</option>}
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="small muted">{best ? `migliore per il giudice: ${best.label} (${best.judge!.toFixed(1)}/10)` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <BenchTable />
      <BlindVote benchId={s?.id} onVote={() => void qc.invalidateQueries({ queryKey: ['bench'] })} />
    </div>
  );
}

function BenchTable() {
  const { data: bench } = useSuspenseQuery(q.bench());
  const qc = useQueryClient();
  const show = useToast();
  const startChecked = useStartJob();
  const s = bench.summary;
  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>Banco di prova</h2>
        {s && (
          <span className="small muted">
            {when(s.created_at)} · {s.votes} tuoi voti
          </span>
        )}
        <span className="spacer" />
        <button
          className="btn"
          onClick={async () => {
            if (!(await startChecked({ kind: 'bench' }))) return;
            show('Banco di prova in coda (20–30 minuti)');
            await qc.invalidateQueries({ queryKey: ['bench'] });
          }}
        >
          Nuovo banco
        </button>
      </div>
      {!s && <div className="empty">Nessun banco di prova ancora.</div>}
      {s &&
        [...new Set(s.rows.map((r) => r.task))].map((task) => (
          <div key={task} style={{ marginTop: 12 }}>
            <h3>{TASK_NAMES[task] ?? task}</h3>
            <table>
              <thead>
                <tr>
                  <th>Modello</th>
                  <th className="num">Voto del giudice</th>
                  <th className="num">Tuoi voti (vinte)</th>
                  <th className="num">Tempo medio</th>
                  <th className="num">Costo API equiv.</th>
                  <th className="num">Errori</th>
                </tr>
              </thead>
              <tbody>
                {s.rows
                  .filter((r) => r.task === task)
                  .sort((a, b) => (b.judge ?? -1) - (a.judge ?? -1))
                  .map((r) => (
                    <tr key={r.candidate}>
                      <td>{r.label}</td>
                      <td className="num">
                        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <div className="bar" style={{ width: 80 }}>
                            <i style={{ width: `${(r.judge ?? 0) * 10}%` }} />
                          </div>
                          {r.judge != null ? r.judge.toFixed(1) : '—'}
                        </div>
                      </td>
                      <td className="num">{r.votes ? `${pct(r.win_rate)} su ${r.votes}` : '—'}</td>
                      <td className="num">{r.seconds != null ? `${r.seconds.toFixed(1)} s` : '—'}</td>
                      <td className="num">{r.provider === 'claude' ? (r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : '—') : 'locale'}</td>
                      <td className="num">{r.failed ? <span className="chip warn">{r.failed}</span> : '0'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
      <p className="small muted" style={{ marginTop: 10 }}>
        Il costo è quello che `claude -p` riporterebbe con le API: sull'abbonamento non si paga, ma indica quanta quota consuma la chiamata.
      </p>
    </div>
  );
}
