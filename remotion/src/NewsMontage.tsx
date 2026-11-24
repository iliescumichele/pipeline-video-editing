import { Video } from '@remotion/media';
import { AbsoluteFill, Easing, Img, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT, loadFonts } from './fonts';

loadFonts();

const COLORS = { amber: '#FFB547', teal: '#3FD0C9', ink: '#17141F' };

/**
 * Montaggio dei video lunghi di notizie, sorgente per OBS: Lucio ci registra sopra. Niente audio
 * (la voce è la sua) e niente testi nell'angolo in basso a destra, dove OBS mette Lucio.
 * I tempi arrivano già in fotogrammi da src/news/montage.ts.
 */
export type MontageItem =
  | { kind: 'shot'; from: number; dur: number; src: string; trim: number; rate: number; leak: boolean }
  | { kind: 'image'; from: number; dur: number; src: string; credit: string }
  | { kind: 'card'; from: number; dur: number; text: string; bg?: string }
  | { kind: 'lucio'; from: number; dur: number }
  | { kind: 'chapter'; from: number; dur: number; n: number; title: string };

export interface MontageProps {
  fps: number;
  width: number;
  height: number;
  duration: number;
  items: MontageItem[];
  chapters: { from: number; n: number; title: string }[];
  /** i file arrivano da un server locale avviato da montage.ts; senza, dalla cartella pubblica */
  mediaBase?: string;
  [key: string]: unknown;
}

export const defaultMontageProps: MontageProps = {
  fps: 30,
  width: 3840,
  height: 2160,
  duration: 90,
  items: [
    { kind: 'chapter', from: 0, dur: 45, n: 1, title: 'Lucia is official' },
    { kind: 'card', from: 45, dur: 45, text: 'Fans called it · Who is Manni · 8 nominations' },
  ],
  chapters: [],
};

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const NewsMontage: React.FC<MontageProps> = ({ items, mediaBase }) => {
  const file = (name: string) => (mediaBase ? `${mediaBase}/${encodeURIComponent(name)}` : staticFile(name));
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink }}>
      {items.map((it, i) => (
        <Sequence key={i} name={`${it.kind} ${i}`} from={it.from} durationInFrames={it.dur} premountFor={30}>
          <Item it={it} file={file} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

const Item: React.FC<{ it: MontageItem; file: (name: string) => string }> = ({ it, file }) => {
  const { fps } = useVideoConfig();
  switch (it.kind) {
    case 'shot':
      return (
        <AbsoluteFill>
          <Video src={file(it.src)} trimBefore={Math.round(it.trim * fps)} playbackRate={it.rate} muted objectFit="cover" style={{ width: '100%', height: '100%' }} />
          {it.leak && <LeakBadge />}
        </AbsoluteFill>
      );
    case 'image':
      return <ImageScene src={file(it.src)} credit={it.credit} dur={it.dur} />;
    case 'card':
      return (
        <AbsoluteFill>
          {it.bg ? <BlurredStill src={file(it.bg)} dur={it.dur} /> : <BrandBackground />}
          <Card text={it.text} />
        </AbsoluteFill>
      );
    case 'lucio':
      return <BrandBackground />;
    case 'chapter':
      return (
        <AbsoluteFill>
          <BrandBackground />
          <ChapterTitle n={it.n} title={it.title} />
        </AbsoluteFill>
      );
  }
};

/** Sfondo del canale: inchiostro con due luci ambra e turchese che si muovono piano. */
const BrandBackground: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          width: 2600,
          height: 2600,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${COLORS.amber}33 0%, transparent 60%)`,
          translate: `${interpolate(frame, [0, 600], [-600, 200], { extrapolateRight: 'extend' }) % 1400}px -700px`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 2400,
          height: 2400,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${COLORS.teal}2b 0%, transparent 60%)`,
          translate: `${1800 - (interpolate(frame, [0, 600], [0, 500], { extrapolateRight: 'extend' }) % 1200)}px 300px`,
        }}
      />
    </AbsoluteFill>
  );
};

/** Fotogramma dell'ultima inquadratura, sfocato e scurito, che si muove piano: il cartello non è mai fermo. */
const BlurredStill: React.FC<{ src: string; dur: number }> = ({ src, dur }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: COLORS.ink }}>
      <Img
        src={src}
        style={{
          position: 'absolute',
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          filter: 'blur(48px) brightness(0.42) saturate(1.2)',
          scale: interpolate(frame, [0, dur], [1.12, 1.24], clamp),
          translate: `${interpolate(frame, [0, dur], [-40, 40], clamp)}px 0px`,
        }}
      />
      <AbsoluteFill style={{ background: `linear-gradient(90deg, ${COLORS.ink}cc 0%, ${COLORS.ink}55 70%, transparent 100%)` }} />
    </AbsoluteFill>
  );
};

