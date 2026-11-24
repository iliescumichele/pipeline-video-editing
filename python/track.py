"""Segue l'azione di gioco per il ritaglio verticale.

Uso: track.py <clip.mp4> <out.json> --crop-w 0.316 [--mask x0,y0,x1,y1 ...] [--hint 0.5] [--fps 10]

--crop-w   larghezza della finestra 9:16 in frazione della larghezza del video
--mask     zone da ignorare (facecam, overlay), in frazioni 0–1 del fotogramma
--hint     centro dell'azione stimato dalla vision, usato come preferenza iniziale

Per ogni campione misura il movimento proprio della scena: flusso ottico meno il movimento della
telecamera, stimato con un'omografia (copre anche avvicinamenti e rotazioni). In terza persona il
personaggio si muove con la telecamera, quindi risalta proprio lì. Il baricentro orizzontale di quel
movimento si mescola con una preferenza per il centro. Il centro del ritaglio
segue quel punto come una molla smorzata, con zona morta e velocità massima: niente scatti.
Scrive i centri a --fps, i limiti consentiti e la quota di movimento che resta fuori dal ritaglio.
"""

import argparse
import json
import sys

import cv2
import numpy as np

PROC_W = 320


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("clip")
    p.add_argument("out")
    p.add_argument("--crop-w", type=float, required=True)
    p.add_argument("--mask", action="append", default=[])
    p.add_argument("--hint", type=float, default=0.5)
    p.add_argument("--fps", type=float, default=10.0)
    p.add_argument("--max-speed", type=float, default=0.12, help="frazioni di larghezza al secondo")
    p.add_argument("--dead-zone", type=float, default=0.035)
    p.add_argument("--hud-bottom", type=float, default=0.22, help="fascia bassa da ignorare (minimappa, testi)")
    a = p.parse_args()

    cap = cv2.VideoCapture(a.clip)
    if not cap.isOpened():
        sys.exit(f"impossibile aprire {a.clip}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(src_fps / a.fps))

    masks = [tuple(float(v) for v in m.split(",")) for m in a.mask]
    hud = [(0.0, 1.0 - a.hud_bottom, 1.0, 1.0)] if a.hud_bottom > 0 else []
    half = a.crop_w / 2
    # Il ritaglio non deve entrare negli overlay alti (facecam): si limita l'escursione del centro.
    lo, hi = half, 1 - half
    for x0, y0, x1, y1 in masks:
        if y1 - y0 < 0.2:
            continue
        if x0 > 0.5:
            hi = min(hi, x0 - half)
        elif x1 < 0.5:
            lo = max(lo, x1 + half)
    if lo > hi:
        lo = hi = 0.5

    prev = None
    mask_img = None
    samples = []  # (energia, baricentro, istogramma colonne)
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step:
            i += 1
            continue
        i += 1
        h = round(frame.shape[0] * PROC_W / frame.shape[1])
        gray = cv2.cvtColor(cv2.resize(frame, (PROC_W, h), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        if mask_img is None:
            mask_img = np.ones((h, PROC_W), np.float32)
            for x0, y0, x1, y1 in masks + hud:
                mask_img[int(y0 * h) : int(np.ceil(y1 * h)), int(x0 * PROC_W) : int(np.ceil(x1 * PROC_W))] = 0
            gy, gx = np.mgrid[4:h:8, 4:PROC_W:8]
            grid = np.stack([gx.ravel(), gy.ravel()], 1).astype(np.float32)
            grid_ok = mask_img[gy.ravel(), gx.ravel()] > 0
            ay, ax = np.mgrid[0:h, 0:PROC_W]
            allpts = np.stack([ax.ravel(), ay.ravel()], 1).astype(np.float32).reshape(-1, 1, 2)
        if prev is None:
            prev = gray
            samples.append((0.0, 0.5, np.zeros(PROC_W)))
            continue
        flow = cv2.calcOpticalFlowFarneback(prev, gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        prev = gray
        src = grid[grid_ok]
        dst = src + flow[src[:, 1].astype(int), src[:, 0].astype(int)]
        H, _ = cv2.findHomography(src, dst, cv2.RANSAC, 1.0) if len(src) >= 8 else (None, None)
        if H is not None:
            camera = cv2.perspectiveTransform(allpts, H).reshape(h, PROC_W, 2) - allpts.reshape(h, PROC_W, 2)
        else:
            camera = np.median(flow[mask_img > 0], axis=0)
        mag = np.linalg.norm(flow - camera, axis=2) * mask_img
        mag[mag < 0.5] = 0
        col = mag.sum(axis=0)
        energy = float(col.sum())
        centre = float((col * np.arange(PROC_W)).sum() / energy / PROC_W) if energy > 0 else 0.5
        samples.append((energy, centre, col))
    cap.release()
    if not samples:
        sys.exit("nessun fotogramma letto")

    energies = np.array([s[0] for s in samples])
    ref = np.percentile(energies[energies > 0], 75) if (energies > 0).any() else 1.0
    targets = []
    for e, c, _ in samples:
        conf = min(1.0, e / (ref + 1e-6)) * 0.6
        prior = a.hint
        targets.append((1 - conf) * prior + conf * c)

    # Molla smorzata criticamente, con zona morta e velocità massima.
    dt = 1 / a.fps
    omega = 2 * np.pi * 0.4
    pos = float(np.clip(np.median(targets[: max(1, int(a.fps))]), lo, hi))
    vel = 0.0
    centres = []
    for tgt in targets:
        tgt = float(np.clip(tgt, lo, hi))
        if abs(tgt - pos) < a.dead_zone:
            tgt = pos
        for _ in range(4):
            h = dt / 4
            acc = omega * omega * (tgt - pos) - 2 * omega * vel
            vel = float(np.clip(vel + acc * h, -a.max_speed, a.max_speed))
            pos = float(np.clip(pos + vel * h, lo, hi))
        centres.append(round(pos, 4))

    # Quota di movimento fuori dalla finestra, campione per campione.
    outside = []
    xs = np.arange(PROC_W) / PROC_W
    for (e, _, col), c in zip(samples, centres):
        if e <= 0:
            continue
        inside = col[(xs >= c - half) & (xs <= c + half)].sum()
        outside.append(1 - inside / e)
    uniform = 1 - a.crop_w  # quota fuori se il movimento fosse spalmato uniformemente
    out = {
        "fps": a.fps,
        "crop_w": a.crop_w,
        "range": [round(lo, 4), round(hi, 4)],
        "centres": centres,
        "outside_mean": round(float(np.mean(outside)) if outside else 0.0, 3),
        "outside_p75": round(float(np.percentile(outside, 75)) if outside else 0.0, 3),
        "outside_excess": round(float(np.mean(outside) - uniform) if outside else 0.0, 3),
    }
    with open(a.out, "w") as f:
        json.dump(out, f)
    print(
        f"track: {len(samples)} campioni, centro {min(centres):.2f}–{max(centres):.2f}, "
        f"movimento fuori dal ritaglio {out['outside_mean']:.0%} (uniforme {uniform:.0%}, eccesso {out['outside_excess']:+.0%})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
