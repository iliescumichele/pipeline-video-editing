import { cancelRender, continueRender, delayRender } from 'remotion';
import black from '@fontsource/montserrat/files/montserrat-latin-900-normal.woff2';
import extraBold from '@fontsource/montserrat/files/montserrat-latin-800-normal.woff2';

export const FONT = 'Montserrat';

let started = false;

/** Carica Montserrat dai file del pacchetto (nessuna rete) e ferma il render finché non è pronto. */
export function loadFonts(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  const handle = delayRender('font Montserrat');
  Promise.all([
    new FontFace(FONT, `url(${black}) format('woff2')`, { weight: '900' }).load(),
    new FontFace(FONT, `url(${extraBold}) format('woff2')`, { weight: '800' }).load(),
  ])
    .then((faces) => {
      for (const f of faces) document.fonts.add(f);
      continueRender(handle);
    })
    .catch((e) => cancelRender(e));
}
