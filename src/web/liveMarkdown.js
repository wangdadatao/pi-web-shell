/**
 * Incremental Markdown streaming helpers.
 *
 * The live assistant bubble cannot re-parse its whole text on every delta: an
 * unclosed ``` fence would swallow the rest of the reply, and re-rendering
 * finished blocks each frame would re-run Prism and Mermaid for content that
 * has not changed. So we split the text at points where more input provably
 * cannot rewrite what came before — a blank line outside a fence, or a closing
 * fence — commit those regions once, and keep only the growing remainder live.
 *
 * These are pure text helpers (no DOM), so the browser can import this module
 * directly and the tests can exercise it under Node.
 */

/** A line that can open a fenced code block: up to 3 spaces, then ``` or ~~~. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A line that can close one: the same fence run and nothing but spaces after. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** A list item marker; used to keep a loose list inside one committed chunk. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;

function fenceOpen(line) {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  // A backtick fence's info string may not contain a backtick, so such a line
  // is ordinary text rather than a fence.
  if (match[1][0] === "`" && match[2].includes("`")) return null;
  return { char: match[1][0], length: match[1].length };
}

function fenceCloses(line, fence) {
  const match = FENCE_CLOSE.exec(line);
  return Boolean(match) && match[1][0] === fence.char && match[1].length >= fence.length;
}

/**
 * End offset of the last region that renders correctly on its own, scanning
 * from `from` (which must itself be a boundary: 0, or a prior result).
 *
 * A blank line outside a fence ends a block, and so does a closing fence — the
 * text after a closed fence starts a fresh block, blank line or not. While a
 * fence is open nothing is a boundary, since its body may contain blank lines.
 */
export function findStableEnd(text, from = 0) {
  let index = from;
  let fence = null;
  let end = from;
  while (index < text.length) {
    const newline = text.indexOf("\n", index);
    const stop = newline === -1 ? text.length : newline;
    const line = text.slice(index, stop);
    const next = newline === -1 ? text.length : newline + 1;
    if (fence) {
      if (fenceCloses(line, fence)) {
        fence = null;
        end = next;
      }
    } else {
      const open = fenceOpen(line);
      if (open) fence = open;
      else if (line.trim() === "") end = next;
    }
    if (newline === -1) break;
    index = next;
  }
  return { end, inFence: fence !== null };
}

/** The first non-blank line of a chunk, or "" when it has none. */
function firstLine(text) {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") return line;
  }
  return "";
}

/**
 * Whether `next` continues the list that `prev` committed.
 *
 * Markdown lets a list item be separated from the previous one by a blank line
 * (a "loose" list) and lets it hold a further indented paragraph. Committing
 * those as separate chunks would restart ordered numbering, so the caller
 * re-renders the pair as one.
 */
export function continuesList(prev, next) {
  const head = firstLine(prev);
  const tail = firstLine(next);
  if (!head || !tail || !LIST_ITEM.test(head)) return false;
  return LIST_ITEM.test(tail) || /^ {2,}\S/.test(tail);
}
