import { useCallback, useEffect, useRef, useState } from 'react';
import { clock, TASK_NAMES } from '../lib/util';
import { getBenchPair, voteBench } from '../server/api.functions';

// Voto alla cieca: due risposte allo stesso compito, mostrate come il loro contenuto vero
// (momenti sulla trascrizione, sì/no sui frame, scaletta degli short, gancio sul frame).

type Out = any;

const GUIDE: Record<string, { what: string; look: string[] }> = {
  meaning: {
    what: 'Il modello ha letto 3 minuti di trascrizione e ha segnato i momenti che potrebbero diventare uno short.',
    look: [
      'I momenti esistono davvero nella trascrizione a sinistra? Passa sopra una scheda per evidenziare le righe.',
      'Inizio e fine tagliano bene (prima del setup, dopo la reazione)? Premi ▶ per guardarli nel video.',
      'Il voto di forza e il "perché" convincono? Meglio meno momenti ma buoni.',
    ],
  },
  vision: {
    what: 'Il modello ha guardato i frame di un candidato e ha risposto a domande di controllo.',
    look: [
      'La descrizione corrisponde a quello che vedi nei frame?',
      'I sì/no sono giusti? (violenza nei primi 7 s, cutscene, schermo nel gioco, comprensibile senza contesto)',
      'La facecam (riquadro rosso) e il centro dell’azione (linea ambra) sono al posto giusto? Il riquadro turchese è il ritaglio 9:16 che ne verrebbe fuori.',
      'Sulla griglia: i riquadri segnati come webcam (rosso) o cutscene (ambra) sono davvero quelli?',
    ],
  },
  rank: {
    what: 'Il modello ha scelto quali candidati diventano short, in che ordine e con quali tagli.',
    look: [
      'Gli short in cima sono quelli che pubblicheresti? Premi ▶ per guardare ogni taglio.',
      'L’inizio cade subito prima della svolta? La durata è vicina ai 35 s?',
      'I motivi sono convincenti? “anche nell’altra” indica le scelte in comune.',
    ],
  },
  copy: {
    what: 'Il modello ha scritto il gancio sullo schermo e i testi per YouTube, Instagram e TikTok di uno short.',
    look: [
      'Il gancio ti farebbe fermare a guardare? È al massimo di 6 parole e non rovina la sorpresa?',
      'Titoli e descrizioni sono veri rispetto al clip (guardalo con ▶) e nella voce del canale?',
      'Il voto che il modello dà allo short è onesto?',
    ],
  },
};

const KIND_IT: Record<string, string> = { setup_punchline: 'battuta', story: 'storia', quote: 'frase', reaction: 'reazione' };

// ───────── lettore del video sorgente ─────────

function useSegmentPlayer(src: string | null, poster?: string | null) {
  const ref = useRef<HTMLVideoElement>(null);
  const until = useRef<number | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const stop = () => {
      if (until.current != null && v.currentTime >= until.current) {
        v.pause();
        until.current = null;
      }
    };
    v.addEventListener('timeupdate', stop);
    return () => v.removeEventListener('timeupdate', stop);
  }, [src]);
  const play = useCallback((s: number, e: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = Math.max(0, s);
    until.current = e;
    setRange([s, e]);
    void v.play();
    v.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);
  const el = src ? (
    <div className="player">
      <video ref={ref} src={src} poster={poster ?? undefined} controls preload="metadata" />
      <div className="small muted">{range ? `in riproduzione ${clock(range[0])}–${clock(range[1])}` : 'Premi ▶ su un momento per guardarlo qui.'}</div>
    </div>
  ) : null;
  return { el, play };
}

// ───────── componente principale ─────────

