#!/usr/bin/env python3
"""Writes the scenery on ohiyo.gg into site/index.html.

The page is a day in a valley: dawn at the top, a starry night behind the privacy section,
sunrise behind the mission, morning at the end. Each scene is a gouache painting from
site/assets/scenery with small living things on top: birds that flap, butterflies, drifting
seeds, a rabbit that peeks over the hill, a shooting star, fireflies, turning sun rays, and Kikka
breathing on her hill. Run this after changing a scene:

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


# A rabbit that peeks up from behind the hill at the bottom of the first scene.
RABBIT = (
    '<svg class="rabbit" viewBox="0 0 48 60">'
    '<g class="rabbit__ear"><path fill="#b99b7c" d="M17 30C10 18 11 4 16 3s8 12 7 26z"/><path fill="#f1cdb9" d="M17 26c-3-8-3-16-1-18s4 8 4 17z"/></g>'
    '<path fill="#b99b7c" d="M31 30c7-12 6-26 1-27s-8 12-7 26z"/><path fill="#f1cdb9" d="M31 26c3-8 3-16 1-18s-4 8-4 17z"/>'
    '<path fill="#b99b7c" d="M8 60V44c0-11 7-18 16-18s16 7 16 18v16z"/>'
    '<circle cx="18" cy="42" r="2.2" fill="#2a221c"/><circle cx="30" cy="42" r="2.2" fill="#2a221c"/>'
    '<path d="M22 48q2 2 4 0" fill="none" stroke="#2a221c" stroke-width="1.6" stroke-linecap="round"/></svg>'
)


def painting(name, first=False):
    """The painting itself. Only the first one loads eagerly; the rest wait until they are near."""
    loading = 'fetchpriority="high"' if first else 'loading="lazy"'
    return (
        f'<img class="scene__paint" src="assets/scenery/{name}-1672.webp" '
        f'srcset="assets/scenery/{name}-900.webp 900w, assets/scenery/{name}-1672.webp 1672w" '
        f'sizes="max(100vw, 40rem)" width="1672" height="941" alt="" {loading} />'
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


def dawn():
    stage = painting("dawn", first=True) + '<i class="scene__glow"></i><i class="scene__mist"></i>' + seeds(7) + butterflies(1, 2, 3)
    return scene("dawn", stage, flock("far", 5) + flock("near", 3) + RABBIT)


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
    for name, draw in (("dawn", dawn), ("night", night), ("sunrise", sunrise), ("morning", morning)):
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
