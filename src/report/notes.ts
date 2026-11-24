/** Scelte non ovvie fatte in questa versione: finiscono in REPORT.md. */
export const CHOICES = [
  'Trascrizione con Parakeet Ultra (moondream/parakeet-ultra, post-training di parakeet-tdt-0.6b-v3) convertito per MLX da selcukkubur/parakeet-ultra-mlx, revisione fissata. Conversione non ufficiale, scelta da te al posto di mlx-community/parakeet-tdt-0.6b-v3.',
  "L'audio lungo si taglia in segmenti di al massimo 30 s nel punto più silenzioso, invece della fusione con sovrapposizione di parakeet-mlx: nessuna parola resta a cavallo di due pezzi.",
  'Con una sola traccia la trascrizione usa la voce separata da Demucs (coerente con il caso reale, dove si userà la traccia 3). Sul test la differenza con il mix è minima.',
  "Tutto (modelli, Python, librerie, cache) sta nella cartella del progetto: `bun run setup` installa, `bun run clean` cancella. Il modello Qwen resta in LM Studio.",
  'llm.ts non esisteva: l\'ho scritto seguendo la descrizione del brief (up/check/run/down, backend local/direct/claude, task.json + system.md + input.md + schema.json → output.json, LUCIO_MODEL_KEY in .env).',
  'Qwen lavora senza ragionamento separato (reasoning_effort none + schema vincolante) e con un campo `notes` all\'inizio dello schema, dove scrive 2–4 righe prima della risposta. Con il ragionamento vero LM Studio non applica lo schema e i tempi esplodono (oltre 15 min per una classifica di 3 candidati). La classifica può usarlo con LUCIO_RANK_THINK=1.',
  'Il classificatore AudioSet (AST, MIT/ast-finetuned-audioset) copre sia le risate e le urla sulla voce, sia esplosioni, spari, sirene e schianti sul gioco; misura anche la musica nel gioco, solo per l\'avviso di policy.',
  'Pesi dei segnali per i candidati: marker 1,0, Lucio 0,8, senso 0,7, voce 0,6, gioco 0,5, scene 0,2. Numero di candidati: 30 per ora di video, almeno il doppio di --count.',
  'Controllo visivo: ai 3 frame richiesti (inizio, picco, fine) aggiungo una griglia 2×2 dei secondi 1, 3, 5 e 7, perché con il solo primo frame il controllo sulla violenza nei primi 7 s sarebbe debole.',
  "Regola dell'inizio letta così: lo short parte tra 0,5 e 5 s prima della svolta (il momento in cui la situazione cambia), su una pausa del parlato; la fine cade sulla fine di una frase. Il codice corregge le proposte di Qwen che escono da queste regole.",
  "Decodifica: VideoToolbox per HEVC e H.264 (le registrazioni OBS), dav1d in software per l'AV1 del test, che su M4 Max è più veloce (37× contro 7×).",
  "Ritaglio 9:16: flusso ottico meno il movimento della telecamera (omografia), facecam e fascia bassa del 22% (HUD) ignorate, preferenza per il centro, molla smorzata con zona morta e velocità massima. Il ritaglio non entra mai nella facecam. Sfondo sfocato se fuori dal ritaglio resta almeno 12 punti di movimento in più dell'uniforme, o se la vision vede un'inquadratura larga.",
  'Zone sicure: i testi stanno tra x 140 e 940 (stesso margine a sinistra e a destra, così restano centrati) e tra y 200 e 1536.',
  'Font Montserrat (900/800) dal pacchetto @fontsource, incluso nel bundle: niente download al momento del render.',
  "Loop: negli ultimi 0,35 s il video si dissolve sul primo fotogramma (gancio compreso), così la ripartenza non ha stacchi; l'audio ha dissolvenze di 30 ms in entrata e 250 ms in uscita.",
  'DeepFilterNet non si installa senza problemi (per Python 3.12 su macOS arm64 non c\'è la wheel di deepfilterlib e servirebbe Rust): la voce passa dalla catena di src/lib/voice-eq.ts: livello misurato, gate anti-clic comandato dalla banda della voce, afftdn leggero, equalizzazione, de-esser e due compressori morbidi.',
  'Il gioco va 12 LU sotto la voce (guadagno tra −30 e +6 dB) e poi in ducking con sidechaincompress. La traccia 4 (musica) delle registrazioni OBS non entra nel mix, per evitare reclami Content ID.',
  'loudnorm in due passate punta a −1,5 dBTP per lasciare margine all\'AAC; se dopo la codifica il true peak supera −1 dBTP si rifà con più margine.',
  'Testi in inglese anche se il parlato del test è italiano; i sottotitoli restano nella lingua parlata.',
  'Se Qwen propone uno short più corto di 20 s, il codice lo porta all\'obiettivo di 35 s (non al minimo); oltre 45 s lo taglia a 45.',
  'Righe dei sottotitoli: a capo dopo 4 parole, oltre 16 caratteri, su una pausa di 0,45 s o a fine frase; una parola rimasta sola si unisce alla riga vicina o le prende una parola. Una parola resta sola solo se è isolata nel parlato.',
  'Verifica della sincronia: l\'audio dello short finito viene ritrascritto con Parakeet e confrontato parola per parola con i sottotitoli.',
];

/** Problemi noti di questa versione, indipendenti dal video. */
export const OPEN_ISSUES = [
  'Il caso OBS reale (4 tracce, chapter, verticale di Aitum, log di Lucio) è provato solo con un file sintetico costruito dal test: il primo file vero del 19 novembre va controllato a mano.',
  'Il formato del log di lucio-vite è una mia proposta (una riga JSON per frame: t, bs, yaw, pitch, roll): lucio-vite oggi non scrive nessun log.',
  'Nel layout verticale la posizione dei sottotitoli sopra Lucio è fissa (y 1180, LUCIO_VERTICAL_CAPTION_Y): va tarata sul primo verticale vero.',
  "La sincronizzazione tra il file principale e il verticale usa l'audio; se il verticale non ha audio si assume che partano insieme.",
  "Remotion è gratuito per privati e aziende fino a 3 persone; oltre serve la licenza aziendale.",
  'Sincronia: su poche parole dove Parakeet è incerto lo scarto locale arriva a circa 0,9 s (mediana sotto 100 ms). Un allineamento forzato delle parole lo ridurrebbe.',
  'Sorgente 1080p: il ritaglio 9:16 è largo 607 px e viene ingrandito 1,78×, quindi è un po\' morbido. Con le registrazioni 4K il ritaglio è di 1215 px e viene rimpicciolito.',
  'Nel test lo streamer è un altro (facecam esclusa dal ritaglio); i testi di Claude lo chiamano Lucio perché lo dice la guida del canale.',
  'Il ritaglio usa il movimento della scena e una preferenza per il centro: nelle scene di guida in terza persona resta quasi fermo al centro. Per azioni laterali rapide (sparatorie, inseguimenti a piedi) va controllato a occhio nella review.',
];
