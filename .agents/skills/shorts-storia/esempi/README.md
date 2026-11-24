# Short approvati (24/11/2026)

Sono le schede vere degli short che Michele ha approvato ("così molto meglio") dopo il passaggio al 4:3.
I video finiti e i testi per le piattaforme stanno in `out/<id>/storie/`.
Le storie candidate non ancora montate stanno in `out/<id>/storie/storie-candidate.md`.

| Scheda | Episodio | Layout | Durata | Storia | Come è costruita |
|---|---|---|---|---|---|
| `v20-scooter.json` | 20/11 `2026-11-20-02-51-12-ee1051ef` | split | 40 s | Shirley: "da quando ha lo scooter si è arresa alla vita, rubalo". Jason lo ruba, Peggy grida "ableist", lo insegue di corsa, si rompe l'anca. "It's for her own good." | Setup a 105–116 s, furto a 1622 s (25 minuti dopo). Battute dei personaggi come `tag` bianche. Inseguimento con `cx: 0.375`. Primi due spezzoni con `crop` (Lucianus nel 4K) |
| `v20-shark.json` | 20/11 | split | 40 s | "They're going to die" / "am I going to find a shark?". Dobbs afferrato, il testimone: "gonna go viral", poi lo squalo vero. "No harm, no foul." | Contraddizione detta/accaduta. Climax tenuto di seguito per 16 s (correzione di Michele). `lift` sul fondale |
| `v22-throttle.json` | 22/11 `2026-11-22-18-23-35-3c6ce25b` | panel | 49 s | Incidente al minuto 3, "fix the car later", lezione di guida alla ragazza, poi marciapiede, albero, macchina. "This NPC always crashes into me." | Tre colpi con flash+zoom+shake. La smentita "*it was his fault*" dopo la scusa |
| `v22-pro.json` | 22/11 | panel | 29 s | "I'm a pro, don't worry" → *8 minutes later* → messaggi di Cal ("Drunk prison sex") → incidente → "That's why you don't use your phone while driving". | Il flashback del ciclista è stato tolto: era fuori dal filo (correzione di Michele). Telefono con `cx` 0,62–0,64 e zoom sulle risposte |
| `v22-prison.json` | 22/11 | panel | 46 s | Lucia è uscita stamattina: "a nine month government job", "hit yourself, b*tch!", rissa, polizia. "You've been out like ten minutes?" | Dialogo dei filmati riscritto come `tag` bianche, con i tempi letti dai sottotitoli. Rissa notturna con `lift`. Circa 13 s di filmato Rockstar: è il massimo accettabile |

I percorsi `source`, `faceSource` e `transcript` dentro le schede sono assoluti e puntano a quei due episodi.
Per un episodio nuovo, copia la scheda più simile e cambia percorsi, spezzoni e scritte.
