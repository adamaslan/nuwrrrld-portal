import type { ReactNode } from "react";

/**
 * MarkdownLite — render the small markdown subset model answers actually use
 * (**bold**, *italic*, `code`, bullet/numbered lists, paragraph breaks) as
 * real elements instead of leaking raw asterisks into the chat bubble.
 *
 * Deliberately not a full markdown parser: no headings, links, images, or
 * raw HTML, so there is no injection surface and no new dependency. Anything
 * outside the subset renders as the literal text the model sent.
 */

// Emphasis can't open before whitespace (CommonMark left-flanking rule), so
// literal uses like "a * b" stay text.
const INLINE_RE = /(\*\*[^\s*][^*\n]*\*\*|\*[^\s*][^*\n]*\*|`[^`\n]+`)/g;
const BULLET_RE = /^\s*[-*]\s+/;
const NUMBERED_RE = /^\s*\d+[.)]\s+/;

export function renderInline(text: string): ReactNode[] {
  return text.split(INLINE_RE).map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    return part || null;
  });
}

export function MarkdownLite({ text, className }: { text: string; className?: string }) {
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  return (
    <div className={className}>
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every(l => BULLET_RE.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => <li key={j}>{renderInline(l.replace(BULLET_RE, ""))}</li>)}
            </ul>
          );
        }
        if (lines.every(l => NUMBERED_RE.test(l))) {
          return (
            <ol key={i}>
              {lines.map((l, j) => <li key={j}>{renderInline(l.replace(NUMBERED_RE, ""))}</li>)}
            </ol>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {renderInline(l)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