export function BlindVote({ benchId, onVote }: { benchId?: string; onVote: () => void }) {
  const [task, setTask] = useState('');
  const [pair, setPair] = useState<any>(null);
  const [reveal, setReveal] = useState<any>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const load = useCallback(() => {
    setReveal(null);
    setHover(null);
    getBenchPair({ data: { id: benchId, task: task || undefined } }).then(setPair);
  }, [benchId, task]);
  useEffect(load, [load]);
  const vote = useCallback(
    async (winner: 'a' | 'b' | 'pari') => {
      if (!pair || reveal) return;
      setReveal(await voteBench({ data: { token: pair.token, winner } }));
      onVote();
    },
    [pair, reveal, onVote],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') vote('a');
      else if (e.key === 'ArrowRight') vote('b');
      else if (e.key === 'ArrowDown') vote('pari');
      else if (e.key === 'Enter' && reveal) load();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vote, load, reveal]);
  const { el: player, play } = useSegmentPlayer(pair?.context?.source_url ?? null, pair?.context?.frames?.start ?? pair?.context?.candidates?.[0]?.thumb);

  if (!pair) return <div className="card empty">Nessuna coppia da votare: serve un banco di prova con almeno due modelli riusciti.</div>;
  const g = GUIDE[pair.task];
  const ctx = pair.context ?? {};
  return (
    <div className="card vote-card">
      <div className="row">
        <h2 style={{ margin: 0 }}>Voto alla cieca</h2>
        <span className="small muted">{pair.remaining} coppie mai votate</span>
        <span className="spacer" />
        <div className="seg">
          {['', ...pair.tasks].map((t: string) => (
            <button key={t || 'tutti'} aria-pressed={task === t} onClick={() => setTask(t)}>
              {t ? TASK_NAMES[t] : 'Tutti'} {t && pair.votes[t] ? <span className="muted">· {pair.votes[t]}</span> : null}
            </button>
          ))}
        </div>
        <button className="btn" onClick={load}>
          Salta
        </button>
      </div>

      {g && (
        <div className="guide">
          <b>{TASK_NAMES[pair.task]}</b> — {g.what}
          <ul>
            {g.look.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="vote-layout">
        <div className="vote-context">
          {pair.task === 'meaning' && <MeaningContext ctx={ctx} hover={hover} play={play} player={player} />}
          {pair.task === 'vision' && <VisionContext ctx={ctx} play={play} player={player} />}
          {pair.task === 'rank' && <RankContext ctx={ctx} player={player} />}
          {pair.task === 'copy' && <CopyContext ctx={ctx} play={play} player={player} />}
        </div>
        <div className="vote">
          {(['a', 'b'] as const).map((k) => (
            <div key={k} className={`answer ${reveal?.winner === k ? 'won' : ''}`}>
              <div className="row answer-head">
                <h3 style={{ margin: 0 }}>Risposta {k.toUpperCase()}</h3>
                <span className="spacer" />
                {reveal && <Reveal who={reveal[k]} />}
              </div>
              {reveal?.[k]?.reason && <p className="small judge">Giudice: {reveal[k].reason}</p>}
              {pair.task === 'meaning' && <MeaningAnswer out={pair[k]} play={play} setHover={setHover} />}
              {pair.task === 'vision' && <VisionAnswer out={pair[k]} ctx={ctx} />}
              {pair.task === 'rank' && <RankAnswer out={pair[k]} other={pair[k === 'a' ? 'b' : 'a']} ctx={ctx} play={play} />}
              {pair.task === 'copy' && <CopyAnswer out={pair[k]} ctx={ctx} />}
              {!['meaning', 'vision', 'rank', 'copy'].includes(pair.task) && <pre className="json">{JSON.stringify(pair[k], null, 2)}</pre>}
            </div>
          ))}
        </div>
      </div>

      <div className="vote-bar">
        {reveal ? (
          <button className="btn primary big" onClick={load}>
            Prossima coppia <kbd>Invio</kbd>
          </button>
        ) : (
          <>
            <button className="btn primary big" onClick={() => vote('a')}>
              <kbd>←</kbd> Meglio A
            </button>
            <button className="btn big" onClick={() => vote('pari')}>
              Pari <kbd>↓</kbd>
            </button>
            <button className="btn primary big" onClick={() => vote('b')}>
              Meglio B <kbd>→</kbd>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Reveal({ who }: { who: any }) {
  return (
    <div className="row small">
      <span className="chip teal">{who.label}</span>
      {who.judge != null && <span className="chip amber">giudice {who.judge}/10</span>}
      {who.seconds != null && <span className="chip">{who.seconds.toFixed(1)} s</span>}
      <span className="chip">{who.provider === 'claude' ? `$${(who.cost_usd ?? 0).toFixed(4)}` : 'locale'}</span>
    </div>
  );
}

// ───────── senso della trascrizione ─────────

function MeaningContext({ ctx, hover, play, player }: { ctx: any; hover: [number, number] | null; play: (s: number, e: number) => void; player: React.ReactNode }) {
  return (
    <>
      {player}
      <h3>Trascrizione {ctx.block ? `${clock(ctx.block.s)}–${clock(ctx.block.e)}` : ''}</h3>
      <div className="transcript">
        {(ctx.lines ?? []).map((l: any, i: number) => {
          const on = hover && l.e > hover[0] && l.s < hover[1];
          return (
            <div key={i} className={`tline ${on ? 'on' : ''}`} onClick={() => play(l.s, l.e + 0.5)} title="Clic per ascoltare questa frase">
              <span className="t">{clock(l.s)}</span> {l.text}
            </div>
          );
        })}
      </div>
    </>
  );
}

function MeaningAnswer({ out, play, setHover }: { out: Out; play: (s: number, e: number) => void; setHover: (r: [number, number] | null) => void }) {
  return (
    <>
      {out?.notes && <p className="small muted">{out.notes}</p>}
      {(out?.moments ?? []).map((m: any, i: number) => (
        <div key={i} className="moment" onMouseEnter={() => setHover([m.start, m.end])} onMouseLeave={() => setHover(null)}>
          <div className="row">
            <span className="chip teal">{KIND_IT[m.kind] ?? m.kind}</span>
            <b>
              {clock(m.start)}–{clock(m.end)}
            </b>
            <span className="small muted">
              {Math.round(m.end - m.start)} s · svolta {clock(m.turn)}
            </span>
            <span className="spacer" />
            <Strength v={m.strength} />
          </div>
          {m.quote && <div className="quote">«{m.quote}»</div>}
          <div className="small">{m.why}</div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn small" onClick={() => play(m.start, m.end)}>
              ▶ Guarda il momento
            </button>
            <button className="btn small" onClick={() => play(Math.max(0, m.turn - 3), m.turn + 6)}>
              ▶ Solo la svolta
            </button>
          </div>
        </div>
      ))}
      {!out?.moments?.length && <div className="small muted">Nessun momento.</div>}
    </>
  );
}

function Strength({ v }: { v: number }) {
  return (
    <span className="strength" title={`forza ${v}/10`}>
      <span className="track">
        <i style={{ width: `${v * 10}%` }} />
      </span>
      <b>{v}/10</b>
    </span>
  );
}

// ───────── controllo visivo ─────────

const FRAME_NAMES: Record<string, string> = { start: 'Inizio', peak: 'Picco', end: 'Fine', first7s: 'Primi 7 secondi (1, 3, 5, 7 s)' };

function VisionContext({ ctx, play, player }: { ctx: any; play: (s: number, e: number) => void; player: React.ReactNode }) {
  const c = ctx.candidate;
  return (
    <>
      {c && (
        <div className="row">
          <h3 style={{ margin: 0 }}>
            Candidato {c.id} · {clock(c.s)}–{clock(c.e)}
          </h3>
          <button className="btn small" onClick={() => play(c.s, c.e)}>
            ▶ Guarda il clip
          </button>
        </div>
      )}
      {player}
      <div className="frames">
        {['start', 'peak', 'end', 'first7s'].map((k) =>
          ctx.frames?.[k] ? (
            <figure key={k}>
              <img src={ctx.frames[k]} alt="" />
              <figcaption>{FRAME_NAMES[k]}</figcaption>
            </figure>
          ) : null,
        )}
      </div>
      {c?.transcript && (
        <details>
          <summary className="small muted">Cosa dice lo streamer</summary>
          <p className="small">{c.transcript}</p>
        </details>
      )}
    </>
  );
}

const FLAGS: [string, string, boolean][] = [
  ['graphic_violence_first7s', 'Violenza grafica nei primi 7 s', true],
  ['cutscene', 'Solo cutscene', true],
  ['ingame_screen', 'Schermo nel gioco (TV, menu…)', true],
  ['wide_shot', 'Inquadratura larga (il 9:16 taglierebbe)', true],
  ['standalone', 'Si capisce senza contesto', false],
];

function VisionAnswer({ out, ctx }: { out: Out; ctx: any }) {
  if (!out) return null;
  const aspect = ctx.aspect ?? 16 / 9;
  const cropW = (9 / 16 / aspect) * 100;
  const x = Math.min(100 - cropW / 2, Math.max(cropW / 2, out.action_x ?? 50));
  return (
    <>
      <p>{out.what}</p>
      <table className="flags">
        <tbody>
          {FLAGS.map(([k, label, badIfYes]) => {
            const yes = !!out[k];
            const bad = badIfYes ? yes : !yes;
            return (
              <tr key={k}>
                <td>{label}</td>
                <td>
                  <span className={`chip ${bad ? 'warn' : 'ok'}`}>{yes ? 'sì' : 'no'}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small muted">
        Violenza: {out.violence_note} · {out.standalone_why}
      </p>
      {ctx.frames?.peak && (
        <figure className="overlay">
          <div className="frame-wrap" style={{ aspectRatio: String(aspect) }}>
          <img src={ctx.frames.peak} alt="" />
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            {(out.overlays ?? []).map((o: any, i: number) => (
              <g key={i}>
                <rect x={o.x0} y={o.y0} width={o.x1 - o.x0} height={o.y1 - o.y0} className="box" />
              </g>
            ))}
            <rect x={x - cropW / 2} y={0} width={cropW} height={100} className="crop" />
            <line x1={out.action_x} x2={out.action_x} y1={0} y2={100} className="action" />
          </svg>
          </div>
          <figcaption>
            Picco: facecam e overlay in rosso ({(out.overlays ?? []).map((o: any) => o.kind).join(', ') || 'nessuno'}), centro dell’azione in ambra ({Math.round(out.action_x)}%), ritaglio 9:16 in turchese
          </figcaption>
        </figure>
      )}
      {ctx.frames?.timeline && (
        <figure className="overlay grid43">
          <div className="frame-wrap" style={{ aspectRatio: '16 / 9' }}>
          <img src={ctx.frames.timeline} alt="" />
          <div className="tiles">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <span key={n} className={(out.webcam_tiles ?? []).includes(n) ? 'webcam' : (out.cutscene_tiles ?? []).includes(n) ? 'cut' : ''}>
                {n}
              </span>
            ))}
          </div>
          </div>
          <figcaption>
            Tutto il clip in 12 riquadri: webcam in rosso ({(out.webcam_tiles ?? []).join(', ') || 'nessuno'}), cutscene in ambra ({(out.cutscene_tiles ?? []).join(', ') || 'nessuno'})
          </figcaption>
        </figure>
      )}
    </>
  );
}

// ───────── classifica ─────────

function RankContext({ ctx, player }: { ctx: any; player: React.ReactNode }) {
  return (
    <>
      {player}
      <details>
        <summary>
          <b>I {ctx.candidates?.length ?? 0} candidati tra cui sceglieva</b>
        </summary>
        <div className="cands">
          {(ctx.candidates ?? []).map((c: any) => (
            <div key={c.id} className="cand">
              {c.thumb && <img src={c.thumb} alt="" />}
              <div>
                <b>
                  {c.id} · {clock(c.s)}–{clock(c.e)}
                </b>
                <div className="small">{c.what}</div>
                <div className="row" style={{ gap: 4 }}>
                  {(c.labels ?? []).slice(0, 4).map((l: string) => (
                    <span key={l} className="chip">
                      {l}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}

function RankAnswer({ out, other, ctx, play }: { out: Out; other: Out; ctx: any; play: (s: number, e: number) => void }) {
  const otherIds: string[] = (other?.picks ?? []).map((p: any) => p.id);
  return (
    <>
      {out?.notes && <p className="small muted">{out.notes}</p>}
      <ol className="picks">
        {(out?.picks ?? []).map((p: any, i: number) => {
          const c = (ctx.candidates ?? []).find((x: any) => x.id === p.id);
          const pos = otherIds.indexOf(p.id);
          return (
            <li key={i} className="pick">
              {c?.thumb && <img src={c.thumb} alt="" />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row">
                  <b>
                    #{i + 1} {p.id}
                  </b>
                  <span className="small">
                    {clock(p.start)}–{clock(p.end)} · {Math.round(p.end - p.start)} s · svolta +{(p.turn - p.start).toFixed(1)} s
                  </span>
                  <span className={`chip ${pos >= 0 ? 'teal' : ''}`}>{pos >= 0 ? `anche nell’altra (#${pos + 1})` : 'solo qui'}</span>
                </div>
                <div className="small">{p.reason}</div>
                {c?.what && <div className="small muted">{c.what}</div>}
              </div>
              <button className="btn small" onClick={() => play(p.start, p.end)}>
                ▶
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// ───────── testi degli short ─────────

function CopyContext({ ctx, play, player }: { ctx: any; play: (s: number, e: number) => void; player: React.ReactNode }) {
  const sh = ctx.short;
  return (
    <>
      {sh && (
        <div className="row">
          <h3 style={{ margin: 0 }}>
            Short {sh.id} · {clock(sh.s)}–{clock(sh.e)} ({Math.round(sh.e - sh.s)} s)
          </h3>
          <button className="btn small" onClick={() => play(sh.s, sh.e)}>
            ▶ Guarda il clip (senza testi)
          </button>
        </div>
      )}
      {player}
      <div className="frames">
        {['start', 'peak', 'end'].map((k) =>
          ctx.frames?.[k] ? (
            <figure key={k}>
              <img src={ctx.frames[k]} alt="" />
              <figcaption>{FRAME_NAMES[k]}</figcaption>
            </figure>
          ) : null,
        )}
      </div>
      <div className="transcript">
        {(ctx.lines ?? []).map((l: any, i: number) => (
          <div key={i} className="tline" onClick={() => sh && play(sh.s + l.s, sh.s + l.s + 4)}>
            <span className="t">+{l.s.toFixed(1)} s</span> {l.text}
          </div>
        ))}
      </div>
    </>
  );
}

function CopyAnswer({ out, ctx }: { out: Out; ctx: any }) {
  if (!out) return null;
  const words = String(out.hook ?? '').trim().split(/\s+/).filter(Boolean);
  const last = words.length > 1 ? words.slice(0, -1).join(' ') : '';
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {ctx.frames?.peak && (
          <div className="phone">
            <img src={ctx.frames.peak} alt="" />
            <div className="hook">
              {last} <span>{words.at(-1)}</span>
            </div>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row">
            <span className="score-badge">{out.score}/10</span>
            <span className={`chip ${words.length <= 6 ? 'ok' : 'warn'}`}>gancio di {words.length} parole</span>
          </div>
          <p className="small">{out.score_reason}</p>
        </div>
      </div>
      {(['youtube', 'instagram', 'tiktok'] as const).map((p) => (
        <div key={p} className="platform">
          <div className="small muted">{p === 'youtube' ? 'YouTube Shorts' : p === 'instagram' ? 'Instagram Reels' : 'TikTok'}</div>
          <b>{out[p]?.title}</b> <span className="small muted">({out[p]?.title?.length ?? 0} car.)</span>
          <div className="small">{out[p]?.description}</div>
          <div className="row" style={{ gap: 4, marginTop: 4 }}>
            {(out[p]?.hashtags ?? []).map((h: string) => (
              <span key={h} className="chip teal">
                {h}
              </span>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
