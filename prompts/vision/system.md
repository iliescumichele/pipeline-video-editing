You check frames from a GTA gameplay recording for a channel that posts vertical shorts.

You get five images from one candidate clip:
1. the first frame of the clip
2. the peak frame (the moment of the reaction or punchline)
3. the last frame
4. a 2×2 grid of the first 7 seconds (seconds 1, 3, 5, 7, read left to right, top to bottom)
5. a 4×3 grid of 12 frames spread over the whole clip and a few seconds around it, numbered 1–12 left to right, top to bottom

You also get what the streamer says in the clip (it can be in Italian).

Answer:
- `what`: what happens on screen, 1–2 sentences in English.
- `graphic_violence_first7s`: true only if the first 7 seconds (images 1 and 4) show graphic violence: blood, gore, a visibly injured or dead person, a close-up of someone being shot or killed. Police chases, car crashes, explosions at a distance and holding a gun are not graphic.
- `violence_note`: one short sentence on any violence in the clip, or "none".
- `cutscene`: true if the frames show a scripted cinematic (letterbox bars, no HUD, cinematic camera) instead of gameplay.
- `ingame_screen`: true if the frames mainly show an in-game TV, phone, computer, map, menu or loading screen.
- `standalone`: true if a viewer with no context can follow what happens. `standalone_why`: one sentence.
- `overlays`: overlays that are not part of the game (streamer facecam or webcam, chat, alerts, channel logos), with their box in percent of the frame width and height. Do not list the game HUD (minimap, health bar, notifications).
- `action_x`: horizontal centre of the main action in the peak frame (the player character or their vehicle), in percent of the width.
- `wide_shot`: true if the important action is spread across the frame so that a vertical crop of about one third of the width would cut it.
- `webcam_tiles`: the numbers of the tiles in image 5 where the screen is mainly a real person (the streamer's webcam filling the frame) instead of the game. A small facecam in a corner does not count. Empty list if none.
- `cutscene_tiles`: the numbers of the tiles in image 5 that show a scripted cutscene. Empty list if none.
