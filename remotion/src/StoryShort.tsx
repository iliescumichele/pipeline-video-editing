import { AbsoluteFill, Easing, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT, loadFonts } from './fonts';

loadFonts();

/**
 * Short "a storia": più spezzoni del lungo, già tagliati e ritagliati da ffmpeg in un solo video,
 * con sopra didascalie parola per parola, scritte d'azione (*PURE EVIL*), flash, zoom e un finale.
 *
 * - split: Lucianus in alto, gioco 4:3 sotto; le scritte stanno sulla giuntura, come nei
 *   format "streamer" (faccia sopra, gioco sotto).
 * - panel: una frase fissa in alto su fondo nero per tutto il video, gioco 4:3 sotto.
 */

export const INK = '#0E0C14';
export const PALETTE = { white: '#FFFFFF', yellow: '#FFD23F', teal: '#3FE0D0', red: '#FF3B3B', pink: '#FF5FA2', green: '#5CFF7A' };

/**
 * Il gioco è sempre un 4:3 (1080×810): dal 16:9 si taglia poco. Sotto resta spazio vuoto, dove le app
 * mettono titolo, descrizione e nome del canale.
 */
export const GEOM = {
  split: { faceH: 560, gameTop: 560, gameH: 810, captionY: 560 },
  panel: { headerH: 400, gameTop: 400, gameH: 810, captionY: 1210 },
} as const;

export interface Word {
  w: string;
  s: number;
  e: number;
}

export interface Card {
  s: number;
  e: number;
  /** say: parole dette (evidenziate una alla volta); tag: scritta d'azione; big: scritta grande al centro del gioco */
  kind: 'say' | 'tag' | 'big';
  text: string;
  words?: Word[];
  color?: string;
}

export interface StoryProps {
  fps: number;
  duration: number;
  layout: 'split' | 'panel';
  /** gioco già ritagliato: 1080×gameH */
  game: string;
  /** solo split: Lucianus già ritagliato, alto faceH, stessa linea del tempo */
  face?: string;
  /** larghezza del video di Lucianus (1080 = tutta la fascia; meno = riquadro al centro su sfondo sfocato) */
  faceW?: number;
  /** panel: frase fissa in alto; le parole tra [quadre] vanno in giallo */
  header?: string;
  /** split: gancio nei primi secondi, sopra Lucianus */
  hook?: string;
  hookDur?: number;
  cards: Card[];
  flashes: { t: number; color: string }[];
  zooms: number[];
  shakes: number[];
  /** istanti dei tagli fra spezzoni */
  cuts: number[];
  end?: { s: number; text: string };
  [key: string]: unknown;
}

export const defaultStoryProps: StoryProps = {
  fps: 60,
  duration: 10,
  layout: 'panel',
  game: 'game.mp4',
  header: 'okay... this is [terrifying] wtf',
  cards: [],
  flashes: [],
  zooms: [],
  shakes: [],
  cuts: [],
};

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const StoryShort: React.FC<StoryProps> = (p) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const g = p.layout === 'split' ? GEOM.split : GEOM.panel;
  const z = zoomAt(p.zooms, t);
  const [sx, sy] = shakeAt(p.shakes, t);
  return (
    <AbsoluteFill style={{ backgroundColor: INK }}>
      <AbsoluteFill style={{ transform: `translate(${sx}px, ${sy}px)` }}>
        <div style={{ position: 'absolute', left: 0, top: g.gameTop, width: 1080, height: g.gameH, overflow: 'hidden' }}>
          <AbsoluteFill style={{ transform: `scale(${z})`, transformOrigin: `540px ${g.gameH / 2}px` }}>
            <OffthreadVideo src={staticFile(p.game)} muted style={{ width: 1080, height: g.gameH }} />
          </AbsoluteFill>
        </div>
        {p.layout === 'split' && p.face && (
          <div style={{ position: 'absolute', left: 0, top: 0, width: 1080, height: GEOM.split.faceH, overflow: 'hidden' }}>
            {(p.faceW ?? 1080) < 1080 && (
              <AbsoluteFill style={{ background: 'radial-gradient(ellipse 60% 85% at 50% 62%, #24525A 0%, #16232E 55%, #0E0C14 100%)' }} />
            )}
            <OffthreadVideo
              src={staticFile(p.face)}
              muted
              style={{
                position: 'absolute',
                left: (1080 - (p.faceW ?? 1080)) / 2,
                top: 0,
                width: p.faceW ?? 1080,
                height: GEOM.split.faceH,
                // bordi sfumati: il riquadro si fonde con lo sfondo invece di sembrare un ritaglio
                WebkitMaskImage: (p.faceW ?? 1080) < 1080 ? 'linear-gradient(90deg, transparent 0%, #000 14%, #000 86%, transparent 100%)' : undefined,
              }}
            />
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 90, background: 'linear-gradient(transparent, rgba(0,0,0,0.55))' }} />
          </div>
        )}
      </AbsoluteFill>
      {p.layout === 'panel' && p.header && <Header text={p.header} />}
      <Cards p={p} t={t} captionY={g.captionY} />
      {p.layout === 'split' && p.hook && <Hook text={p.hook} t={t} dur={p.hookDur ?? 2.2} />}
      <Flashes flashes={p.flashes} t={t} />
      {p.end && <EndCard end={p.end} t={t} duration={p.duration} />}
    </AbsoluteFill>
  );
};

