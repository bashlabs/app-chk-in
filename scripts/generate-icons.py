#!/usr/bin/env python3
"""
Generates the app's logo asset and PWA icon set from the church crest.

  python3 scripts/generate-icons.py

Input:  assets/crest.png  (the crest on a transparent background)
Output: public/logo-crest.png       trimmed crest, transparent — the header mark
        public/favicon.png           crest on white, 64px
        public/apple-touch-icon.png  crest on white, 180px
        public/icons/icon-192.png    crest on white, 192px
        public/icons/icon-512.png    crest on white, 512px
        public/icons/maskable-512.png crest on white, inside the safe zone

Icons are flattened onto white because iOS/Android render transparency as
black; the in-page mark keeps its transparency since it sits on the card.
"""
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "crest.png")
PUBLIC = os.path.join(ROOT, "public")
ICONS = os.path.join(PUBLIC, "icons")
WHITE = (255, 255, 255)

os.makedirs(ICONS, exist_ok=True)

img = Image.open(SRC).convert("RGBA")
arr = np.asarray(img)
alpha = arr[:, :, 3]

# Content = visible pixels. Prefer the alpha channel; fall back to non-white if
# the source turns out to be opaque.
content = alpha > 8
if content.sum() < 10:
    content = (arr[:, :, :3] < 245).any(axis=2)

ys, xs = np.where(content)
crest = img.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
print(f"trimmed crest to {crest.width}x{crest.height}")


def square(im, target, bg, fill=1.0):
    """Center `im` on a square canvas (transparent if bg is None, else `bg`),
    sized so its longest side is `fill` × the canvas, then resize to `target`."""
    side = max(im.width, im.height)
    box = round(side / fill)
    canvas = Image.new("RGBA", (box, box), (0, 0, 0, 0) if bg is None else bg + (255,))
    canvas.paste(im, ((box - im.width) // 2, (box - im.height) // 2), im)
    out = canvas.resize((target, target), Image.LANCZOS)
    return out if bg is None else out.convert("RGB")


# In-page mark: transparent, near-full-bleed.
square(crest, 256, None, fill=0.98).save(os.path.join(PUBLIC, "logo-crest.png"))

# Icons: opaque white background.
targets = [
    (os.path.join(PUBLIC, "favicon.png"), 64, 0.9),
    (os.path.join(PUBLIC, "apple-touch-icon.png"), 180, 0.84),
    (os.path.join(ICONS, "icon-192.png"), 192, 0.86),
    (os.path.join(ICONS, "icon-512.png"), 512, 0.86),
    (os.path.join(ICONS, "maskable-512.png"), 512, 0.62),  # inside 80% safe zone
]
for path, size, fill in targets:
    square(crest, size, WHITE, fill=fill).save(path)
    print(f"wrote {os.path.relpath(path, ROOT)} ({size}x{size})")
