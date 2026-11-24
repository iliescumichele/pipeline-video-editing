---
name: shorts-storia
description: Monta short "a storia" (più tagli, black humor nelle scritte, 9:16 con gioco 4:3) da un video lungo di gameplay di Michele in out/<id>/. Usala quando chiede short, clip per i social, Reels/TikTok/Shorts da un episodio, o di rifare/correggere uno short di storie/.
---

# Short a storia

Uno short a storia **non è un pezzo del video lungo**: è una piccola storia (setup → escalation → payoff) montata con 4–9 spezzoni presi anche a minuti di distanza, con il black humor portato dalle scritte, perché Michele parla poco. Lo stile e le regole di Michele sono in [STILE.md](STILE.md): leggilo per intero prima del passo 2. Il formato della scheda JSON e gli effetti sono in [SCHEDA.md](SCHEDA.md). Gli short già approvati, con le schede vere, sono in [esempi/](esempi/README.md).

Strumenti (tutti da `pipeline-video-content-long-short/`):

- `bun run story:tools sheets|strip|subs|lucio|words …`: guardare il video (intestazione di `src/story/tools.ts`)
- `bun run story <scheda.json> [--out dir] [--draft]`: montare lo short (`src/story/story.ts` + `remotion/src/StoryShort.tsx`)

## Ingressi

Per ogni episodio, `out/<id>/` contiene il 4K finale `<nome>.mp4` (gioco + audio mixato), `copia-720p.mp4` (stessa linea del tempo, fotogramma per fotogramma) e `<nome>.tracce.m4a`. La trascrizione sta in `work/<id>/02-transcribe/transcript.{txt,json}`, i segnali in `work/<id>/03-signals/`.
Se mancano, lancia `bun run shorts "<4K>.mp4" --until 03` (7–40 min). In un terminale Rex va in un pane visibile, come dice il CLAUDE.md globale.

## Passi

### 1. Mappa del video

1. `story:tools sheets out/<id>/copia-720p.mp4`: leggi **tutti** i fogli (un fotogramma ogni 10 s).
2. Leggi tutta `transcript.txt`.
3. `story:tools lucio` sul 4K **e** sul 720p (vedi Trappole).

Il passo è finito quando hai una cronologia a fasi che copre tutta la durata, e per ogni fase sai se è gioco, filmato Rockstar, menu o telefono, e se Lucianus si vede nel 4K e/o nel 720p.

Con due episodi o più, dai ogni episodio a un subagente con questo stesso brief (passi 1–2, solo analisi) e tieni per te la scelta e le scritte.

### 2. Storie candidate

Cerca 6–8 storie e ordinale dalla migliore. Ognuna ha:

- un titolo di lavoro;
- la storia in una frase;
- gli spezzoni `[s, e]` in secondi del sorgente;
- lo spezzone del payoff;
- le battute di Michele (testo e tempi da `story:tools words`);
- le battute dei personaggi (da `story:tools subs`);
- le scritte proposte;
- un voto severo su 10, con il rischio principale.

I criteri sono in STILE.md, sezione "Cosa fa una storia".
Verifica ogni storia sui fotogrammi con `story:tools strip <video> <s> <durata> --fps 2` attorno ai momenti chiave: chi è in campo, dove sta nell'inquadratura (serve per `cx`), quando avviene lo scontro o la caduta.

Il passo è finito quando ogni spezzone di ogni candidata è stato visto sui fotogrammi e ogni battuta citata ha un tempo letto dai sottotitoli o dalla trascrizione. Salva tutto in `out/<id>/storie/storie-candidate.md`.

### 3. Schede

Per le 3–5 storie migliori scrivi `out/<id>/storie/schede/<id-breve>-<nome>.json`, seguendo SCHEDA.md.
Ogni spezzone deve servire il filo della storia. Rileggi la scheda come uno spettatore che non ha visto il lungo: se uno spezzone non si capisce senza contesto, toglilo o aggiungi una scritta che lo spieghi.

### 4. Bozza e revisione

1. `bun run story <scheda> --out <cartella-di-prova> --draft`
2. Foglio di controllo: `ffmpeg -i <short>.mp4 -vf "fps=1/2,scale=180:-1,tile=11x3:padding=2:color=white" -frames:v 1 foglio.jpg`, poi guardalo.

Controlla ogni punto:

- [ ] Ogni scritta compare sul momento giusto e non copre la successiva. Il finale (`end`) non copre l'ultima parola detta.
- [ ] Ogni battuta dei personaggi che regge la storia è leggibile come scritta nostra.
- [ ] Chi conta è dentro il 4:3. Altrimenti sposta `cx` o usa `fit`.
- [ ] Lucianus non compare due volte (riquadro in alto più angolo del gioco).
- [ ] Le parole di Michele sono giuste. Se la trascrizione sbaglia, usa `text`.
- [ ] Nessuno stacco interrompe il climax a metà.
- [ ] La durata è di 30–45 s.

Il passo è finito quando la bozza passa tutta la lista.

### 5. Render finale e testi

1. `bun run story <scheda> --out out/<id>/storie`: 1080×1920, 60 fps, −14 LUFS; sono 1–2 min a short.
2. Accanto al video scrivi `<nome> - testi.txt` con YouTube Shorts, Instagram Reels e TikTok, nel formato e con le regole di `style/CHANNEL.md` (titolo, descrizione, 3–5 hashtag). Copia lo schema dagli esempi.

### 6. Consegna

Scrivi a Michele una tabella: short, durata, storia in una riga.
Poi le cose da verificare a orecchio: chi parla quando al microfono sono in due, le parolacce nell'audio (nelle scritte hanno l'asterisco), i secondi di filmato Rockstar (Content ID).
Infine le storie candidate rimaste, con il loro voto.
Le correzioni di Michele vanno in STILE.md, sezione "Regole di Michele", con la data.

## Trappole

- **Lucianus.** Nel lungo del 20/11 il 4K ha Lucianus solo fino a ~935 s; il 720p lo ha sempre. Nel 22/11 non c'è in nessuno dei due (la registrazione di Lucianus si era bloccata). Decidi il layout con `story:tools lucio`, non a occhio:
  - **split** se c'è nel 720p: `faceSource` = 720p;
  - **panel** se non c'è.

  Dove il 4K ce l'ha nell'angolo, il gioco usa `crop: [0, 0, 2728, 2046]`, un 4:3 spostato a sinistra che lo lascia fuori.
- **La trascrizione mescola voci.** Ci finiscono battute dei personaggi (passate nella traccia della voce) e, nel 22/11, anche la ragazza di Michele, che guardava con lui. La voce di Michele sta tra −17 e −32 dB; le battute del gioco sono a −45…−65 dB. Quando non sei sicuro di chi parla, non attribuire la battuta nelle scritte.
- **Parakeet sbaglia le parole dette in fretta.** Per esempio "Oh shut feel bad a little bit" invece di "oh sh*t, I feel bad a little bit": correggi con `text` nella scheda.
- **I sottotitoli del gioco escono tagliati nel 4:3.** Le battute che contano le riscrivi come scritte nostre (`tag` bianco tra virgolette), con i tempi letti da `story:tools subs`.
- **I filmati Rockstar fanno scattare il Content ID.** Usali solo come setup breve, mai come storia intera.
- **Temi da evitare.** Droga e scene di letto si scartano: limitano la diffusione.
- **ffmpeg non ha `drawtext`.** Per scrivere l'orario sulle immagini usa `story:tools`.
