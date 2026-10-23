#!/usr/bin/env python3
"""
Re-pad the Android launcher icons so the artwork sits inside the launcher's
visible area instead of filling the canvas.

WHY: the adaptive icon (Android 8+) is a 108dp canvas, but only the central
~66dp is guaranteed visible — every launcher masks the outer ring (circle,
squircle, rounded square). The shipped foreground filled 85% of the canvas, so
the RX Store logo looked oversized and its edges were clipped by the mask.

  adaptive foreground : content = 52% of the canvas, centred
  legacy ic_launcher  : content = 72%
  ic_launcher_round   : content = 62% (it is masked to a CIRCLE, so the corner
                        distance must stay inside the circle)

The target is ABSOLUTE, not relative: the artwork is cropped to its bounding
box and scaled to exactly that share of the canvas, so re-running the script is
safe and converges on the same size.
Run: python3 scripts/fix-android-icons.py
"""
from PIL import Image
import glob
import sys

RES = "android/app/src/main/res"

# (glob, max share of the canvas the artwork may occupy)
TARGETS = [
    (f"{RES}/mipmap-*/ic_launcher_foreground.png", 0.52),
    (f"{RES}/mipmap-*/ic_launcher_round.png", 0.62),
    (f"{RES}/mipmap-*/ic_launcher.png", 0.72),
]


def repad(path: str, target: float) -> str:
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    box = im.getchannel("A").getbbox()
    if not box:
        return f"{path}: fully transparent — skipped"
    art = im.crop(box)
    aw, ah = art.size
    # Fit the artwork's larger side into `target` of the canvas.
    scale = (target * w) / max(aw, ah)
    nw, nh = max(1, round(aw * scale)), max(1, round(ah * scale))
    art = art.resize((nw, nh), Image.LANCZOS)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(art, ((w - nw) // 2, (h - nh) // 2), art)
    out.save(path)
    bw, bh = out.getchannel("A").getbbox()[2] - out.getchannel("A").getbbox()[0], out.getchannel("A").getbbox()[3] - out.getchannel("A").getbbox()[1]
    return f"{path.replace(RES + '/', '')}: {w}x{h} artwork {bw}x{bh} = {bw / w * 100:.0f}% x {bh / h * 100:.0f}%"


def main() -> int:
    changed = 0
    for pattern, target in TARGETS:
        for path in sorted(glob.glob(pattern)):
            print(repad(path, target))
            changed += 1
    print(f"\n{changed} icon file(s) re-padded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
