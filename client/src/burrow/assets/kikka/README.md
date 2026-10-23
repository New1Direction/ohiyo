# Kikka animation assets

Derived from the supplied `Kikka-PNGs.zip` (Kikka animation pack 1.0.0).
Each WebP contains the six original 512×512 RGBA frames, encoded losslessly
with the durations and loop setting from the pack's `manifest.json`.
Only states used by Burrow are included. The original neutral PNG is stored at
`brand/kikka-chinchilla-clean.png` and is also the reduced-motion fallback.

To regenerate a state after extracting the source archive, use ImageMagick:
pass `-delay <duration_ms / 10>` before each frame in manifest order, then
`-loop 0 -define webp:lossless=true <state>.webp` for looping states, or
`-loop 1` for the one-shot `error` and `confused` states.
