---
name: designing-learning-experiences
description: Uses Learn Anything to design Ohiyo lessons, practice and useful feedback. Use when authoring or improving learning examples and teaching interactions, or when Learn Anything is requested.
---

# Design learning that tests understanding

Read [the project integration rules](../README.md) first, including source setup.
Learn Anything generates its skills from TypeScript templates. Read the
instruction text in the relevant pinned workflow; these are reference files,
not scripts to execute:

- [Explanation](../../skill-sources/learn-anything/packages/cli/src/core/templates/workflows/learn-explain.ts)
- [Quiz and feedback](../../skill-sources/learn-anything/packages/cli/src/core/templates/workflows/learn-quiz.ts)
- [Practice](../../skill-sources/learn-anything/packages/cli/src/core/templates/workflows/learn-practice.ts)
- [Topic structure](../../skill-sources/learn-anything/packages/cli/src/core/templates/workflows/learn-topic.ts)

Also read [Burrow's teaching contract](../teaching-from-material/SKILL.md).
Adapt the teaching process, not the upstream CLI's commands or storage contract.
Do not run its installer, create `.learn` records, launch its dashboard or
assume its slash commands exist in Burrow.

Define one learning objective and the evidence that would demonstrate it.
Ground explanations in the supplied material. Explain the actual mechanism
before relying on a metaphor and identify the metaphor's limitations. Pair a
worked example with an application problem where a plausible misconception
produces a different answer. Keep answers hidden until the learner attempts it.
Feedback should explain the mistaken reasoning and give a concrete next attempt.

For an interactive experiment, ask for a prediction, let the learner vary one
input, and explain the observed consequence. Server Survival is inspiration for
this pattern, not a requirement to build a game or import its engine.

Use only the question types and controls Burrow supports. A multiple-choice
score is not proof of mastery. Do not invent persistent progress, adaptive
grading or scheduled review. Check source accuracy and ambiguous answers by
hand; validate and exercise the rendered lesson separately. Do not claim a
learning improvement without evaluating actual outputs or learner outcomes.
