// @ts-nocheck — sanitizer and markdown parser are vendored JavaScript.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * DOMPurify needs a browser DOM. jsdom stands in so the same sanitizer the
 * page uses can be exercised from node:test.
 */
function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4711/" });
  const target = globalThis as unknown as Record<string, unknown>;
  target["window"] = dom.window;
  target["document"] = dom.window.document;
  target["Node"] = dom.window.Node;
  target["Element"] = dom.window.Element;
  target["HTMLElement"] = dom.window.HTMLElement;
  target["DocumentFragment"] = dom.window.DocumentFragment;
  target["DOMParser"] = dom.window.DOMParser;
  target["HTMLTemplateElement"] = dom.window.HTMLTemplateElement;
  target["NamedNodeMap"] = dom.window.NamedNodeMap;
  target["NodeFilter"] = dom.window.NodeFilter;
  target["MutationObserver"] = dom.window.MutationObserver;
  return dom;
}

describe("untrusted markdown and mermaid", () => {
  it("does not let markdown or mermaid content through as script", async () => {
    const dom = installDom();
    try {
    const { marked } = await import("../src/web/vendor/marked.esm.js");
    const untrusted = await import("../src/web/untrustedHtml.js");

    const markdown = sanitizeSample(marked.parse(
      [
        'Hello <script>alert(1)</script>',
        '<img src="x" onerror="alert(1)">',
        '<a href="javascript:alert(1)">click</a>',
        '<iframe src="https://evil.example"></iframe>',
      ].join("\n\n"),
    ), untrusted.sanitizeHtml);
    assert.doesNotMatch(markdown, /<\s*script/i);
    assert.doesNotMatch(markdown, /onerror/i);
    assert.doesNotMatch(markdown, /javascript\s*:/i);
    assert.doesNotMatch(markdown, /<\s*iframe/i);
    assert.match(markdown, /Hello/);

    const source = '<img src=x onerror="alert(1)"><script>alert(1)</script>\nflowchart TD\n  A-->B';
    const placeholder = untrusted.renderMermaidPlaceholder(source, {
      copyLabel: "copy",
      copy: "copy",
      pending: "rendering",
    });
    assert.doesNotMatch(placeholder, /<\s*script/i);
    assert.doesNotMatch(placeholder, /<img/i);
    assert.match(placeholder, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(placeholder, /&lt;script&gt;/);
    assert.match(placeholder, /class="mermaid-source"/);

    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="x" onerror="alert(1)"></image></svg>`;
    assertSafeSvg(untrusted.mermaidSvgForInsert(maliciousSvg));
    const foreign = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror="alert(1)"></body></foreignObject></svg>`;
    const cleanedForeign = untrusted.mermaidSvgForInsert(foreign);
    assertSafeSvg(cleanedForeign);
    if (cleanedForeign !== null) assert.match(cleanedForeign, /foreignObject/i);

    const clean = `<svg xmlns="http://www.w3.org/2000/svg"><g class="node"><text>ok</text></g></svg>`;
    const kept = untrusted.mermaidSvgForInsert(clean);
    assert.equal(typeof kept, "string");
    assert.match(kept, /<svg[\s>]/i);
    assert.match(kept, /<g class="node"/);
    assert.match(kept, />ok</);
    } finally {
      dom.window.close();
    }
  });
});

function sanitizeSample(html: string, sanitize: (value: string) => string): string {
  return sanitize(html);
}

/** A dropped diagram is safe; a kept one must not still be executable. */
function assertSafeSvg(svg: string | null): void {
  if (svg === null) return;
  assert.doesNotMatch(svg, /<\s*script/i);
  assert.doesNotMatch(svg, /<\s*iframe/i);
  assert.doesNotMatch(svg, /\son[a-z0-9_-]+\s*=/i);
  assert.doesNotMatch(svg, /javascript\s*:/i);
}
