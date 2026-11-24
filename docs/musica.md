# Canzoni protette nel gameplay

Le canzoni protette (la radio di GTA, le cutscene) si sostituiscono con musica libera simile, senza che si senta il
cambio: dialoghi ed effetti del gioco restano gli originali, la voce non si tocca.

## Dove sta e perché

Lavora sulla **traccia del gioco** (traccia 1 della registrazione), **prima del mix con la voce**. Il risultato è
`work/<id>/gameplay/gioco-senza-canzoni.flac`, identico bit per bit all'originale fuori dai tratti sostituiti: mix,
anteprima, video finale e tracce per gli short lo usano al posto della traccia 1 (`gameInput` in
`src/gameplay/gameplay.ts`). Così:

- la voce non passa mai dalla separazione (è un'altra traccia);
- la musica nuova finisce anche negli short, che sono i più esposti al Content ID;
- il video non si ricodifica: dopo un export, `esporta --solo-audio` rimonta solo l'audio.

La traccia lavorata è quella della registrazione, con i tratti tagliati saltati, non una traccia già tagliata: il
mix con la voce si fa sulla timeline della registrazione e i tagli si applicano all'export, e spostare tutto sulla
timeline finale avrebbe voluto dire rifare mix, anteprima e tracce. I tempi che vedi (report, file dei tratti da
YouTube Studio) sono quelli del video pubblicato, convertiti con i tagli.

## Come si usa (dashboard, Video → Video lungo)

1. **Trovare le canzoni**: "Cerca le canzoni" (Shazam ascolta solo i tratti che restano nel video), oppure segna
   un tratto con **I** e poi **♪ Segna come canzone**. I tratti compaiono sulla timeline in viola: pieni se hanno
   già una musica scelta, tratteggiati se no. Quelli trovati da Shazam sono proposte: non cambiano niente finché
   non scegli una musica.
2. **Scegliere la musica**: "Proposte" dà 6 brani dalla tua libreria e 6 dal catalogo di Kevin MacLeod, da ascoltare
   lì; "Usa" la sceglie (quelli del catalogo si scaricano nella libreria con la loro attribuzione). Si può anche
   incollare un link YouTube (per esempio della YouTube Audio Library).
3. **Applica la musica**: separa e ricostruisce i tratti (circa un minuto per tratto). Nel player, dentro i tratti,
   senti già il gioco ricostruito; con "Salta i tagli" senti il video come sarà.
4. Esporta. Se cambi musica dopo l'export: Applica, poi `bun run gameplay esporta <registrazione> --solo-audio`.

Il report per il controllo a orecchio e per la descrizione del video (tempi, canzone trovata, sostituto, licenza,
attribuzione) è in `out/<id>/musica.json`.

### Da riga di comando, anche su un audio già esportato

```sh
bun run musica cerca  video.mp4                        # → video.canzoni.json e video.tratti.txt
bun run musica pulisci video.mp4 --tratti tratti.txt   # → video.senza-canzoni.flac e video.musica.json
bun run musica indicizza                               # impronte e BPM della libreria
```

`tratti.txt`: una riga per tratto, `inizio - fine [brano]`, con tempi come `1:16:25`, `76:25` o `4585` (per esempio
copiati dai "Controlli" di YouTube Studio dopo un caricamento privato); il brano è un file o "Autore - Titolo" della
libreria, altrimenti quello di `--musica`. Con i tratti il rilevamento non si fa. Su un video già esportato la prima
traccia è il mix: la voce finisce nei "dialoghi" della separazione e resta.

## Come funziona la sostituzione

Per ogni tratto (`python/replace_music.py`):

- **Separazione** con BandIt Plus in tre parti, dialoghi, musica ed effetti, su una finestra con qualche secondo di
  margine (`marginS`), sulla GPU del Mac se c'è (circa 2× il tempo reale) o sulla CPU (circa 0,8×).
- **Sostituisci** (la canzone si sente): la musica nuova segue l'**andamento** del volume della sola musica originale
  (finestre da 50 ms, smussate su mezzo secondo): scende sotto i dialoghi e sfuma come lei, tace dove lei tace
  (`musicSilenceDb`), l'amplificazione ha un tetto (`maxGainDb`). Il tratto diventa dialoghi + effetti + musica
  nuova.
- **Aggiungi** (la canzone era già spenta nel gioco: c'è musica per meno del 25% del tratto): niente da togliere,
  il gioco resta com'è, senza passare dalla separazione, e la musica si somma al livello del gioco nel minuto prima
  e nel minuto dopo il tratto (dentro, con la radio spenta, il gioco è più basso del solito), regolabile per tratto
  con "Volume se aggiunta". "Automatico" sceglie da sé.
- Dissolvenza incrociata ai bordi (`fadeS`), picchi sotto −1 dBFS.
- Fuori dai tratti si copiano i campioni interi del FLAC a 24 bit: identico bit per bit (lo verificano i test).

## Configurazione: `config/musica.json`

| Chiave | Di base | Cosa fa |
|---|---|---|
| `enabled` | `true` | `false`: mix ed export usano la traccia originale anche se c'è il gioco senza canzoni |
| `library` | `data/musica-libera` | cartella della musica libera |
| `windowS`, `coarseHopS`, `hopS` | 12, 24, 6 | finestre di Shazam: lunghezza, avanzamento della prima passata e di quella fine |
| `pauseS` | 3 | pausa fra due richieste a Shazam |
| `silenceDb` | −50 | finestre più silenziose di così non si mandano a Shazam |
| `minHits` | 2 | quante finestre devono riconoscere la stessa canzone per tenerla |
| `fadeS` | 1,5 | dissolvenza ai bordi dei tratti |
| `marginS` | 6 | margine della separazione attorno a ogni tratto |
| `maxGainDb` | 12 | tetto dell'amplificazione della musica nuova |
| `musicSilenceDb` | −65 | sotto questo livello la musica originale "tace" |

## La libreria musicale

`data/musica-libera/`: file audio (mp3, m4a, wav, flac, ogg, opus, webm) con accanto, facoltativo, un `.json` con
`title`, `artist`, `origin`, `url`, `license`, `attribution`. Senza `.json`, autore e titolo vengono dal nome
(`Autore - Titolo.mp3`). Le impronte (CLAP) e i BPM si calcolano una volta e stanno in `.indice.json`; il catalogo
di Kevin MacLeod in `.catalogo-incompetech.json` (si riscarica una volta al mese). Prima di pubblicare controlla la
licenza di ogni brano: YouTube Audio Library e Pixabay di solito non chiedono attribuzione, Kevin MacLeod sì
(CC BY 4.0). Evita le licenze "NC" su video monetizzati.

## Limiti noti

- **Canzoni cantate**: la voce del cantante può finire fra i dialoghi e restare. Ascolta i tratti con il cantato
  (il report dice quanta musica c'era nel tratto).
- **Separazione non perfetta**: i dialoghi escono puliti (15,6 dB di SDR sui dati di prova), musica ed effetti un
  po' meno (circa 9–10 dB): nei tratti sostituiti può restare un'eco della canzone negli effetti. Fuori dai tratti
  non ci sono artefatti, perché lì non si separa niente.
- **Shazam** è gratuito ma non ufficiale (`shazamio`): può sbagliare (soprattutto su musica di libreria), cambiare o
  bloccare. Se smette di rispondere la ricerca si ferma, il riquadro e il report lo dicono, e i tratti si segnano a
  mano o si incollano da YouTube Studio.
- **Bordi**: la precisione dipende dalle finestre (6 s); vengono rifiniti sull'energia della musica separata, e si
  correggono a mano con "Inizio = " e "Fine = ".

## Dipendenze (tutte gratuite, in locale tranne Shazam)

| Cosa | Licenza | Per |
|---|---|---|
| Codice di ZFTurbo/Music-Source-Separation-Training (in `.tools/msst`, commit fisso) | MIT | architettura di BandIt |
| Pesi BandIt Plus DnR (`models/bandit-dnr`, 149 MB) | non dichiarata; download gratuito | separazione |
| LAION CLAP `laion/clap-htsat-unfused` (`models/clap-htsat-unfused`, 596 MB) | Apache-2.0 | proposte simili |
| `shazamio` | MIT (servizio Shazam non ufficiale, gratuito) | rilevamento |
| `torchaudio`, `spafe` | BSD | richiesti da BandIt |
| `librosa` (c'era già) | ISC | BPM |
| `yt-dlp` (c'era già) | Unlicense | brani da link YouTube |

Si installano con `bun run setup` (`models.json` e `python/pyproject.toml`).
