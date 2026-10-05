#!/usr/bin/env python3
"""Writes the scenery on ohiyo.gg into site/index.html.

The page is a day in a valley: a meadow in morning light at the top (the stone Ohiyo mark, with
Kikka beside it), a starry night behind the privacy section, sunrise behind the mission, morning
at the end. Each scene is a painting from site/assets/scenery with small living things on top:
birds that flap, butterflies, drifting leaves and seeds, a shooting star, fireflies, turning sun
rays, and Kikka breathing on her hill. Run this after changing a scene:

    python3 scripts/site-scenery.py           # rewrite the scenes
    python3 scripts/site-scenery.py --check   # exit 1 if the page is out of step with this file

It replaces whatever sits between `<!-- scenery:NAME -->` and `<!-- /scenery:NAME -->`.
"""
import random
import re
import sys
from pathlib import Path

PAGE = Path(__file__).resolve().parent.parent / "site" / "index.html"


def flock(kind, count):
    """Birds whose two wings are separate strokes, so CSS can flap them around the body."""
    bird = '<svg class="bird bird--{i}" viewBox="-16 -12 32 24"><path class="wing wing--l" d="M0 0Q-6-8-14-2"/><path class="wing wing--r" d="M0 0Q6-8 14-2"/></svg>'
    return f'<div class="flock flock--{kind}">' + "".join(bird.format(i=i) for i in range(1, count + 1)) + "</div>"


def butterflies(*numbers):
    wing = '<svg class="butterfly butterfly--{i}" viewBox="-10 -8 20 16"><path class="bw bw--l" d="M0 0C-3-8-10-7-9-1C-10 4-4 6 0 0Z"/><path class="bw bw--r" d="M0 0C3-8 10-7 9-1C10 4 4 6 0 0Z"/></svg>'
    return "".join(wing.format(i=i) for i in numbers)


def seeds(count):
    return "".join(f'<i class="seed seed--{i}"></i>' for i in range(1, count + 1))


def leaves(count):
    """Leaves on the wind, like the ones painted into the meadow."""
    return "".join(f'<i class="leaf leaf--{i}"></i>' for i in range(1, count + 1))


# Pixel size of each painting. Most are 1672 wide; the meadow is the size it was painted at.
SIZES = {"meadow": (1738, 905)}


def painting(name, first=False):
    """The painting itself. Only the first one loads eagerly; the rest wait until they are near."""
    loading = 'fetchpriority="high"' if first else 'loading="lazy"'
    width, height = SIZES.get(name, (1672, 941))
    return (
        f'<img class="scene__paint" src="assets/scenery/{name}-{width}.webp" '
        f'srcset="assets/scenery/{name}-900.webp 900w, assets/scenery/{name}-{width}.webp {width}w" '
        f'sizes="max(100vw, 40rem)" width="{width}" height="{height}" alt="" {loading} />'
    )


def stars(seed, count):
    """Twinkling stars, placed in percentages. They stay on the right and along the top, like the
    painted ones: a star next to a word reads as a full stop."""
    rnd = random.Random(seed)
    groups = ["", "", ""]
    placed = 0
    while placed < count:
        x, y, r = rnd.uniform(1, 99), rnd.uniform(1, 62), rnd.choice([0.9, 1.1, 1.3, 1.6])
        if x < 57 and y > 4:
            continue
        groups[placed % 3] += f'<circle cx="{x:.1f}%" cy="{y:.1f}%" r="{r}"/>'
        placed += 1
    return "".join(f'<g class="stars stars--{i + 1}">{g}</g>' for i, g in enumerate(groups))


def scene(name, stage, extra=""):
    return f'<div class="scene scene--{name}" aria-hidden="true"><div class="scene__stage">{stage}</div>{extra}</div>'


def meadow():
    """The first screen. Everything sits on the stage, so it stays in place on the painting."""
    stage = painting("meadow", first=True) + '<i class="scene__glow"></i>' + flock("far", 5) + seeds(7) + butterflies(1, 2, 3) + leaves(6)
    return scene("meadow", stage)


def night():
    sky = f'<svg class="scene__sky" width="100%" height="100%">{stars(3, 44)}</svg>'
    flies = "".join(f'<i class="firefly firefly--{i}"></i>' for i in range(1, 10))
    return scene("night", painting("night") + '<i class="scene__glow"></i>', sky + '<i class="shooting-star"></i>' + flies)


def sunrise():
    rays = '<div class="scene__rays"><i class="rays"></i></div>'
    return scene("sunrise", painting("sunrise") + rays + '<i class="scene__glow"></i>', flock("sun", 4))


def morning():
    kikka = '<img class="scene__kikka" src="assets/kikka-color.svg" width="746" height="700" alt="" loading="lazy" />'
    return scene("morning", painting("morning") + kikka + butterflies(4, 5), flock("far", 4))


def main():
    html = PAGE.read_text()
    for name, draw in (("meadow", meadow), ("night", night), ("sunrise", sunrise), ("morning", morning)):
        pattern = re.compile(rf"(<!-- scenery:{name} -->).*?(<!-- /scenery:{name} -->)", re.S)
        if not pattern.search(html):
            raise SystemExit(f"index.html has no <!-- scenery:{name} --> marker")
        html = pattern.sub(lambda m, art=draw(): f"{m.group(1)}\n{art}\n{m.group(2)}", html)
    if "--check" in sys.argv:
        if html != PAGE.read_text():
            raise SystemExit("site/index.html scenery is out of step: run python3 scripts/site-scenery.py")
        print("scenery is in step")
        return
    PAGE.write_text(html)
    print(f"scenery written: {len(html)} bytes of HTML")


if __name__ == "__main__":
    main()
