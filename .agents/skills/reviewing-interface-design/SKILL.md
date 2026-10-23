---
name: reviewing-interface-design
description: Applies Impeccable's playbooks to Ohiyo hierarchy, consistency, accessibility and UI quality. Use for design audits, critique, layout, typography and final polish, or when Impeccable is requested.
---

# Review the whole user path

Read [the project integration rules](../README.md) first, including source setup.
This integration uses Impeccable in **guidance-only mode**. Do not run its
launcher, installer, hooks, design-direction API, telemetry or live-mode server.
Do not treat engine commands in a reference as available checks.

Read the relevant pinned playbook:

- [Critique](../../skill-sources/impeccable/.agents/skills/impeccable/reference/critique.md)
- [Technical audit](../../skill-sources/impeccable/.agents/skills/impeccable/reference/audit.md)
- [Polish](../../skill-sources/impeccable/.agents/skills/impeccable/reference/polish.md)
- [Edge cases](../../skill-sources/impeccable/.agents/skills/impeccable/reference/harden.md)
- [Layout](../../skill-sources/impeccable/.agents/skills/impeccable/reference/layout.md)
- [Typography](../../skill-sources/impeccable/.agents/skills/impeccable/reference/typeset.md)

Use the existing source, tokens and rendered UI as design evidence. Missing
PRODUCT.md or DESIGN.md does not authorize a redesign or require new documents.
The user's rounded styling and chosen palettes override generic anti-pattern
rules. Critique must name a concrete usability problem, not just a disliked style.

For a requested audit, report findings without changing code. For requested
polish, prioritize broken tasks and inaccessible controls, then missing states,
hierarchy and responsive issues, then visual inconsistencies. Keep edits scoped
to the component that owns the problem. Do not change factual copy or invent
product claims as decoration.

Use existing tests and browser tools instead of unavailable Impeccable engine
commands. Inspect the complete task flow with representative content and widths.
Separate observed failures from aesthetic judgments. Report guidance-only use
honestly; never claim Impeccable's deterministic detector ran when it did not.
