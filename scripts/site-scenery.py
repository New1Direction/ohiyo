#!/usr/bin/env python3
"""Writes the scenery on ohiyo.gg into site/index.html.

The page is a day in a valley: dawn at the top, a starry night behind the privacy section,
sunrise behind the mission, morning at the end. Each scene is a gouache painting from
site/assets/scenery with a few small moving things on top (a glow on the sun, mist, birds,
twinkling stars, fireflies, and Kikka on her hill). Run this after changing a scene:

    python3 scripts/site-scenery.py           # rewrite the scenes
    python3 scripts/site-scenery.py --check   # exit 1 if the page is out of step with this file

It replaces whatever sits between `<!-- scenery:NAME -->` and `<!-- /scenery:NAME -->`.
"""
import random
import re
import sys
from pathlib import Path

PAGE = Path(__file__).resolve().parent.parent / "site" / "index.html"
BIRD = "q7-9 14 0q7-9 14 0"
BIRDS = f'<svg class="birds" viewBox="0 0 120 44"><path d="M4 30{BIRD}M46 12{BIRD}M82 34{BIRD}"/></svg>'


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
    return scene("dawn", painting("dawn", first=True) + '<i class="scene__glow"></i><i class="scene__mist"></i>', BIRDS)


def night():
    sky = f'<svg class="scene__sky" width="100%" height="100%">{stars(3, 44)}</svg>'
    flies = "".join(f'<i class="firefly firefly--{i}"></i>' for i in range(1, 6))
    return scene("night", painting("night"), sky + flies)


def sunrise():
    return scene("sunrise", painting("sunrise") + '<i class="scene__glow"></i>')


def morning():
    kikka = '<img class="scene__kikka" src="assets/kikka-color.svg" width="746" height="700" alt="" loading="lazy" />'
    return scene("morning", painting("morning") + kikka, BIRDS)


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
