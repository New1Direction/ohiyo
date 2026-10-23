---
name: building-interactive-figures
description: Builds Anatomy-based interactive illustrations for Ohiyo. Use for explorable machines, cutaways, mechanism demos and visual learning examples, or when Anatomy is requested.
---

# Build an interactive figure

Read [the project integration rules](../README.md) first, including source setup.
The pinned upstream root is [Anatomy](../../skill-sources/anatomy/).
Read its [skill](../../skill-sources/anatomy/SKILL.md), then the closest example
and the specific kit/reference files it calls for. Resolve upstream-relative
paths from that root, not from this entry point. Keep the source checkout clean.

Use Anatomy to make the mechanism explain the idea: controls, motion, labels
and readouts must share one truthful model. Identify where an analogy stops
being accurate. Prefer a single understandable mechanism over a decorative
scene. Use the supplied geometry and verification tools where appropriate,
after inspecting the tools to be run.

For a Burrow example, implement the output as a reviewed component rather than
putting source code into a generated page definition. Check touch and keyboard
operation, light/dark palettes, paused/reduced motion and WebGL fallback where
applicable. Test a changed input against its expected consequence, not just that
the figure animates. Inspect representative renders and a recording of controls.

Do not run Anatomy publishing or session-log collection. Deliver through the
project's existing preview workflow. Preserve upstream attribution when copying
kit or example code. State which checks actually ran and which remain untested.