/** Testo con contorno spesso, stile sottotitolo dei short. */
const stroke = (size: number): React.CSSProperties => ({
  WebkitTextStroke: `${Math.round(size * 0.16)}px ${INK}`,
  paintOrder: 'stroke fill',
  textShadow: `0 ${Math.round(size * 0.08)}px 0 ${INK}`,
});

const Header: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(\[[^\]]+\])/).filter(Boolean);
  const len = text.replace(/[[\]]/g, '').length;
  const size = len <= 24 ? 66 : len <= 40 ? 56 : 48;
  return (
    <div style={{ position: 'absolute', left: 70, right: 70, top: 150, height: 230, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 1.15, color: PALETTE.white, textAlign: 'center' }}>
        {parts.map((s, i) =>
          s.startsWith('[') ? (
            <span key={i} style={{ color: PALETTE.yellow }}>
              {s.slice(1, -1)}
            </span>
          ) : (
            <span key={i}>{s}</span>
          ),
        )}
      </div>
    </div>
  );
};

const Cards: React.FC<{ p: StoryProps; t: number; captionY: number }> = ({ p, t, captionY }) => {
  const { fps } = useVideoConfig();
  const card = [...p.cards].reverse().find((c) => t >= c.s && t < c.e);
  if (!card) return null;
  const appear = spring({ frame: Math.round((t - card.s) * fps), fps, config: { damping: 14, stiffness: 320 }, durationInFrames: 7 });
  const pop = interpolate(appear, [0, 1], [0.7, 1]);
  if (card.kind === 'big') {
    const size = card.text.length <= 8 ? 150 : card.text.length <= 14 ? 118 : 92;
    const g = p.layout === 'split' ? GEOM.split : GEOM.panel;
    return (
      <div style={{ position: 'absolute', left: 60, right: 60, top: g.gameTop + g.gameH * 0.38, textAlign: 'center', transform: `scale(${pop}) rotate(-3deg)` }}>
        <span style={{ fontFamily: FONT, fontWeight: 900, fontSize: size, lineHeight: 1.02, color: card.color ?? PALETTE.red, textTransform: 'uppercase', ...stroke(size) }}>
          {card.text}
        </span>
      </div>
    );
  }
  const text = card.kind === 'say' ? (card.words ?? []).map((w) => w.w).join(' ') : card.text;
  const size = Math.min(92, Math.max(50, 900 / (text.length * 0.7)));
  const base = card.kind === 'tag' ? (card.color ?? PALETTE.teal) : PALETTE.white;
  return (
    <div
      style={{
        position: 'absolute',
        left: 90,
        right: 90,
        top: captionY - size * 0.62,
        textAlign: 'center',
        fontFamily: FONT,
        fontWeight: 900,
        fontSize: size,
        lineHeight: 1.12,
        textTransform: 'uppercase',
        transform: `scale(${pop})`,
        opacity: appear,
      }}
    >
      {card.kind === 'say' && card.words ? (
        card.words.map((w, i) => {
          const next = card.words![i + 1];
          const active = t >= w.s && (!next || t < next.s);
          return (
            <span key={i} style={{ display: 'inline-block', margin: '0 0.18em', color: active ? (card.color ?? PALETTE.yellow) : base, ...stroke(size) }}>
              {w.w}
            </span>
          );
        })
      ) : (
        <span style={{ color: base, ...stroke(size) }}>{text}</span>
      )}
    </div>
  );
};

