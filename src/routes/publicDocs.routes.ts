import { Router } from "express";
import fs from "fs";
import path from "path";
import { marked, Renderer } from "marked";

export const publicDocsRouter = Router();

// This app is only ever publicly reachable under ship.embarko.ai/api/...
// — Traefik strips the /api prefix before the request reaches this
// process (see the platform API's own base-URL note in docs.md), so
// req.path/Express routing below correctly stays prefix-free. But any
// link INSIDE a rendered page (HTML) or served file (raw .md) is
// followed directly against the public host — by a browser for HTML, or
// by whatever's consuming the raw markdown for .md — so every link this
// file generates in its own output must use one of these, never the
// bare mount path.
const HTML_PREFIX = "/api/public";
const MD_ORIGIN = "https://ship.embarko.ai/api/public";

// hostnsoft-api/public-docs/ — see docs/request-feature-req.md's sibling,
// docs/CLAUDE.md's note on this directory: customer-facing documentation,
// no login required, deliberately separate from docs/ (internal/planning
// docs). Reads the .md files straight off disk on every request rather
// than baking them in at build time — editing a file here IS the update,
// no separate publish/copy step, so these can never drift from what's
// actually served. Same relative depth from src/ (dev, via tsx) and
// dist/ (prod, after tsc) to the repo root, so this path resolves
// correctly either way.
const PUBLIC_DOCS_DIR = path.resolve(__dirname, "../../public-docs");

// Ordered, not just whatever fs.readdir returns — controls both the
// index page's listing order and implicitly which files are servable at
// all (see the slug validation below, which checks against this list's
// actual filenames on disk rather than trusting the request).
const DOC_ORDER = ["docs.md", "troubleshoot.md", "limitations-and-recommendations.md", "hackathons.md"];

function slugFor(filename: string): string {
  return filename.replace(/\.md$/, "");
}

// Strict allowlist — this becomes a filesystem read, so a slug that
// isn't exactly one of the known doc filenames (no dots, slashes, or
// anything else) is rejected before ever touching path.resolve/fs.
const SLUG_PATTERN = /^[a-z0-9-]+$/;

function readDoc(slug: string): { filename: string; content: string } | null {
  if (!SLUG_PATTERN.test(slug)) return null;
  const filename = `${slug}.md`;
  if (!DOC_ORDER.includes(filename)) return null;

  // Belt-and-suspenders on top of the allowlist above: confirm the
  // resolved path is still actually inside PUBLIC_DOCS_DIR before
  // reading it.
  const filePath = path.resolve(PUBLIC_DOCS_DIR, filename);
  if (!filePath.startsWith(PUBLIC_DOCS_DIR + path.sep)) return null;

  try {
    return { filename, content: fs.readFileSync(filePath, "utf8") };
  } catch {
    return null;
  }
}

// Matches the GitHub-style slug scheme the .md files' own internal links
// already assume (e.g. `[...](limitations-and-recommendations.md#only-data_dir-survives-a-redeploy)`)
// — marked's default renderer doesn't add heading ids at all, so without
// this every in-page/cross-doc anchor link here would silently land at
// the top of the page instead of the actual section.
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const renderer = new Renderer();
renderer.heading = function ({ tokens, depth, text }) {
  // docs.md writes some headings as `## [Text](#explicit-slug)` — a
  // single inline link whose own href IS the intended anchor. Honor
  // that explicit slug rather than re-deriving one from the visible
  // text, which wouldn't match (the text token here would be the whole
  // "[Text](#explicit-slug)" markdown, not just "Text").
  const soleToken = tokens.length === 1 ? tokens[0] : null;
  const id =
    soleToken?.type === "link" && soleToken.href.startsWith("#")
      ? soleToken.href.slice(1)
      : slugifyHeading(text);
  return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
};
marked.use({ renderer });

function titleFor(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Embarko Docs";
}

// The .md files link to each other as plain relative filenames
// (`[troubleshoot.md](troubleshoot.md#anchor)`) — the actual source of
// truth for cross-references, kept correct by the link-checker run
// whenever these docs are edited (see docs/request-feature-req.md's
// sibling memory note on updating them). Rewriting those into this
// route's own URL shape here means the .md files never need to know
// they're also served over HTTP under a different path.
function rewriteMdLinksForHtml(html: string): string {
  return html.replace(/href="([a-z0-9-]+)\.md(#[\w-]*)?"/g, `href="${HTML_PREFIX}/$1$2"`);
}

