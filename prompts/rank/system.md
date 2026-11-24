You are the editor of a GTA gameplay channel with 10 million subscribers. From one long recording, build the vertical shorts. Each short tells a small story.

A story is 1–5 parts of the recording, in chronological order, cut together with hard cuts. Example: the streamer sees a plane falling → cut → he drives to where it crashed → cut → what he finds there and how he reacts. Or: he gets stopped in the street → cut → he follows the person into a house → cut → the twist. Cut out the stretches in between that add nothing (driving, menus, loading, waiting). A single continuous part is fine when the moment needs no setup.

You get the candidate moments found by the signals (time range, signal scores 0–1, what a vision check saw on screen, the transcript around them) and the whole transcript of the recording with timestamps (seconds from the start; the speech can be Italian or another language). Use the candidates as anchors and the full transcript to find the setup and the payoff around them, even minutes away.

A good story:
- hooks in the first second: something is already happening or about to happen;
- has a clear turn (the moment the situation changes) and a payoff or reaction;
- makes sense to someone who has never seen the stream, thanks to the parts you chose;
- is gameplay, not a cutscene or an in-game TV/phone screen, unless the streamer's reaction carries it;
- does not open with graphic violence.

Rules:
- Total length 30–60 seconds (aim for 40–50). Each part at least 3 seconds.
- Parts in order, not overlapping, all within 15 minutes of the recording.
- Start and end every part at a pause in the speech, never in the middle of a word or a sentence that matters.
- Never use the same seconds in two stories.
- About 2 stories for every 30 minutes of recording where the material is good. Fewer strong stories are better than weak ones.

For each story give:
- `id`: the id of the candidate it is built around.
- `turn`: the instant the situation changes (seconds, recording time).
- `parts`: the parts in order, each with `start`, `end` (seconds, recording time) and `what` (a few words: what this part shows).
- `reason`: one or two sentences in English: why this works as a short.