const Hook: React.FC<{ text: string; t: number; dur: number }> = ({ text, t, dur }) => {
  if (t >= dur) return null;
  const { fps } = useVideoConfig();
  const settle = spring({ frame: Math.round(t * fps), fps, config: { damping: 13, stiffness: 220 }, durationInFrames: 9 });
  const opacity = interpolate(t, [dur - 0.2, dur], [1, 0], clamp);
  const size = text.length <= 22 ? 70 : text.length <= 40 ? 60 : 52;
  return (
    <div style={{ position: 'absolute', left: 70, right: 70, top: 215, display: 'flex', justifyContent: 'center', opacity }}>
      <div
        style={{
          transform: `scale(${interpolate(settle, [0, 1], [1.12, 1])})`,
          fontFamily: FONT,
          fontWeight: 900,
          fontSize: size,
          lineHeight: 1.1,
          color: PALETTE.white,
          textAlign: 'center',
          ...stroke(size),
        }}
      >
        {text}
      </div>
    </div>
  );
};

const Flashes: React.FC<{ flashes: StoryProps['flashes']; t: number }> = ({ flashes, t }) => {
  const f = flashes.find((x) => t >= x.t && t < x.t + 0.35);
  if (!f) return null;
  const a = interpolate(t, [f.t, f.t + 0.35], [0.6, 0], { ...clamp, easing: Easing.out(Easing.quad) });
  return <AbsoluteFill style={{ backgroundColor: f.color, opacity: a, mixBlendMode: 'screen' }} />;
};

const EndCard: React.FC<{ end: NonNullable<StoryProps['end']>; t: number; duration: number }> = ({ end, t }) => {
  const { fps } = useVideoConfig();
  if (t < end.s) return null;
  const appear = spring({ frame: Math.round((t - end.s) * fps), fps, config: { damping: 12, stiffness: 200 }, durationInFrames: 10 });
  const size = end.text.length <= 20 ? 84 : 66;
  return (
    <AbsoluteFill style={{ backgroundColor: `rgba(14,12,20,${0.45 * appear})`, justifyContent: 'center', alignItems: 'center' }}>
      <div
        style={{
          margin: '0 80px',
          transform: `scale(${interpolate(appear, [0, 1], [0.6, 1])})`,
          fontFamily: FONT,
          fontWeight: 900,
          fontSize: size,
          lineHeight: 1.1,
          color: PALETTE.white,
          textAlign: 'center',
          textTransform: 'uppercase',
          ...stroke(size),
        }}
      >
        {end.text}
      </div>
    </AbsoluteFill>
  );
};

/** Zoom "a pugno": sale del 16% in 0,12 s, tiene 0,8 s, torna in 0,5 s. */
function zoomAt(zooms: number[], t: number): number {
  let z = 0;
  for (const p of zooms) {
    const up = interpolate(t, [p, p + 0.12], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
    const down = interpolate(t, [p + 0.9, p + 1.4], [1, 0], { ...clamp, easing: Easing.inOut(Easing.cubic) });
    z = Math.max(z, Math.min(up, down));
  }
  return 1 + 0.16 * z;
}

/** Tremolio di 0,45 s che si smorza (pseudo-casuale ma deterministico). */
function shakeAt(shakes: number[], t: number): [number, number] {
  for (const p of shakes) {
    if (t >= p && t < p + 0.45) {
      const k = 1 - (t - p) / 0.45;
      const n = Math.floor(t * 60);
      return [Math.sin(n * 12.9898) * 18 * k, Math.cos(n * 78.233) * 14 * k];
    }
  }
  return [0, 0];
}
