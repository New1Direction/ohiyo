#!/usr/bin/env python3
"""Draws the landscape on ohiyo.gg and writes it into site/index.html.

The page is a day in a valley: dawn at the top, a starry night behind the privacy section,
sunrise behind the mission. Everything is plain SVG generated from fixed seeds, so the same
hills come out every time. Run it after changing a scene:

    python3 scripts/site-scenery.py           # rewrite the scenes
    python3 scripts/site-scenery.py --check   # exit 1 if the page is out of step with this file

It replaces whatever sits between `<!-- scenery:NAME -->` and `<!-- /scenery:NAME -->`.
"""
import math
import random
import re
import sys
from pathlib import Path

PAGE = Path(__file__).resolve().parent.parent / "site" / "index.html"
W = 1600


def smooth(points):
    """A soft curve through the points (quadratics through the midpoints)."""
    d = [f"M{points[0][0]},{points[0][1]}"]
    for (x1, y1), (x2, y2) in zip(points[1:-1], points[2:]):
        d.append(f"Q{x1},{y1} {(x1 + x2) // 2},{(y1 + y2) // 2}")
    d.append(f"L{points[-1][0]},{points[-1][1]}")
    return "".join(d)


def hill(seed, base, amp, step=64):
    rnd = random.Random(seed)
    waves = [(amp * rnd.uniform(0.5, 1.0) / (k + 1), rnd.uniform(1.2, 2.6) * (k + 1), rnd.uniform(0, 6.28)) for k in range(3)]
    return [(x, round(base + sum(a * math.sin(f * x / W * 6.28 + p) for a, f, p in waves))) for x in range(-step, W + step + 1, step)]


def peaks(seed, base, amp):
    """An angular mountain range: straight slopes between random summits and saddles."""
    rnd = random.Random(seed)
    pts, x, up = [], -40, True
    while x < W + 80:
        pts.append((x, round(base - amp * (rnd.uniform(0.55, 1.0) if up else rnd.uniform(0.0, 0.3)))))
        x += rnd.randint(54, 128)
        up = not up
    return pts


def area(points, floor, curved=True):
    line = smooth(points) if curved else "M" + "L".join(f"{x},{y}" for x, y in points)
    return f"{line}V{floor}H{points[0][0]}Z"


def height_at(points, x):
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        if x1 <= x <= x2:
            return y1 + (y2 - y1) * (x - x1) / (x2 - x1)
    return points[-1][1]


def pines(seed, ridge, count, size):
    """Little pines standing on a ridge, as one path."""
    rnd = random.Random(seed)
    d = []
    for _ in range(count):
        x = rnd.randint(20, W - 20)
        h = round(size * rnd.uniform(0.7, 1.25))
        w = round(h * 0.42)
        y = round(height_at(ridge, x)) + 3
        # two stacked tiers and a tip
        d.append(f"M{x},{y - h}l{w // 2},{h * 2 // 5}h-{w // 5}l{w // 2},{h * 3 // 5}h-{w + w * 3 // 5}l{w // 2},-{h * 3 // 5}h-{w // 5}z")
    return "".join(d)


def stars(seed, count):
    """Stars placed in percentages, so they spread over any size of sky and stay small.
    None land behind the text column: a star next to a word reads as a full stop."""
    rnd = random.Random(seed)
    groups = ["", "", ""]
    for i in range(count):
        x, y, r = rnd.uniform(1, 99), rnd.uniform(2, 80), rnd.choice([0.9, 1.1, 1.3, 1.6, 2.1])
        if 3 < x < 55 and 4 < y < 80:
            continue
        groups[i % 3] += f'<circle cx="{x:.1f}%" cy="{y:.1f}%" r="{r}"/>'
    return "".join(f'<g class="stars stars--{i + 1}">{g}</g>' for i, g in enumerate(groups))


CLOUD = "M28 74a24 24 0 0 1 6-47 34 34 0 0 1 63-9 27 27 0 0 1 49 11 23 23 0 0 1 6 45z"
BIRD = "q7-9 14 0q7-9 14 0"


