import type { ReactNode } from "react";
import type { Tone } from "../model.js";
import { onLinkClick } from "../router.js";

export function Dot({ tone, title }: { tone: Tone; title?: string }) {
  return <span className={`dot dot-${tone}`} title={title} aria-label={title} />;
}

export function Pill({ tone = "off", children }: { tone?: Tone | "accent"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/** Context-window usage as a small ring; colour follows the daemon's warning bands. */
export function Ring({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="ring ring-unknown" title="context usage unknown">–</span>;
  const tone = percent >= 85 ? "bad" : percent >= 60 ? "warn" : "ok";
  const style = { background: `conic-gradient(var(--c-${tone}) ${percent}%, var(--line) 0)` };
  return (
    <span className={`ring ring-${tone}`} style={style} title={`context ${percent}% used`}>
      <span>{percent}</span>
    </span>
  );
}

export function Link({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return <a href={href} className={className} onClick={onLinkClick}>{children}</a>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="note note-bad">{msg}</div>;
}
