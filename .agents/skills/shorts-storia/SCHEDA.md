# La scheda di uno short

`bun run story <scheda.json>` legge la scheda, taglia e ritaglia gli spezzoni con ffmpeg, disegna le scritte con Remotion (`StoryShort`) e normalizza l'audio a −14 LUFS. **Tutti i tempi della scheda sono in secondi del video sorgente**: lo script li porta da solo sulla linea del tempo dello short. Un tempo che non cade dentro nessuno spezzone fa fallire il render, con un messaggio che lo indica.

## Campi

| Campo | Cosa fa |
|---|---|
| `id` | nome del file d'uscita (`<id>.mp4`); usa `v20-scooter`, `v22-pro` e simili |
| `source` | il 4K finale `out/<id>/<nome>.mp4`: video e audio vengono da qui |
| `transcript` | `work/<id>/02-transcribe/transcript.json`, per le scritte `say` |
| `layout` | `split`: Lucianus sopra (0–560), gioco 4:3 sotto (560–1370), scritte sulla giuntura y=560. `panel`: intestazione fissa (0–400), gioco 4:3 (400–1210), scritte sulla giuntura y=1210. Sotto resta vuoto in tutti e due |
| `faceSource` | solo `split`: il file da cui ritagliare Lucianus, di solito `copia-720p.mp4` (il 4K può non averlo) |
| `lucio` | solo `split`: riquadro di Lucianus `{x,y,w,h}` in pixel di `faceSource`. Nel 720p il valore provato è `{"x":937,"y":470,"w":166,"h":250}`: Lucianus in un riquadro al centro con bordi sfumati, su fondo scuro |
| `avoidRight` | il ritaglio del gioco non supera questo x (pixel del sorgente). Raramente serve: per Lucianus nel 4K si usa `crop` |
| `hook`, `hookDur` | solo `split`: gancio in alto per i primi secondi (predefinito 2,2 s; 2,4–2,6 se è lungo) |
| `header` | solo `panel`: frase fissa per tutto il video; le parole tra `[quadre]` vanno in giallo |
| `segments` | gli spezzoni in ordine di montaggio (vedi sotto) |
| `cards` | le scritte (vedi sotto) |
| `flashes` | `[{ "at": s, "color": "#FF3B3B" }]`: lampo a tutto schermo di 0,35 s |
| `zooms` | `[s, …]`: zoom "a pugno" sul gioco, +16% in 0,12 s; tiene 0,8 s e torna indietro in 0,5 s |
| `shakes` | `[s, …]`: tremolio di 0,45 s che si smorza |
| `end` | `{ "text": "…", "dur": 1.4 }`: scritta finale grande sugli ultimi `dur` secondi, su fondo scurito |

## Spezzoni

`{ "s": 1622.5, "e": 1629.5 }`, più eventualmente una delle opzioni di ritaglio:

- `cx` (0–1): centro del 4:3 in frazione della larghezza. Il 4:3 copre il 75% del 16:9, quindi `cx` va da 0,375 a 0,625; i valori fuori si fermano al bordo. Sposta `cx` quando chi conta sta di lato: per esempio Peggy che corre sul bordo sinistro → `"cx": 0.375`, il telefono a destra → `0.62–0.64`.
- `crop: [x, y, w, h]`: ritaglio esplicito, scalato a 1080×810. Serve per tenere fuori Lucianus quando il 4K lo ha nell'angolo: `[0, 0, 2728, 2046]`.
- `fit: true`: il 16:9 intero su sfondo sfocato. Usalo solo quando nessun 4:3 contiene tutti quelli che contano; i sottotitoli e i dettagli diventano piccoli.
- `lift: true`: schiarisce le scene buie (notte, fondale).

Gli spezzoni vanno tagliati sulle pause del parlato. Un taglio a metà di una parola si sente anche con le dissolvenze audio da 20–30 ms.

## Scritte

A schermo c'è sempre una scritta sola: quella iniziata per ultima. Una scritta più lunga del tempo che ha resta tagliata dalla successiva, quindi distribuisci i `dur`.

| Tipo | Esempio | Uso |
|---|---|---|
| `say` | `{ "say": [1638.2, 1640.4] }` | Le parole di Michele in quell'intervallo, prese da `transcript.json`: righe di massimo 3 parole o 16 caratteri, a capo anche sulle pause > 0,35 s. La parola detta è in giallo. `max` cambia il numero di parole per riga, `color` il colore della parola attiva |
| `say` + `text` | `{ "say": [1655.3, 1659.4], "text": "oh sh*t, I feel bad a little bit" }` | Corregge la trascrizione: le parole di `text` si distribuiscono in modo uniforme nell'intervallo |
| `tag` | `{ "tag": "*parole: violated*", "at": 3544.5, "dur": 1.6, "color": "#FF3B3B" }` | Scritta d'azione o battuta di un personaggio (tra virgolette, bianca), nello stesso posto dei sottotitoli. `dur` predefinito: 1,4 s |
| `big` | `{ "big": "SHE CAN RUN??", "at": 1636.2, "dur": 1.8 }` | Scritta enorme e inclinata in mezzo al gioco, per il colpo di scena. Rossa se non indichi altro |

Le parolacce prendono l'asterisco da sole nelle `say` (f\*ck, b\*tch, sh\*t). Nelle `tag` e nelle `big` scrivile già con l'asterisco.

Colori (`PALETTE` in `StoryShort.tsx`):

- bianco `#FFFFFF`: battute dei personaggi;
- turchese `#3FE0D0`: azioni (predefinito per `tag`);
- giallo `#FFD23F`: contesto e tempo ("*8 minutes later*");
- rosso `#FF3B3B`: verdetti e cattiverie;
- rosa `#FF5FA2`: battute spinte.

## Combinazioni che funzionano

- **Il colpo** (incidente, caduta, squalo): `flash` + `zoom` + `shake` nello stesso istante, con una `big` o una `tag` rossa che parte lì.
- **La battuta del personaggio poi la smentita**: `tag` bianca tra virgolette, poi una `tag` gialla o rossa che dura 1–1,6 s.
- **Il finale**: `end` di 1,3–1,8 s. L'ultimo spezzone dura almeno `dur` + 0,5 s oltre l'ultima parola detta, così il finale non la copre.

## Comandi

```bash
bun run story out/<id>/storie/schede/<nome>.json --out /tmp/prova --draft   # metà risoluzione, CRF 28: ~20 s
bun run story out/<id>/storie/schede/<nome>.json --out out/<id>/storie      # finale: 1–2 min
```

I file intermedi (`game.mp4`, `face.mp4`, `audio.wav`, `props.json`) restano in `<out>/.<id>/` e si possono cancellare.
