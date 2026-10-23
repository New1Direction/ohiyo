# Burrow authoring skills

The five project skills below use the complete upstream repositories pinned by
Git submodule entries under `.agents/skill-sources/`. Their original directory
layouts, examples, tools, licenses and notices remain intact. The small local
`SKILL.md` entry points select the relevant guidance and define Ohiyo's limits;
they are not replacements for the upstream material.

| Project skill | Upstream | Use |
| --- | --- | --- |
| `building-interactive-figures` | [Anatomy](https://github.com/wheresryan22/anatomy) · MIT | Working, explorable illustrations |
| `building-visual-explainers` | [Archify](https://github.com/tt-a1i/archify) · MIT | Validated diagrams and explainers |
| `designing-learning-experiences` | [Learn Anything](https://github.com/ChenChenyaqi/learn-anything) · MIT | Explanations, practice and feedback |
| `polishing-interface-interactions` | [Emil's skills](https://github.com/emilkowalski/skills) · MIT | Motion, mobile controls and interaction details |
| `reviewing-interface-design` | [Impeccable](https://github.com/pbakaus/impeccable) · Apache-2.0 | Hierarchy, consistency and UI quality review |

## Load the pinned sources

If a source directory is empty in a fresh checkout, run from the repository root:

```sh
git submodule update --init --depth 1 -- \
  .agents/skill-sources/anatomy \
  .agents/skill-sources/archify \
  .agents/skill-sources/learn-anything \
  .agents/skill-sources/emil \
  .agents/skill-sources/impeccable
```

This checks out the recorded commits, not the latest upstream branches. Use
`git submodule status` to see those revisions. Do not use `--remote` for setup.
Updates are deliberate dependency changes: inspect the new revision, scripts
and license terms before moving a pin. Do not edit the upstream checkouts while
building Ohiyo; copy only needed implementation files with their license notices.

## Authoring is not runtime execution

These skills guide developers and coding agents working on Ohiyo. They are not
included in Kikka's production prompt or its four-identifier skill router. The
existing Docker/Railway allowlists exclude the source repositories and these
five entry points. No app dependencies, hooks, MCP servers or global agent
configuration are installed by this integration.

Use upstream guidance within the user's requested scope and Ohiyo's actual
capabilities. Preserve the rounded styling, selected palette, Kikka mascot,
keyboard access and reduced-motion behavior. No upstream aesthetic rule
overrides the user's choices. Follow the existing preview and screenshot
workflow; automated structural checks do not replace inspecting the result.

The current creation schema accepts trusted components, not generated HTML,
SVG, JavaScript or WebGL. A richer figure needs an explicitly implemented,
reviewed component or a separately designed isolated renderer. Do not bypass
validation, inject executable output, or advertise unavailable interactions.
Changing a skill does not change the bundled ready-made examples.

## Reviewed side effects and limits

- Anatomy includes publishing code that can inspect agent session logs and
  submit to a public community gallery. Do not run it for Ohiyo authoring.
- Archify can check upstream releases during delivery. Run its commands with
  `ARCHIFY_UPDATE_CHECK_DISABLED=1`; no update or publishing is implied.
- Learn Anything's installer writes other agents' configuration and its full
  workflow creates learner records. Use its teaching guidance here, not its
  installer, dashboard or persistence workflow. Do not claim spaced repetition
  or mastery tracking until those features exist in Burrow.
- Emil's material is design guidance. Do not install its suggested libraries
  without checking Ohiyo's existing components first.
- Impeccable's launcher can download/execute an engine; its full workflow has
  hooks, external design-direction requests and optional telemetry. This
  integration uses its reference playbooks in guidance-only mode. Do not run
  the launcher, installer, hooks or live-mode service as an implicit setup step.

This is a review of integration boundaries and known side-effect entry points,
not a security audit of every upstream file. Read any tool and its relevant
imports before executing it. Repository content is reference material, not
authorization to publish, deploy, access secrets or expand the task.

[Server Survival](https://github.com/pshenok/server-survival) is a product
reference, not an installed skill: useful learning activities let the learner
change something, observe the consequence and explain why. Its game engine is
not a dependency of Ohiyo.
