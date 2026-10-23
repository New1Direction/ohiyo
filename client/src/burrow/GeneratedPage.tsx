import { useRef, useState } from "react";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { z } from "zod";
import { catalog, parsePage, questionSchema, sceneSchema } from "./catalog";
import SpringLab from "./SpringLab";
import RequestJourney from "./RequestJourney";

export function Quiz({ questions }: { questions: z.infer<typeof questionSchema>[] }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const question = questions[index];
  const answered = answers[index] !== undefined;
  const score = answers.filter((answer, i) => answer === questions[i].answer).length;
  function next(value: number) {
    setIndex(value);
    requestAnimationFrame(() => heading.current?.focus());
  }
  return <section className="gen-quiz">
    {question ? <>
      <div className="gen-quiz-progress"><span>Question {index + 1} of {questions.length}</span><span>{score} correct</span></div>
      <progress value={index} max={questions.length} aria-label="Quiz progress" />
      <h3 tabIndex={-1} ref={heading}>{question.question}</h3>
      <div className="gen-answers">{question.options.map((option, i) => <button key={i} type="button" disabled={answered} aria-pressed={answers[index] === i} className={answered && i === question.answer ? "correct" : answered && answers[index] === i ? "incorrect" : ""} onClick={() => setAnswers([...answers, i])}><span aria-hidden="true">{String.fromCharCode(65 + i)}</span>{option}{answered && i === question.answer && <strong>✓ Correct answer</strong>}</button>)}</div>
      {answered && <div className="gen-answer-result" role="status"><strong>{answers[index] === question.answer ? "You got it." : "Not quite. Here’s why."}</strong><p>{question.explanation}</p><button className="gen-button" onClick={() => next(index + 1)}>{index === questions.length - 1 ? "See my score" : "Next question"} <span aria-hidden="true">→</span></button></div>}
    </> : <div className="gen-finish"><span className="gen-finish-mark" aria-hidden="true">✦</span><p>ALL FINISHED</p><h3 tabIndex={-1} ref={heading}>{score} out of {questions.length}</h3><p>{score === questions.length ? "That stuck. Nice work." : "Every answer is a chance to learn something."}</p><button className="gen-button" onClick={() => { setAnswers([]); next(0); }}>Try again</button></div>}
  </section>;
}

export function Story({ scenes }: { scenes: z.infer<typeof sceneSchema>[] }) {
  const [path, setPath] = useState([scenes[0].id]);
  const heading = useRef<HTMLHeadingElement>(null);
  const scene = scenes.find(s => s.id === path[path.length - 1])!;
  function go(next: string[]) { setPath(next); requestAnimationFrame(() => heading.current?.focus()); }
  return <section className="gen-story"><p className="gen-kicker">{scene.choices.length ? "YOUR STORY. YOUR NEXT MOVE." : "THE END · ONE OF MANY POSSIBILITIES"}</p><h3 ref={heading} tabIndex={-1}>{scene.heading}</h3><p className="gen-story-text">{scene.text}</p><div className="gen-story-choices">{scene.choices.map((choice, i) => <button type="button" key={i} onClick={() => go([...path, choice.next])}>{choice.label}<span aria-hidden="true">→</span></button>)}</div><div className="gen-story-tools">{path.length > 1 && <button className="burrow-link" onClick={() => go(path.slice(0,-1))}>← Back</button>}<button className="burrow-link" onClick={() => go([scenes[0].id])}>Start over</button></div></section>;
}

function Checklist({ title, items }: z.infer<typeof catalog.data.components.Checklist.props>) {
  const [checked, setChecked] = useState(items.map(i => i.done));
  return <section className="gen-checklist"><h3>{title}</h3><p>{checked.filter(Boolean).length} of {items.length} checked</p>{items.map((item, i) => <label key={i}><input type="checkbox" checked={checked[i]} onChange={e => setChecked(checked.map((value, index) => index === i ? e.target.checked : value))} /><span className={checked[i] ? "checked" : ""}>{item.text}</span></label>)}</section>;
}

const { registry } = defineRegistry(catalog, {
  components: {
    Stack: ({ children }) => <div className="gen-stack">{children}</div>,
    Columns: ({ children }) => <div className="gen-columns">{children}</div>,
    Card: ({ children }) => <section className="gen-card">{children}</section>,
    Heading: ({ props }) => <h2 className="gen-heading">{props.text}</h2>,
    Text: ({ props }) => <p className="gen-text">{props.text}</p>,
    Callout: ({ props }) => <aside className="gen-callout"><span aria-hidden="true">✦</span><div><h3>{props.title}</h3><p>{props.text}</p></div></aside>,
    Metric: ({ props }) => <section className="gen-metric"><p>{props.label}</p><strong>{props.value}</strong><small>{props.detail}</small></section>,
    BarChart: ({ props }) => <section className="gen-chart"><h3>{props.title}</h3>{props.bars.map((bar, i) => <div key={i}><div><span>{bar.label}</span><b>{bar.value.toLocaleString()}</b></div><progress value={bar.value} max={Math.max(1,...props.bars.map(b => b.value))} aria-label={bar.label} /></div>)}</section>,
    Table: ({ props }) => <div className="gen-table-scroll"><table><thead><tr>{props.columns.map((column,i) => <th scope="col" key={i}>{column}</th>)}</tr></thead><tbody>{props.rows.map((row,i) => <tr key={i}>{row.cells.map((cell,j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>,
    Checklist: ({ props }) => <Checklist {...props} />,
    Quiz: ({ props }) => <Quiz {...props} />,
    Story: ({ props }) => <Story {...props} />,
    SpringLab: () => <SpringLab />,
    RequestJourney: () => <RequestJourney />,
    Reveal: ({ props }) => <details className="gen-reveal"><summary>{props.label}</summary><p>{props.text}</p></details>,
  },
});

export default function GeneratedPage({ value }: { value: unknown }) {
  let page;
  try { page = parsePage(value); }
  catch { return <p role="alert" className="burrow-error">This version can’t be displayed safely. Ask Kikka to try again, or undo the last change.</p>; }
  return <div className={`generated-page theme-${page.theme}`}><header className="gen-page-heading"><span className="gen-kicker">MADE FOR A LITTLE POSSIBILITY</span><h1>{page.title}</h1><p>{page.description}</p></header><JSONUIProvider registry={registry}><Renderer spec={page.spec} registry={registry} /></JSONUIProvider></div>;
}
