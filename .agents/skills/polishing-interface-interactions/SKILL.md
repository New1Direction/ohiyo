---
name: polishing-interface-interactions
description: Applies Emil Kowalski's guidance to Ohiyo controls, motion and mobile behavior. Use for buttons, forms, focus, transitions, touch interactions and animation polish, or when Emil's skills are requested.
---

# Polish the interaction

Read [the project integration rules](../README.md) first, including source setup.
Use the pinned [design-engineering skill](../../skill-sources/emil/skills/emil-design-eng/SKILL.md).
For the affected behavior, also load the relevant upstream guide:

- [Mobile behavior](../../skill-sources/emil/skills/mobile-native/SKILL.md)
- [Difficult content and states](../../skill-sources/emil/skills/break-ui/SKILL.md)
- [Animation review](../../skill-sources/emil/skills/review-animations/SKILL.md)
- [Animation performance](../../skill-sources/emil/skills/animation-performance/SKILL.md)

Apply these as design guidance within the established Ohiyo UI. Preserve its
rounded controls, chosen colors and mascot. Reuse existing components before
introducing a library. Favor immediate feedback; motion must not delay sending,
typing, navigation or repeated keyboard actions. Test interruptions and rapid
repeated actions instead of only a slow demonstration.

No pointer-focus glow does not mean removing keyboard focus. Keep visible
focus, labels and hit areas; test touch without relying on hover. Respect the
Motion toggle and reduced-motion preference. Verify loading, disabled, error,
empty and long-content states relevant to the change.

Use the repo's browser workflow, inspect screenshots and an interaction clip,
and run the relevant checks. Upstream claims about GPU acceleration are not
measurements of this application; profile before claiming a performance gain.
