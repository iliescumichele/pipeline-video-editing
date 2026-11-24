import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ExportQuality } from '../components/export-quality';
import { q } from '../lib/queries';
import { useToast } from '../lib/toast';
import { hms, when } from '../lib/util';
import { addVideo, chooseSecondFolder, clearSecondFolder } from '../server/api.functions';

// Tutti i video: i gameplay (registrazione di OBS con Lucianus) e gli altri video da cui fare short.
// Ognuno si apre in /video/<id>, con Video lungo e Short.
export const Route = createFileRoute('/video/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.projects()),
  pendingComponent: () => <div className="empty">Cerco i video…</div>,
  component: Videos,
});

function Videos() {
  const { data } = useSuspenseQuery(q.projects());
  const qc = useQueryClient();
  const show = useToast();
  const [extra, setExtra] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [first, second] = data.folders;
  const reload = () => qc.invalidateQueries({ queryKey: ['projects'] });

  const choose = async () => {
    setChoosing(true);
    try {
      const r = await chooseSecondFolder();
      if (!r.cancelled) show(`Cerco le registrazioni anche in ${r.path}`);
      await reload();
    } catch (e) {
      show((e as Error).message);
    } finally {
      setChoosing(false);
    }
  };

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Video</h2>
        <span className="muted small">ogni video ha la sua cartella in out/ con video finale, copia a 720p, short e short da pubblicare</span>
      </div>
      <div className="card row small" style={{ gap: 8 }}>
        <span className="muted">Registrazioni da:</span>
        <span className="chip">{first?.label} · OBS</span>
        {second ? (
          <>
            <span className={`chip ${second.online ? 'teal' : 'warn'}`} title={second.path}>
              {second.label}
              {second.online ? '' : ' · non collegata'}
            </span>
            <button className="btn" disabled={choosing} onClick={choose}>
              Cambia…
            </button>
            <button
              className="btn"
              onClick={async () => {
                await clearSecondFolder();
                await reload();
              }}
            >
              Togli
            </button>
          </>
        ) : (
          <button className="btn" disabled={choosing} onClick={choose}>
            {choosing ? 'Scegli la cartella nella finestra del Mac…' : '+ Aggiungi una seconda cartella…'}
          </button>
        )}
        <span className="spacer" />
        <div className="row" style={{ flex: '1 1 320px', flexWrap: 'nowrap', maxWidth: 460 }}>
          <input placeholder="Aggiungi un video da un'altra cartella: /percorso/video.mp4" value={extra} onChange={(e) => setExtra(e.target.value)} />
          <button
            className="btn"
            disabled={!extra}
            onClick={async () => {
              try {
                await addVideo({ data: extra });
                setExtra('');
                await reload();
              } catch (e) {
                show((e as Error).message);
              }
            }}
          >
            Aggiungi
          </button>
        </div>
      </div>
      <div className="card">
        <ExportQuality />
      </div>
      {data.videos.length === 0 && <div className="empty">Nessun video in {data.movies}. Le registrazioni di OBS compariranno qui.</div>}
      <div className="grid cols-3">
        {data.videos.map((v) => {
          const g = v.gameplay;
          const done = v.stages.filter((s) => s.done).length;
          return (
            <Link key={v.id} to="/video/$id" params={{ id: v.id }} className="card project">
              {v.thumb ? <img className="thumb" src={v.thumb} alt="" loading="lazy" /> : <div className="thumb empty">nessuna immagine</div>}
              <div style={{ marginTop: 8 }}>
                <b style={{ wordBreak: 'break-word' }}>{v.title}</b>
              </div>
              <div className="small muted">
                {v.title !== v.name.replace(/\.[^.]+$/, '') && `${v.name} · `}
                {v.folder ?? 'non più sul Mac'}
                {v.duration > 0 && ` · ${hms(v.duration)}`}
                {g?.final != null && ` → ${hms(g.final)} dopo ${g.cuts} tagli`} · {when(v.mtime)}
              </div>
              <div className="row" style={{ marginTop: 8, gap: 6 }}>
                {g ? (
                  <>
                    {!v.available ? <span className="chip">solo da rivedere</span> : g.lucianus ? <span className="chip teal">gameplay</span> : <span className="chip warn">senza Lucianus</span>}
                    {g.exported ? <span className="chip ok">video finale</span> : g.analyzed ? <span className="chip">tagli in revisione</span> : <span className="chip">da analizzare</span>}
                    {g.archive && <span className="chip">copia 720p</span>}
                    {g.jobs.map((j) => (
                      <span key={j.id} className="chip amber">
                        {j.step}: {j.status}
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="chip">video</span>
                )}
                {v.shorts.total > 0 ? (
                  <span className={`chip ${v.shorts.approvato ? 'ok' : ''}`}>
                    {v.shorts.total} short · {v.shorts.approvato} approvati
                  </span>
                ) : (
                  !g && done > 0 && <span className="chip">short: {done}/10 fasi</span>
                )}
                {v.job && <span className="chip amber">short: {v.job}</span>}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