// Same idea, but for the RAW markdown routes below: rewrites in
// markdown-link syntax (`](target.md#anchor)`), not HTML, and to a
// FULLY QUALIFIED URL rather than a root-relative path — this markdown
// is meant to be fetched and embedded by an external UI, which can't be
// assumed to be serving from this same origin, so a root-relative link
// would resolve against the wrong host once embedded elsewhere.
function rewriteMdLinksForMarkdown(markdown: string): string {
  return markdown.replace(/\]\(([a-z0-9-]+)\.md(#[\w-]*)?\)/g, `](${MD_ORIGIN}/$1.md$2)`);
}

const PAGE_STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #FAF9F6; --ink: #1C1B19; --ink-dim: #57534E; --border: #E5E1DA;
    --accent: #B45309; --code-bg: #F1EFE9; --link: #9A3412;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #171613; --ink: #EDEAE3; --ink-dim: #A8A29E; --border: #33312C; --code-bg: #211F1B; --link: #FDBA74; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.65;
  }
  .wrap { max-width: 780px; margin: 0 auto; padding: 40px 20px 80px; }
  nav.topnav { display: flex; gap: 18px; padding: 16px 20px; border-bottom: 1px solid var(--border); font-size: 14px; }
  nav.topnav a { color: var(--ink-dim); text-decoration: none; }
  nav.topnav a:hover { color: var(--link); }
  h1 { font-size: 30px; margin: 0 0 8px; }
  h2 { font-size: 22px; margin: 40px 0 12px; border-top: 1px solid var(--border); padding-top: 28px; }
  h3 { font-size: 17px; margin: 28px 0 8px; }
  p, li { color: var(--ink); }
  a { color: var(--link); }
  code { background: var(--code-bg); padding: 2px 5px; border-radius: 4px; font-size: 0.9em; }
  pre { background: var(--code-bg); padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14.5px; }
  th, td { border: 1px solid var(--border); padding: 7px 10px; text-align: left; }
  hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
  .doc-list { list-style: none; padding: 0; }
  .doc-list li { margin-bottom: 18px; }
  .doc-list a { font-size: 17px; font-weight: 600; }
  .doc-list p { margin: 4px 0 0; color: var(--ink-dim); font-size: 14.5px; }
`;

function pageHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Embarko Docs</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<nav class="topnav">
  <a href="${HTML_PREFIX}/index">Embarko Docs</a>
  <a href="${HTML_PREFIX}/docs">Getting started &amp; API reference</a>
  <a href="${HTML_PREFIX}/troubleshoot">Troubleshooting</a>
  <a href="${HTML_PREFIX}/limitations-and-recommendations">Limitations &amp; recommendations</a>
  <a href="${HTML_PREFIX}/hackathons">Hackathons</a>
</nav>
<div class="wrap">
${bodyHtml}
</div>
</body>
</html>`;
}

// Index (HTML): renamed from /public/docs to /public/index — the bare
// "docs" slug now means the docs.md content route instead (see below).
publicDocsRouter.get("/public/index", (_req, res) => {
  const items = DOC_ORDER.map((filename) => {
    const doc = readDoc(slugFor(filename));
    const title = doc ? titleFor(doc.content) : filename;
    return `<li><a href="${HTML_PREFIX}/${slugFor(filename)}">${title}</a></li>`;
  }).join("\n");

  res.type("html").send(
    pageHtml(
      "Embarko Docs",
      `<h1>Embarko Documentation</h1>
       <p>Everything you need to deploy and run an app on Embarko.</p>
       <ul class="doc-list">${items}</ul>`
    )
  );
});

// Individual docs (HTML): flattened from /public/docs/:slug to
// /public/:slug — e.g. /public/docs (was /public/docs/docs),
// /public/troubleshoot, /public/limitations-and-recommendations.
publicDocsRouter.get("/public/:slug([a-z0-9-]+)", (req, res) => {
  const doc = readDoc(req.params.slug);
  if (!doc) {
    return res
      .status(404)
      .type("html")
      .send(pageHtml("Not found", `<h1>Not found</h1><p>No such doc. <a href="${HTML_PREFIX}/index">Back to the docs index</a>.</p>`));
  }
  const rendered = rewriteMdLinksForHtml(marked.parse(doc.content, { async: false }) as string);
  res.type("html").send(pageHtml(titleFor(doc.content), rendered));
});

// --- Raw markdown routes — for embedding in another UI, not for a browser to render ---

const MD_INDEX = () => {
  const links = DOC_ORDER.map((filename) => {
    const doc = readDoc(slugFor(filename));
    const title = doc ? titleFor(doc.content) : filename;
    return `- [${title}](${MD_ORIGIN}/${filename})`;
  }).join("\n");
  return `# Embarko Documentation\n\nEverything you need to deploy and run an app on Embarko.\n\n${links}\n`;
};

publicDocsRouter.get("/public/index.md", (_req, res) => {
  res.type("text/markdown").send(MD_INDEX());
});

publicDocsRouter.get("/public/:slug.md", (req, res) => {
  const doc = readDoc(req.params.slug);
  if (!doc) {
    return res.status(404).type("text/markdown").send("# Not found\n\nNo such doc.\n");
  }
  res.type("text/markdown").send(rewriteMdLinksForMarkdown(doc.content));
});
