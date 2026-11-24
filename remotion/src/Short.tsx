import { AbsoluteFill, Easing, Freeze, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT, loadFonts } from './fonts';

loadFonts();

export const COLORS = { amber: '#FFB547', teal: '#3FD0C9', ink: '#17141F' };

/**
 * Zone sicure per le interfacce di TikTok, Reels e Shorts: niente testo nei 200 px in alto, nei
 * 140 px a destra e nel 20% in basso (y > 1536). A sinistra si lascia lo stesso margine della
 * destra, così i testi restano centrati.
 */
export const SAFE = { left: 140, right: 940, top: 200, bottom: 1536 };

export type Layout = 'gameplay' | 'crop' | 'blur' | 'vertical';

export interface CaptionWord {
  w: string;
  s: number;
  e: number;
}

export interface CaptionLine {
  s: number;
  e: number;
  words: CaptionWord[];
}

export interface ShortProps {
  fps: number;
  /** secondi */
  duration: number;
  layout: Layout;
  /** file nella public dir: lo spezzone già tagliato */
  src: string;
  /** solo per layout blur: sfondo sfocato già preparato con ffmpeg */
  bg?: string;
  srcWidth: number;
  srcHeight: number;
  /** centri del ritaglio in frazioni della larghezza, campionati a hz */
  crop: { hz: number; centres: number[] };
  hook: string;
  lines: CaptionLine[];
  /** istanti (s) delle reazioni su cui zoomare */
  zooms: number[];
  /** centro verticale dei sottotitoli */
  captionY: number;
  /** bordo alto del riquadro del gancio */
  hookY: number;
  /** per il layout blur: dove sta il video 16:9 */
  blurTop: number;
  loopSeconds: number;
  /** solo per layout gameplay: Lucio scontornato (video con trasparenza nella public dir) */
  facecam?: string;
  /** solo per layout gameplay: zona libera tra le interfacce delle app, dove sta il gioco */
  content?: { top: number; bottom: number };
  /** solo per layout gameplay: dove sta Lucio */
  cam?: { left: number; top: number; height: number };
  /** solo per layout gameplay: il 16:9 intero nella zona libera invece del ritaglio */
  fit?: boolean;
  safeDebug?: boolean;
  [key: string]: unknown;
}

export const defaultProps: ShortProps = {
  fps: 60,
  duration: 35,
  layout: 'crop',
  src: 'clip.mp4',
  srcWidth: 1920,
  srcHeight: 1080,
  crop: { hz: 10, centres: [0.5] },
  hook: 'Hook goes here',
  lines: [],
  zooms: [],
  captionY: 1300,
  hookY: 250,
  blurTop: 640,
  loopSeconds: 0.35,
};

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const Short: React.FC<ShortProps> = (p) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const loopStart = durationInFrames - Math.max(2, Math.round(p.loopSeconds * fps));
  const fade = interpolate(frame, [loopStart, durationInFrames - 1], [0, 1], { ...clamp, easing: Easing.inOut(Easing.quad) });
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink }}>
      <Scene p={p} />
      {/* Finale: dissolvenza sul primo fotogramma, così il loop riparte senza stacco. */}
      {frame >= loopStart && (
        <AbsoluteFill style={{ opacity: fade }}>
          <Freeze frame={0}>
            <Scene p={p} />
          </Freeze>
        </AbsoluteFill>
      )}
      {p.safeDebug && <SafeZones />}
    </AbsoluteFill>
  );
};

const Scene: React.FC<{ p: ShortProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const z = zoomAt(p.zooms, t);
  const originY = p.layout === 'blur' ? p.blurTop + (1080 * p.srcHeight) / p.srcWidth / 2 : 900;
  return (
    <AbsoluteFill>
      {p.layout === 'gameplay' ? (
        <GameplayLayer p={p} t={t} z={z} />
      ) : (
        <AbsoluteFill style={{ transform: `scale(${z})`, transformOrigin: `540px ${originY}px` }}>
          <VideoLayer p={p} t={t} />
        </AbsoluteFill>
      )}
      <Captions p={p} t={t} />
      <Hook p={p} frame={frame} fps={fps} />
    </AbsoluteFill>
  );
};