def dawn():
    far_a, far_b = peaks(11, 250, 150), peaks(23, 300, 110)
    mid, near, front = hill(5, 372, 34), hill(8, 422, 28), hill(13, 468, 20)
    clouds = "".join(f'<svg class="cloud cloud--{i}" viewBox="0 0 180 80"><path d="{CLOUD}"/></svg>' for i in (1, 2, 3))
    birds = f'<svg class="birds" viewBox="0 0 120 44"><path d="M4 30{BIRD}M46 12{BIRD}M82 34{BIRD}"/></svg>'
    land = f'''<svg class="scene__land" viewBox="0 0 {W} 520" preserveAspectRatio="xMidYMax slice">
<defs><radialGradient id="glow"><stop offset="0" stop-color="#fff3cf" stop-opacity=".95"/><stop offset=".35" stop-color="#ffd896" stop-opacity=".55"/><stop offset="1" stop-color="#ffd896" stop-opacity="0"/></radialGradient>
<linearGradient id="mist" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<g class="scene__far"><circle class="sun-glow" cx="1200" cy="232" r="250" fill="url(#glow)"/><circle cx="1200" cy="232" r="56" fill="#ffe2a8"/>
<path fill="#d7e6ee" d="{area(far_a, 520, curved=False)}"/><path fill="#c1d8df" d="{area(far_b, 520, curved=False)}"/></g>
<rect class="mist" x="-200" y="296" width="2000" height="96" fill="url(#mist)"/>
<g class="scene__mid"><path fill="#abd0bd" d="{area(mid, 520)}"/><path fill="#7fb39b" d="{pines(31, mid, 16, 26)}"/></g>
<path fill="#bcdcb8" d="{area(near, 520)}"/><path fill="#5e9c7c" d="{pines(47, near, 13, 36)}"/>
<path fill="#d2e8cb" d="{area(front, 520)}"/><path fill="#4a8a69" d="{pines(59, front, 8, 46)}"/>
</svg>'''
    return f'<div class="scene scene--dawn" aria-hidden="true">{clouds}{birds}{land}</div>'


def night():
    back, front = peaks(71, 150, 96), hill(77, 150, 22)
    sky = f'''<svg class="scene__sky" width="100%" height="100%">{stars(3, 170)}</svg>
<svg class="moon" viewBox="0 0 120 120"><circle cx="60" cy="60" r="60" fill="#fdf3cf" opacity=".07"/><path fill="#fdf3cf" d="M70 22a40 40 0 1 0 28 62a33 33 0 1 1 -28 -62z"/></svg>'''
    land = f'''<svg class="scene__land" viewBox="0 0 {W} 200" preserveAspectRatio="xMidYMax slice">
<path fill="#13283a" d="{area(back, 200, curved=False)}"/><path fill="#0b1826" d="{area(front, 200)}"/><path fill="#0b1826" d="{pines(83, front, 18, 34)}"/></svg>'''
    flies = "".join(f'<i class="firefly firefly--{i}"></i>' for i in range(1, 6))
    return f'<div class="scene scene--night" aria-hidden="true">{sky}{land}{flies}</div>'


def sunrise():
    ridge = hill(91, 430, 30)
    return f'''<div class="scene scene--sunrise" aria-hidden="true"><svg class="scene__land" viewBox="0 0 {W} 520" preserveAspectRatio="xMaxYMax slice">
<g class="sun-rings"><circle cx="1240" cy="470" r="420" fill="#fff" opacity=".16"/><circle cx="1240" cy="470" r="310" fill="#fff" opacity=".2"/><circle cx="1240" cy="470" r="210" fill="#fff5d6" opacity=".55"/></g>
<circle cx="1240" cy="470" r="128" fill="#ffd27f"/>
<path fill="#f3c391" d="{area(ridge, 520)}"/><path fill="#d99a6c" d="{pines(97, ridge, 11, 34)}"/></svg></div>'''


def morning():
    far, near = peaks(101, 250, 120), hill(107, 330, 26)
    seat = hill(113, 400, 30)
    clouds = "".join(f'<svg class="cloud cloud--{i}" viewBox="0 0 180 80"><path d="{CLOUD}"/></svg>' for i in (1, 3))
    return f'''<div class="scene scene--morning" aria-hidden="true">{clouds}<svg class="scene__land" viewBox="0 0 {W} 480" preserveAspectRatio="xMidYMax slice">
<path fill="#d7e6ee" d="{area(far, 480, curved=False)}"/><path fill="#abd0bd" d="{area(near, 480)}"/><path fill="#7fb39b" d="{pines(119, near, 12, 28)}"/>
<path fill="#bcdcb8" d="{area(seat, 480)}"/><path fill="#5e9c7c" d="{pines(127, seat, 7, 40)}"/></svg></div>'''


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
