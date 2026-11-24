# Stile degli short a storia

Le regole vengono da due fonti: l'analisi di 11 short virali di GTA 6 scelti da Michele (24/11/2026) e le sue correzioni sugli short fatti. Se una regola di Michele contraddice gli esempi, vince Michele.

## Regole di Michele

Aggiungi qui ogni nuova correzione, con la data.

- **24/11/2026, inquadratura.** Il gioco è un ritaglio **4:3** del 16:9 (1080×810), mai una fetta stretta 9:16 o 4:5 e nemmeno il 16:9 intero al centro. Va in alto; la parte bassa del 9:16 resta vuota, perché lì le app mettono titolo, descrizione e nome del canale. `StoryShort` lo fa già: non cambiare `GEOM`.
- **24/11/2026, filo logico.** Ogni spezzone deve stare nel filo della storia. In "I'm a pro" il flashback del ciclista (5 minuti prima) "non c'entra nulla, non ha filo logico in quel momento": è stato tolto.
- **24/11/2026, climax.** Il climax non si interrompe di corsa. Nello short dello squalo lo stacco subito dopo lo squalo era "troppo in fretta": il combattimento ora è un unico pezzo di 16 s, fino alla fine (squalo abbattuto, il "nice." di Michele).
- **24/11/2026, durata.** Meglio corto che allungato: 30–40 s. 45 s erano troppi per lo squalo.
- **24/11/2026, tono.** Il black humor è voluto, anche pesante, quando colpisce situazioni e personaggi del gioco (la vecchietta che si rompe l'anca, la parole violata). Restano fuori la droga e il sesso esplicito (limitano la diffusione).

## Cosa fa una storia

- **Setup → escalation → payoff.** Il payoff è un ribaltamento, un disastro o una conseguenza assurda. Una passeggiata tranquilla non è una storia.
- **La contraddizione funziona sempre.** Michele dice una cosa e il gioco lo smentisce subito: "I'm a pro, don't worry" e poi l'incidente; la lezione di guida e poi l'albero; "am I going to find a shark?" e poi gli squali.
- **Gli spezzoni possono venire da punti lontani**, anche 20 minuti prima, se reggono il filo: per esempio la richiesta di Shirley a 105 s e il furto a 1622 s.
- **Prima scelta: il gioco giocato.** I filmati Rockstar servono solo come setup di pochi secondi.
- **Il voto deve essere severo** (scala di `style/CHANNEL.md`): da 7 in su vuol dire "si pubblica".

## Gli 11 riferimenti

Li ha scelti Michele:

- YNAI7jhB5Ec
- 3MRX0q5R0SI
- 7dlo2jQXK6s
- S7qh358B9s0
- e2LhuyWCn4E
- fnb6Ab6M3w8
- VZ5TZfzGNMQ
- QWAlsRVLsQo
- mKz0MuF2SAU
- 0DKpzOKkq_s
- nSKiX-QQkn8

Sono su `youtube.com/shorts/<id>`. Per riguardarli: `yt-dlp -f "bv*[height<=1280]+ba/b"` in una cartella vuota, poi fogli con `tile` e trascrizione con Parakeet (`python/transcribe.py`).

### Tre formati

1. **Reazione divisa** (7 su 11): faccia dello streamer sopra (~40%), gioco sotto. Da noi diventa il layout `split`, con Lucianus al posto della faccia.
2. **Classifica Top 5** (2 su 11): intestazione fissa ("Ranking Funniest GTA 6 Moments"), elenco da 1 a 5 che si riempie, ogni momento da 7 a 15 s. Non è ancora fatto: è un'idea per un episodio con tanti momenti brevi.
3. **Una frase sola** (2 su 11): una frase minuscola e deadpan in alto per tutto il video ("okay... this is terrifying wtf"), gioco al centro, finale su "wasted". Da noi è il layout `panel`.

### Ritmo

- Durata da 16 a 67 s (mediana ~37 s).
- I tempi morti sono tolti tutti: c'è uno stacco ogni 3–10 s.
- Il gancio è a schermo dal fotogramma 0.
- Sul colpo arriva un flash colorato (rosso o verde), uno zoom sulla faccia o un fermo immagine.
- Chiusura con una scritta ed emoji ("NPCS HAD ENOUGH 😂", "*JUST GTA THINGS*").

### Scritte

- **Sottotitoli parola per parola**: 1–3 parole alla volta, maiuscolo, nero spesso con contorno, la parola detta in giallo. Stanno sulla giuntura tra faccia e gioco.
- **Azioni tra asterischi**, che raccontano quello che succede con ironia: `*IMMOBILISING CAR*`, `*PURE EVIL*`, `*RUNNING THEM DOWN*`, `*SHOCKED*`, `*LUCIA GIVES HIM A DOLLAR*`. Sono loro a portare il black humor.
- **Il narratore che commenta**: "Guilty by association", "Genuinely the most unlucky NPC yet 😭💔", "damn bruh i was just trynna pet that cat", "he just stole your burger".
- **Parolacce con l'asterisco nelle scritte** (`B*TCH`), l'audio resta com'è.

## Il nostro vocabolario

Scritte usate negli short approvati (esempi/), da riprendere come modello di tono:

- "*3 minutes into the episode*", "*he did not fix the car*", "*driving instructor mode*", "*it was his fault*", "LESSON 1"
- "*8 minutes later*", "*reading texts on the highway*", "Drunk. Prison. Sex. 💀", "OOPS", "lesson learned (it was not)"
- "*(prison)*", "*she chose violence*", "*guilty by association*", "*parole: violated*", "her parole officer is typing…"
- "*getaway speed: 4 mph*", "SHE CAN RUN??", "*now she can't* 💀", "mental health: protected 😇"
- "*the ocean heard him*", "*best man of the year*", "HE ASKED FOR THIS", "*cardio workout: unlocked*", "*shark: handled*", "5 stars on Tripadvisor ⭐"

Schemi che tornano:

- la frase del personaggio tra virgolette, seguita da una scritta che la smentisce;
- il conteggio del tempo ("3 minutes into", "8 minutes later") per sottolineare quanto in fretta va tutto a rotoli;
- il gergo da recensione o da burocrazia per un disastro ("parole: violated", "5 stars on Tripadvisor").

## Gancio e testi

- **Gancio** (split, primi 2–2,6 s) o **intestazione** (panel, sempre a schermo): una situazione concreta che apre una domanda e non rivela il finale. Esempi: "she asked me to steal her friend's mobility scooter", "he explained [throttle control] to his girlfriend", "she got out of prison [this morning]".
- **Titoli, descrizioni e hashtag**: regole per piattaforma in `style/CHANNEL.md`, esempi in `out/*/storie/* - testi.txt`.