/**
 * Gameplay: lo stesso gioco sfocato dietro le zone delle app (in alto e in basso), il gioco nitido nella zona
 * libera (ritaglio che segue l'azione, o il 16:9 intero) con lo zoom solo lì dentro, e Lucio sopra, in alto a
 * sinistra, fermo anche durante gli zoom.
 */
const GameplayLayer: React.FC<{ p: ShortProps; t: number; z: number }> = ({ p, t, z }) => {
  const box = p.content ?? { top: 230, bottom: 1500 };
  const h = box.bottom - box.top;
  const fitH = (1080 * p.srcHeight) / p.srcWidth;
  const w = (p.srcWidth * h) / p.srcHeight;
  const video = p.fit ? (
    <OffthreadVideo src={staticFile(p.src)} muted style={{ position: 'absolute', left: 0, top: (h - fitH) / 2, width: 1080, height: fitH }} />
  ) : (
    <OffthreadVideo src={staticFile(p.src)} muted style={{ position: 'absolute', top: 0, left: 540 - cropAt(p.crop, t) * w, width: w, height: h, maxWidth: 'none' }} />
  );
  return (
    <AbsoluteFill>
      {p.bg && <OffthreadVideo src={staticFile(p.bg)} muted style={{ width: 1080, height: 1920 }} />}
      <div style={{ position: 'absolute', left: 0, top: box.top, width: 1080, height: h, overflow: 'hidden', boxShadow: '0 0 60px rgba(0,0,0,0.55)' }}>
        <AbsoluteFill style={{ transform: `scale(${z})`, transformOrigin: `540px ${h / 2}px` }}>{video}</AbsoluteFill>
      </div>
      {p.facecam && p.cam && (
        <OffthreadVideo
          src={staticFile(p.facecam)}
          transparent
          muted
          style={{ position: 'absolute', left: p.cam.left, top: p.cam.top, height: p.cam.height, filter: 'drop-shadow(0 10px 24px rgba(0,0,0,0.5))' }}
        />
      )}
    </AbsoluteFill>
  );
};

const VideoLayer: React.FC<{ p: ShortProps; t: number }> = ({ p, t }) => {
  const src = staticFile(p.src);
  if (p.layout === 'vertical') {
    return <OffthreadVideo src={src} muted style={{ width: 1080, height: 1920 }} />;
  }
  if (p.layout === 'blur') {
    const h = (1080 * p.srcHeight) / p.srcWidth;
    return (
      <AbsoluteFill>
        {p.bg && <OffthreadVideo src={staticFile(p.bg)} muted style={{ width: 1080, height: 1920 }} />}
        <OffthreadVideo
          src={src}
          muted
          style={{ position: 'absolute', left: 0, top: p.blurTop, width: 1080, height: h, boxShadow: '0 30px 80px rgba(0,0,0,0.55)' }}
        />
      </AbsoluteFill>
    );
  }
  const w = (p.srcWidth * 1920) / p.srcHeight;
  const left = 540 - cropAt(p.crop, t) * w;
  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: '#000' }}>
      <OffthreadVideo src={src} muted style={{ position: 'absolute', top: 0, left, width: w, height: 1920, maxWidth: 'none' }} />
    </AbsoluteFill>
  );
};

const Captions: React.FC<{ p: ShortProps; t: number }> = ({ p, t }) => {
  const { fps } = useVideoConfig();
  const line = p.lines.find((l) => t >= l.s && t < l.e);
  if (!line) return null;
  const text = line.words.map((w) => w.w).join(' ');
  const width = SAFE.right - SAFE.left;
  // Montserrat Black maiuscolo: circa 0,74 em per carattere.
  const size = Math.min(96, Math.max(46, width / (text.length * 0.74)));
  const appear = spring({ frame: Math.round((t - line.s) * fps), fps, config: { damping: 18, stiffness: 260 }, durationInFrames: 8 });
  return (
    <div
      style={{
        position: 'absolute',
        left: SAFE.left,
        width,
        top: p.captionY - size * 0.6,
        textAlign: 'center',
        fontFamily: FONT,
        fontWeight: 900,
        fontSize: size,
        lineHeight: 1.15,
        letterSpacing: '-0.01em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        transform: `scale(${interpolate(appear, [0, 1], [0.9, 1])})`,
        opacity: appear,
      }}
    >
      {line.words.map((w, i) => {
        const next = line.words[i + 1];
        const active = t >= w.s && (!next || t < next.s);
        return (
          <span
            key={`${w.s}-${i}`}
            style={{
              display: 'inline-block',
              margin: '0 0.2em',
              color: active ? COLORS.amber : '#FFFFFF',
              WebkitTextStroke: `${Math.round(size * 0.14)}px ${COLORS.ink}`,
              paintOrder: 'stroke fill',
              textShadow: `0 ${Math.round(size * 0.07)}px 0 ${COLORS.ink}`,
              transform: active ? 'scale(1.05) translateY(-2px)' : 'none',
            }}
          >
            {w.w}
          </span>
        );
      })}
    </div>
  );
};

