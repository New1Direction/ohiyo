import { defineCatalog, type Spec } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

const short = z.string().trim().min(1).max(500);
const body = z.string().trim().min(1).max(2000);
const id = z.string().regex(/^(?!constructor$|prototype$)[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const questionSchema = z.strictObject({ question: short, options: z.array(short).min(2).max(4), answer: z.number().int().min(0).max(3), explanation: short });
export const sceneSchema = z.strictObject({ id, heading: short, text: body, choices: z.array(z.strictObject({ label: short, next: id })).max(4) });

// The model composes familiar controls, not scripts, URLs, or arbitrary actions.
export const catalog = defineCatalog(schema, {
  components: {
    Stack: { props: z.strictObject({}), slots: ["default"], description: "Vertical layout. Use as the root." },
    Columns: { props: z.strictObject({}), slots: ["default"], description: "Two equal columns, stacked on narrow screens." },
    Card: { props: z.strictObject({}), slots: ["default"], description: "A bordered card containing other components." },
    Heading: { props: z.strictObject({ text: short }), description: "Section heading." },
    Text: { props: z.strictObject({ text: body }), description: "Paragraph. Plain text, not HTML or Markdown." },
    Callout: { props: z.strictObject({ title: short, text: body }), description: "Highlighted useful note." },
    Metric: { props: z.strictObject({ label: short, value: short, detail: short }), description: "One prominent figure with context. Do not invent data." },
    BarChart: { props: z.strictObject({ title: short, bars: z.array(z.strictObject({ label: short, value: z.number().min(0).max(1e9) })).min(1).max(12) }), description: "Labelled numeric bar chart. Only use supplied or clearly hypothetical values." },
    Table: { props: z.strictObject({ columns: z.array(short).min(1).max(6), rows: z.array(z.strictObject({ cells: z.array(short).min(1).max(6) })).min(1).max(30) }), description: "A comparison table. Each row must match the column count." },
    Checklist: { props: z.strictObject({ title: short, items: z.array(z.strictObject({ text: short, done: z.boolean() })).min(1).max(30) }), description: "Interactive checkboxes; preview interactions are temporary." },
    Quiz: { props: z.strictObject({ questions: z.array(questionSchema).min(2).max(12) }), description: "Playable quiz with explanations and scoring. answer is a zero-based index within options." },
    Story: { props: z.strictObject({ scenes: z.array(sceneSchema).min(2).max(12) }), description: "A playable branching story. First scene starts the story. All scenes reachable, all targets exist, at least one ending with choices:[]." },
    Reveal: { props: z.strictObject({ label: short, text: body }), description: "Expandable explanation with a familiar disclosure control." },
  },
  actions: {},
});

const elementSchemas = Object.entries(catalog.data.components).map(([name, definition]) => z.strictObject({
  type: z.literal(name), props: definition.props,
  children: z.array(id).max("slots" in definition ? 30 : 0),
}));
export const literalSpecSchema = z.strictObject({ root: id, elements: z.record(id, z.union(elementSchemas)) });
export const pageSchema = z.strictObject({ title: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(800), theme: z.enum(["violet", "forest", "coral"]), spec: literalSpecSchema });
export type CreationPage = Omit<z.infer<typeof pageSchema>, "spec"> & { spec: Spec };

export function parsePage(value: unknown): CreationPage {
  const page = pageSchema.parse(value) as CreationPage;
  const elements = page.spec.elements;
  if (Object.keys(elements).length > 80) throw new Error("This page has too many parts.");
  const seen = new Set<string>();
  function walk(key: string, depth: number) {
    if (depth > 12 || seen.has(key) || !Object.prototype.hasOwnProperty.call(elements, key)) throw new Error("This page has an invalid layout.");
    seen.add(key);
    const element = elements[key];
    if (element.type === "Quiz") {
      const { questions } = catalog.data.components.Quiz.props.parse(element.props);
      if (questions.some(q => q.answer >= q.options.length || new Set(q.options.map(o => o.trim().toLowerCase())).size !== q.options.length)) throw new Error("This quiz has an invalid answer.");
    }
    if (element.type === "Story") {
      const { scenes } = catalog.data.components.Story.props.parse(element.props);
      const ids = new Set(scenes.map(s => s.id));
      const reached = new Set<string>();
      const pending = [scenes[0].id];
      while (pending.length) {
        const next = pending.pop()!;
        if (reached.has(next)) continue;
        reached.add(next);
        const scene = scenes.find(s => s.id === next);
        if (!scene) throw new Error("This story has a missing scene.");
        pending.push(...scene.choices.map(c => c.next));
      }
      if (ids.size !== scenes.length || reached.size !== scenes.length || !scenes.some(s => !s.choices.length)) throw new Error("This story has an invalid path.");
    }
    if (element.type === "Table") {
      const { columns, rows } = catalog.data.components.Table.props.parse(element.props);
      if (rows.some(r => r.cells.length !== columns.length)) throw new Error("This table has a missing cell.");
    }
    for (const child of element.children ?? []) walk(child, depth + 1);
  }
  walk(page.spec.root, 0);
  if (seen.size !== Object.keys(elements).length) throw new Error("This page contains disconnected parts.");
  return page;
}
