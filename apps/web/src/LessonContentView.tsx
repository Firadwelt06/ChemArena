import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import type { LessonContent } from "@chemarena/shared";
import "katex/dist/katex.min.css";

const markdownComponents: Components = {
  pre({ children }) {
    return <div className="lesson-code-block">{children}</div>;
  },
  code({ className, children }) {
    const language = /language-(\w+)/.exec(className ?? "")?.[1];
    if (language === "smiles") return <SmilesStructure smiles={String(children).trim()} />;
    return <code className={className}>{children}</code>;
  }
};

export function MarkdownContent({ children }: { children: string }) {
  return <div className="lesson-markdown">
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }]]} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  </div>;
}

export function LessonContentView({ content }: { content: LessonContent }) {
  return <div className="lesson-content">
    <section><h2>Learning objectives</h2><ul>{content.objectives.map((objective, index) => <li key={`${index}:${objective}`}>{objective}</li>)}</ul></section>
    <section><h2>Lesson</h2><MarkdownContent>{content.explanationMarkdown}</MarkdownContent></section>
    <section><h2>Worked examples</h2>{content.workedExamples.map((example, index) => <article className="lesson-example" key={`${index}:${example.problem}`}>
      <h3>Example {index + 1}</h3><MarkdownContent>{example.problem}</MarkdownContent><details><summary>Show worked solution</summary><MarkdownContent>{example.solution}</MarkdownContent></details>
    </article>)}</section>
    <section><h2>Hands-on activity</h2><MarkdownContent>{content.handsOnActivity}</MarkdownContent></section>
    <section><h2>Knowledge check</h2>{content.quiz.map((question, index) => <details className="lesson-quiz-question" key={`${index}:${question.stem}`}>
      <summary>{index + 1}. {question.stem}</summary>
      <div className="lesson-quiz-options">{question.options.map((option) => <p key={option.id}><strong>{option.id.toUpperCase()}.</strong> {option.text}</p>)}</div>
      <p><strong>Answer:</strong> {question.correctOptionIds.map((id) => question.options.find((option) => option.id === id)?.text).filter(Boolean).join("; ")}</p>
      <MarkdownContent>{question.explanation}</MarkdownContent>
    </details>)}</section>
    <section><h2>Homework</h2><MarkdownContent>{content.homework}</MarkdownContent></section>
  </div>;
}

function SmilesStructure({ smiles }: { smiles: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    void import("smiles-drawer").then((module) => {
      module.default.parse(smiles, (tree) => {
        if (cancelled || !canvasRef.current) return;
        const drawer = new module.default.Drawer({ width: 420, height: 220 });
        drawer.draw(tree, canvasRef.current, "light", false);
        setStatus("ready");
      }, () => { if (!cancelled) setStatus("error"); });
    }).catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [smiles]);
  return <div className="smiles-preview"><span>Structure diagram</span>
    {status === "loading" && <small>Rendering structure…</small>}
    {status === "error" && <small role="alert">Could not render this SMILES string.</small>}
    <canvas ref={canvasRef} width={420} height={220} hidden={status !== "ready"} />
  </div>;
}
