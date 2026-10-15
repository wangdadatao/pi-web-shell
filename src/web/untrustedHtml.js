import DOMPurify from "./vendor/purify.es.mjs";

// @project-doc docs/operations/security.md#untrusted_render

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Escape text that will be interpolated into HTML. */
export function escapeText(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Markdown HTML after DOMPurify. Model and user prose both go through here. */
export function sanitizeHtml(html) {
  return DOMPurify.sanitize(String(html ?? ""));
}

/**
 * Placeholder for a mermaid fence. The source is text, never markup: mermaid
 * renders later, and a fence body must not be able to run as HTML first.
 */
export function renderMermaidPlaceholder(source, labels) {
  return (
    `<div class="mermaid-block">` +
    `<div class="code-head"><span class="code-lang">mermaid</span>` +
    `<button class="copy-btn" type="button" data-copy="diagram" aria-label="${escapeText(labels.copyLabel)}">${escapeText(labels.copy)}</button></div>` +
    `<div class="mermaid-body"><span class="mermaid-pending">${escapeText(labels.pending)}</span></div>` +
    `<pre class="mermaid-source" hidden><code>${escapeText(source)}</code></pre>` +
    `</div>`
  );
}

/**
 * Mermaid SVG is inserted with innerHTML. Real diagrams put HTML labels in
 * `foreignObject` and colors in `<style>`, so those stay; script, frames, and
 * event handlers do not. Anything that still looks executable after the
 * sanitizer is dropped entirely.
 */
const MERMAID_SVG_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ["foreignObject"],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  FORBID_TAGS: ["script", "iframe", "object", "embed"],
};

export function mermaidSvgForInsert(svg) {
  const raw = String(svg ?? "");
  if (!/<\s*svg[\s>]/i.test(raw)) return null;
  const cleaned = DOMPurify.sanitize(raw, MERMAID_SVG_CONFIG);
  if (!cleaned || !/<\s*svg[\s>]/i.test(cleaned) || svgHasActiveContent(cleaned)) return null;
  return cleaned;
}

export function svgHasActiveContent(svg) {
  return (
    /<\s*script\b/i.test(svg) ||
    /<\s*iframe\b/i.test(svg) ||
    /<\s*object\b/i.test(svg) ||
    /<\s*embed\b/i.test(svg) ||
    /\son[a-z0-9_-]+\s*=/i.test(svg) ||
    /javascript\s*:/i.test(svg)
  );
}