const Hook: React.FC<{ p: ShortProps; frame: number; fps: number }> = ({ p, frame, fps }) => {
  const end = Math.round(1.5 * fps);
  if (frame >= end || !p.hook) return null;
  const settle = spring({ frame, fps, config: { damping: 14, stiffness: 200 }, durationInFrames: 10 });
  const scale = interpolate(settle, [0, 1], [1.07, 1]);
  const opacity = interpolate(frame, [end - 8, end - 1], [1, 0], clamp);
  const text = p.hook.toUpperCase();
  const size = text.length <= 16 ? 104 : text.length <= 26 ? 90 : 78;
  return (
    <div style={{ position: 'absolute', left: SAFE.left, width: SAFE.right - SAFE.left, top: p.hookY, display: 'flex', justifyContent: 'center', opacity }}>
      <div
        style={{
          transform: `scale(${scale})`,
          background: 'rgba(23, 20, 31, 0.92)',
          borderRadius: 30,
          padding: '22px 34px 26px',
          borderBottom: `12px solid ${COLORS.teal}`,
          maxWidth: SAFE.right - SAFE.left,
          boxShadow: '0 18px 50px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: size, lineHeight: 1.04, color: '#FFFFFF', textAlign: 'center', letterSpacing: '-0.015em' }}>
          {highlightLast(text)}
        </div>
      </div>
    </div>
  );
};

/** L'ultima parola del gancio in ambra: dà un punto d'arrivo all'occhio. */
function highlightLast(text: string): React.ReactNode {
  const i = text.lastIndexOf(' ');
  if (i < 0) return <span style={{ color: COLORS.amber }}>{text}</span>;
  return (
    <>
      {text.slice(0, i + 1)}
      <span style={{ color: COLORS.amber }}>{text.slice(i + 1)}</span>
    </>
  );
}

const SafeZones: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: 'none' }}>
    <div style={{ position: 'absolute', left: 0, top: 0, width: 1080, height: SAFE.top, background: 'rgba(255,0,0,0.35)' }} />
    <div style={{ position: 'absolute', left: SAFE.right, top: 0, width: 1080 - SAFE.right, height: 1920, background: 'rgba(255,0,0,0.35)' }} />
    <div style={{ position: 'absolute', left: 0, top: SAFE.bottom, width: 1080, height: 1920 - SAFE.bottom, background: 'rgba(255,0,0,0.35)' }} />
  </AbsoluteFill>
);

function cropAt(c: ShortProps['crop'], t: number): number {
  const x = t * c.hz;
  const i = Math.floor(x);
  const a = c.centres[Math.min(c.centres.length - 1, Math.max(0, i))] ?? 0.5;
  const b = c.centres[Math.min(c.centres.length - 1, Math.max(0, i + 1))] ?? a;
  return a + (b - a) * (x - i);
}

/** Zoom morbido sulle reazioni: sale in 0,35 s fino al 10%, tiene, torna in 0,9 s. */
function zoomAt(zooms: number[], t: number): number {
  let z = 0;
  for (const p of zooms) {
    const up = interpolate(t, [p - 0.25, p + 0.1], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
    const down = interpolate(t, [p + 1.0, p + 1.9], [1, 0], { ...clamp, easing: Easing.inOut(Easing.cubic) });
    z = Math.max(z, Math.min(up, down));
  }
  return 1 + 0.1 * z;
}
