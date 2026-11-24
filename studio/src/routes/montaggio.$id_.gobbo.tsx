import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { q } from '../lib/queries';
import { clock } from '../lib/util';

export const Route = createFileRoute('/montaggio/$id_/gobbo')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(q.timeline(Number(params.id))),
  component: Gobbo,
});

const COUNTDOWN = 3;

/**
 * Gobbo per il secondo schermo: lo script scorre con la stessa linea del tempo del video del
 * montaggio. Si avvia con lo spazio insieme al video in OBS (conto alla rovescia di 3 s);
 * ← → spostano di un secondo per riallinearsi, ↑ ↓ cambiano scena, + − la grandezza, M lo specchio.
 */
function Gobbo() {
  const id = Number(Route.useParams().id);
  const { data: tl } = useSuspenseQuery(q.timeline(id));
  const [t, setT] = useState(0);
  const [running, setRunning] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [size, setSize] = useState(64);
  const [mirror, setMirror] = useState(false);
  const base = useRef<{ wall: number; t: number } | null>(null);
  const current = useRef<HTMLDivElement>(null);

  // L'orologio segue il tempo reale (non i tick): niente deriva su 10 minuti.
  useEffect(() => {
    if (!running) return;
    base.current = { wall: performance.now(), t };
    let raf = 0;
    const tick = () => {
      setT(base.current!.t + (performance.now() - base.current!.wall) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => {
    if (countdown == null) return;
    if (countdown === 0) {
      setCountdown(null);
      setRunning(true);
      return;
    }
    const h = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(h);
  }, [countdown]);

  const beats = tl?.beats ?? [];
  const idx = Math.max(
    0,
    beats.findLastIndex((b) => b.start <= t),
  );

  useEffect(() => {
    current.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [idx]);

  useEffect(() => {
    const seek = (to: number) => {
      const v = Math.max(0, Math.min(tl?.duration ?? 0, to));
      setT(v);
      if (base.current) base.current = { wall: performance.now(), t: v };
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        if (running) setRunning(false);
        else if (countdown == null) setCountdown(t === 0 ? COUNTDOWN : 0);
      } else if (e.key === 'ArrowLeft') seek(t - 1);
      else if (e.key === 'ArrowRight') seek(t + 1);
      else if (e.key === 'ArrowUp') seek(beats[Math.max(0, idx - 1)]?.start ?? 0);
      else if (e.key === 'ArrowDown') seek(beats[Math.min(beats.length - 1, idx + 1)]?.start ?? 0);
      else if (e.key === '+' || e.key === '=') setSize((x) => Math.min(120, x + 6));
      else if (e.key === '-') setSize((x) => Math.max(32, x - 6));
      else if (e.key.toLowerCase() === 'm') setMirror((x) => !x);
      else if (e.key.toLowerCase() === 'r') {
        setRunning(false);
        seek(0);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, countdown, t, idx, beats, tl]);

  if (!tl) {
    return (
      <div className="empty">
        Il video del montaggio non c'è ancora: crealo dalla pagina{' '}
        <Link to="/montaggio/$id" params={{ id: String(id) }}>
          Montaggio
        </Link>
        .
      </div>
    );
  }
  const b = beats[idx];
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: '#0d0b12', color: '#fff', display: 'flex', flexDirection: 'column' }}>
      <div className="row small" style={{ padding: '10px 20px', borderBottom: '1px solid var(--line)', background: '#17141f' }}>
        <b style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>
          {clock(t)} / {clock(tl.duration)}
        </b>
        <span className="chip teal">
          {b?.chapter}. {b?.title}
        </span>
        <span className={`chip ${running ? 'ok' : ''}`}>{running ? 'in corso' : countdown != null ? 'parte…' : 'fermo'}</span>
        <span className="muted">spazio avvia/pausa · ← → ±1 s · ↑ ↓ scena · + − testo · M specchio · R da capo</span>
        <span className="spacer" />
        <Link className="btn" to="/montaggio/$id" params={{ id: String(id) }}>
          Esci
        </Link>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <div style={{ height: '100%', overflowY: 'auto', padding: '30vh 8vw', transform: mirror ? 'scaleX(-1)' : undefined }}>
          {beats.map((x, i) => {
            const now = i === idx;
            const newChapter = i === 0 || beats[i - 1]!.chapter !== x.chapter;
            return (
              <div key={i} ref={now ? current : undefined} onClick={() => setT(x.start)} style={{ cursor: 'pointer' }}>
                {newChapter && (
                  <div style={{ fontSize: size * 0.45, color: 'var(--teal)', fontWeight: 800, letterSpacing: '0.08em', margin: `${size * 0.8}px 0 ${size * 0.3}px` }}>
                    {x.chapter}. {x.title.toUpperCase()}
                  </div>
                )}
                {x.cue && <div style={{ fontSize: size * 0.4, color: 'var(--amber)', fontWeight: 800, marginBottom: 6 }}>[{x.cue}]</div>}
                <p
                  style={{
                    fontSize: size,
                    lineHeight: 1.35,
                    fontWeight: now ? 700 : 500,
                    margin: `0 0 ${size * 0.5}px`,
                    color: now ? '#fff' : i < idx ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.62)',
                    borderLeft: now ? '8px solid var(--amber)' : '8px solid transparent',
                    paddingLeft: 24,
                  }}
                >
                  {x.text || ' '}
                </p>
              </div>
            );
          })}
        </div>
        {countdown != null && countdown > 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(13,11,18,0.7)', fontSize: 260, fontWeight: 900, color: 'var(--amber)' }}>
            {countdown}
          </div>
        )}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, background: 'rgba(255,255,255,0.08)' }}>
          <div style={{ width: `${(t / tl.duration) * 100}%`, height: '100%', background: 'var(--amber)' }} />
        </div>
      </div>
    </div>
  );
}
