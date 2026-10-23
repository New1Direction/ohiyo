---
name: building-visual-explainers
description: Builds Archify-based diagrams and visual explainers for Ohiyo. Use for interactive learning maps, workflows, system explanations and explorable plans, or when Archify is requested.
---

# Build a visual explainer

Read [the project integration rules](../README.md) first, including source setup.
The pinned package root is [Archify](../../skill-sources/archify/archify/).
Read its [skill](../../skill-sources/archify/archify/SKILL.md) and only the
schemas, authoring references and examples relevant to the requested diagram.
Resolve upstream-relative paths from that package root.

Choose the question the reader needs answered before choosing a diagram type.
Use real supplied relationships and clearly label illustrative data. Put detail
behind a meaningful selection; do not replace the answer with an unreadable map.
For explanatory motion, each step must correspond to a real authored event.

Keep source and output outside the pinned package. Use its absolute
`bin/archify.mjs` path when running from the working directory. Prefix commands
with `ARCHIFY_UPDATE_CHECK_DISABLED=1`. Inspect the invoked tooling first; use
its validation/delivery receipts without treating them as visual verification.
Inspect the actual rendered result, including selection and narrow layouts.

Standalone HTML is not an accepted Burrow page definition. Use a reviewed
component or an explicitly designed isolated rendering boundary for integration.
Do not enable arbitrary HTML execution, external services, automatic updates or
publication. Follow the host's artifact/preview workflow when sharing a page.