/** Immagine intera su una copia sfocata di sé stessa, con un lento avvicinamento e la fonte. */
const ImageScene: React.FC<{ src: string; credit: string; dur: number }> = ({ src, credit, dur }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Img src={src} style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(60px) brightness(0.55)', scale: 1.15 }} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Img
          src={src}
          // Le immagini degli articoli sono di solito larghe ~1200 px: si portano a 2400, mai oltre 1500 di altezza.
          style={{
            width: 2400,
            maxHeight: 1500,
            objectFit: 'contain',
            borderRadius: 24,
            boxShadow: '0 40px 120px rgba(0,0,0,0.6)',
            scale: interpolate(frame, [0, dur], [1, 1.06], clamp),
          }}
        />
      </AbsoluteFill>
      {credit && (
        <div style={{ position: 'absolute', left: 120, bottom: 110, fontFamily: FONT, fontWeight: 800, fontSize: 44, color: '#fff', background: 'rgba(23,20,31,0.75)', padding: '12px 26px', borderRadius: 14 }}>
          Fonte: {credit}
        </div>
      )}
    </AbsoluteFill>
  );
};

const LeakBadge: React.FC = () => (
  <div style={{ position: 'absolute', left: 120, top: 110, display: 'flex', gap: 18, alignItems: 'center', fontFamily: FONT }}>
    <span style={{ fontWeight: 900, fontSize: 60, color: COLORS.ink, background: COLORS.amber, padding: '8px 26px', borderRadius: 14, letterSpacing: '0.04em' }}>LEAK</span>
    <span style={{ fontWeight: 800, fontSize: 44, color: '#fff', background: 'rgba(23,20,31,0.75)', padding: '12px 24px', borderRadius: 14 }}>materiale non ufficiale</span>
  </div>
);

/**
 * Cartello: un elenco ("a · b · c") esce una voce alla volta; una citazione («…» o "…" con la
 * testata tra parentesi) ha le virgolette grandi; il resto è un titolo. I numeri sono in ambra.
 */
const Card: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const items = text.split(' · ').map((x) => x.trim()).filter(Boolean);
  if (items.length > 1) {
    return (
      <AbsoluteFill style={{ justifyContent: 'center', paddingLeft: 280, gap: 48 }}>
        {items.map((x, i) => (
          <div
            key={i}
            style={{
              fontFamily: FONT,
              fontWeight: 900,
              fontSize: items.length > 5 ? 140 : 176,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              gap: 60,
              opacity: interpolate(frame, [i * 0.45 * fps, i * 0.45 * fps + 8], [0, 1], clamp),
              translate: `${interpolate(frame, [i * 0.45 * fps, i * 0.45 * fps + 12], [-80, 0], { ...clamp, easing: Easing.out(Easing.cubic) })}px 0px`,
            }}
          >
            <span style={{ width: 38, height: 38, borderRadius: 10, background: i % 2 ? COLORS.teal : COLORS.amber, flex: 'none' }} />
            {/* un solo blocco di testo: i numeri in ambra non diventano elementi separati della riga */}
            <span>{highlight(x)}</span>
          </div>
        ))}
      </AbsoluteFill>
    );
  }
  const quote = text.match(/^\s*[«"“](.+?)[»"”]\s*(?:\((.+)\))?\s*$/);
  const appear = { opacity: interpolate(frame, [0, 10], [0, 1], clamp), translate: `0px ${interpolate(frame, [0, 14], [60, 0], { ...clamp, easing: Easing.out(Easing.cubic) })}px` };
  if (quote) {
    return (
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 380px' }}>
        <div style={{ ...appear, fontFamily: FONT, textAlign: 'center' }}>
          <div style={{ fontWeight: 900, fontSize: 440, lineHeight: 0.6, color: COLORS.amber }}>“</div>
          <div style={{ fontWeight: 900, fontSize: 196, lineHeight: 1.1, color: '#fff' }}>{highlight(quote[1]!)}</div>
          {quote[2] && <div style={{ marginTop: 60, fontWeight: 800, fontSize: 96, color: COLORS.teal }}>— {quote[2]}</div>}
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 340px' }}>
      <div style={{ ...appear, fontFamily: FONT, fontWeight: 900, fontSize: text.length > 60 ? 190 : text.length > 30 ? 230 : 280, lineHeight: 1.06, color: '#fff', textAlign: 'center', letterSpacing: '-0.01em' }}>
        {highlight(text)}
      </div>
      <div style={{ ...appear, marginTop: 80, width: 340, height: 24, borderRadius: 12, background: COLORS.teal }} />
    </AbsoluteFill>
  );
};

const ChapterTitle: React.FC<{ n: number; title: string }> = ({ n, title }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: 'center', paddingLeft: 260, fontFamily: FONT }}>
      <div style={{ fontWeight: 800, fontSize: 100, color: COLORS.teal, letterSpacing: '0.12em', opacity: interpolate(frame, [0, 8], [0, 1], clamp) }}>CAPITOLO {String(n).padStart(2, '0')}</div>
      <div
        style={{
          marginTop: 20,
          fontWeight: 900,
          fontSize: 270,
          color: '#fff',
          maxWidth: 3200,
          lineHeight: 1.04,
          translate: `${interpolate(frame, [0, 14], [-120, 0], { ...clamp, easing: Easing.out(Easing.cubic) })}px 0px`,
          opacity: interpolate(frame, [0, 10], [0, 1], clamp),
        }}
      >
        {title}
      </div>
    </AbsoluteFill>
  );
};

/** Numeri, date e percentuali in ambra: l'occhio li trova subito. */
function highlight(text: string): React.ReactNode {
  return text.split(/(\d[\d.,:%+]*\w*)/g).map((part, i) => (i % 2 ? <span key={i} style={{ color: COLORS.amber }}>{part}</span> : part));
}
