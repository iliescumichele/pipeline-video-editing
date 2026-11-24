"""Trova i tratti con un volto grande (webcam a tutto schermo, primi piani da cutscene).

Uso: ffmpeg ... -vf fps=1,scale=320:180,format=gray -f rawvideo - | faces.py <out.json> --w 320 --h 180 [--min-face 0.35]

Legge fotogrammi grigi grezzi da stdin, uno al secondo. Per ognuno misura l'altezza del volto più
grande (rilevatore Haar incluso in OpenCV) in frazione dell'altezza del fotogramma. La facecam
rotonda in un angolo resta intorno a 0,2; una webcam a tutto schermo supera --min-face (0,35).
"""

import argparse
import json
import sys

import cv2
import numpy as np


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("out")
    p.add_argument("--w", type=int, required=True)
    p.add_argument("--h", type=int, required=True)
    p.add_argument("--min-face", type=float, default=0.35)
    a = p.parse_args()

    det = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    size = a.w * a.h
    heights = []
    while True:
        buf = sys.stdin.buffer.read(size)
        if len(buf) < size:
            break
        img = np.frombuffer(buf, np.uint8).reshape(a.h, a.w)
        faces = det.detectMultiScale(cv2.equalizeHist(img), scaleFactor=1.1, minNeighbors=6, minSize=(int(a.h * 0.12),) * 2)
        heights.append(round(float(max((f[3] for f in faces), default=0)) / a.h, 3))

    # Tratti di almeno 2 s con volto grande, uniti se distano meno di 3 s.
    big = [h >= a.min_face for h in heights]
    segs, start = [], None
    for i, b in enumerate(big + [False]):
        if b and start is None:
            start = i
        elif not b and start is not None:
            if segs and start - segs[-1][1] < 3:
                segs[-1][1] = i
            else:
                segs.append([start, i])
            start = None
    segs = [s for s in segs if s[1] - s[0] >= 2]
    with open(a.out, "w") as f:
        json.dump({"hop": 1, "face_height": heights, "segments": [{"s": s, "e": e} for s, e in segs]}, f)
    total = sum(e - s for s, e in segs)
    print(f"faces: {len(heights)} s analizzati, {len(segs)} tratti con volto grande ({total} s)", file=sys.stderr)


if __name__ == "__main__":
    main()
