// Prima di mettere in coda un lavoro la dashboard dice quanto spazio occuperà e quanto ce n'è:
// se è trascurabile parte e basta, altrimenti si conferma; se non c'è posto bisogna insistere.
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import type { JobRequest } from '../server/pipeline.server';
import { estimateJob, startJob } from '../server/api.functions';

type Estimate = Awaited<ReturnType<typeof estimateJob>>;
type Start = (req: JobRequest) => Promise<boolean>;

const JobContext = createContext<Start>(async () => false);

const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

export function JobGuardProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<{ est: Estimate; done: (ok: boolean) => void } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback<Start>(async (req) => {
    const est = await estimateJob({ data: req });
    // lavori che non scrivono quasi niente (notizie, script, banco di prova): niente domande
    if (est.items && est.peak < 50e6 && est.free > est.margin) {
      await startJob({ data: req });
      return true;
    }
    const ok = await new Promise<boolean>((done) => setAsk({ est, done }));
    setAsk(null);
    if (!ok) return false;
    await startJob({ data: req });
    return true;
  }, []);

  const est = ask?.est;
  const short = est ? (est.items ? est.peak + est.margin > est.free : est.free < 10e9) : false;
  return (
    <JobContext.Provider
      value={async (req) => {
        setError(null);
        try {
          return await start(req);
        } catch (e) {
          setError((e as Error).message);
          return false;
        }
      }}
    >
      {children}
      {error && (
        <div className="toast" style={{ borderColor: 'var(--warn)' }} onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {est && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10, 8, 16, 0.6)', display: 'grid', placeItems: 'center', zIndex: 50, padding: 16 }}>
          <div className="card" style={{ width: 'min(520px, 100%)', borderColor: short ? 'var(--warn)' : 'var(--line)' }}>
            <h3 style={{ marginTop: 0 }}>Spazio su disco</h3>
            {est.items ? (
              <>
                <table>
                  <tbody>
                    {est.items.map((i) => (
                      <tr key={i.label}>
                        <td>
                          {i.label}
                          {i.temporary ? <span className="muted"> · temporaneo</span> : null}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{gb(i.bytes)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <b>Occupa circa{est.peak !== est.kept ? ' durante il lavoro' : ''}</b>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <b>{gb(est.peak)}</b>
                      </td>
                    </tr>
                    {est.peak !== est.kept && (
                      <tr>
                        <td className="muted">alla fine resta</td>
                        <td className="muted" style={{ textAlign: 'right' }}>
                          {gb(est.kept)}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </>
            ) : (
              <div className="small muted">Questo lavoro non si può stimare prima.</div>
            )}
            {est.note && <div className="small muted" style={{ marginTop: 8 }}>{est.note}</div>}
            <div style={{ marginTop: 10, color: short ? 'var(--warn)' : 'var(--ok)' }}>
              Liberi adesso: <b>{gb(est.free)}</b>
              {short
                ? est.items
                  ? ` · non bastano: servono circa ${gb(est.peak)} più ${gb(est.margin)} di margine per il Mac. Il lavoro si fermerà da solo all’inizio se lo spazio non cambia.`
                  : ' · meno di 10 GB: rischi di riempire il disco.'
                : est.items
                  ? ` · dopo il lavoro circa ${gb(Math.max(0, est.free - est.kept))}`
                  : ''}
            </div>
            <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => ask?.done(false)}>
                Annulla
              </button>
              <button className={`btn ${short ? 'danger' : 'primary'}`} onClick={() => ask?.done(true)}>
                {short ? 'Mettilo in coda comunque' : 'Avvia'}
              </button>
            </div>
          </div>
        </div>
      )}
    </JobContext.Provider>
  );
}

/** Al posto di startJob: mostra lo spazio, chiede conferma se serve, e dice se il lavoro è partito. */
export const useStartJob = () => useContext(JobContext);
