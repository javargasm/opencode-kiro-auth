import type { RegisteredTool, McpToolResult } from "../types.js";

/**
 * Basic HTML to Markdown converter (strips scripts, styles, navigations, footers, forms)
 */
function htmlToCleanMarkdown(html: string): string {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
    .replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, "");

  // Headings
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "\n\n# $1\n\n");
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n\n## $1\n\n");
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "\n\n### $1\n\n");
  text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "\n\n#### $1\n\n");

  // Code blocks & inline code
  text = text.replace(/<pre[^>]*><code[^>]*>(.*?)<\/code><\/pre>/gis, "\n```\n$1\n```\n");
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");

  // Paragraphs & breaks
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gis, "\n\n$1\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, "\n* $1");

  // Links
  text = text.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Collapse excess blank lines
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Selective extraction around search terms to save context window tokens
 */
function extractSelectiveSections(markdown: string, searchTerms: string[]): string {
  if (!searchTerms.length) return markdown.slice(0, 8000);

  const lowerTerms = searchTerms.map((t) => t.toLowerCase().trim()).filter(Boolean);
  if (!lowerTerms.length) return markdown.slice(0, 8000);

  const sections = markdown.split(/\n\n+/);
  const matchedSections: { index: number; text: string; score: number }[] = [];

  sections.forEach((sec, idx) => {
    const secLower = sec.toLowerCase();
    let score = 0;
    for (const term of lowerTerms) {
      if (secLower.includes(term)) {
        score += 1;
      }
    }
    if (score > 0) {
      matchedSections.push({ index: idx, text: sec, score });
    }
  });

  if (!matchedSections.length) {
    return `(No direct matches found for search terms: [${searchTerms.join(", ")}]. Showing document preview:)\n\n${markdown.slice(0, 4000)}`;
  }

  // Include surrounding context paragraphs
  const includedIndices = new Set<number>();
  for (const m of matchedSections) {
    includedIndices.add(Math.max(0, m.index - 1));
    includedIndices.add(m.index);
    includedIndices.add(Math.min(sections.length - 1, m.index + 1));
  }

  const sorted = Array.from(includedIndices).sort((a, b) => a - b);
  const resultBlocks: string[] = [];

  let prevIdx = -2;
  for (const idx of sorted) {
    const sec = sections[idx];
    if (sec) {
      resultBlocks.push(sec);
    }
    prevIdx = idx;
  }

  return `### Selective Content Matches (${matchedSections.length} sections matched [${searchTerms.join(", ")}]):\n\n${resultBlocks.join("\n\n")}`;
}

export const webFetchTool: RegisteredTool = {
  tool: {
    name: "web_fetch",
    description:
      "Fetch and extract content from a specific URL. Supports three modes: 'selective' (default, extracts relevant sections around search terms), 'truncated' (first 8000 chars), 'full' (complete content).",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to fetch content from.",
        },
        mode: {
          type: "string",
          enum: ["selective", "truncated", "full"],
          description: "Extraction mode: 'selective' (default), 'truncated' (first 8k chars), or 'full'.",
        },
        search_terms: {
          type: "array",
          items: { type: "string" },
          description: "Keywords for selective extraction to minimize context token usage.",
        },
      },
      required: ["url"],
    },
  },
  handler: async (args): Promise<McpToolResult> => {
    const rawUrl = String(args.url || "").trim();
    if (!rawUrl) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: URL parameter is required." }],
      };
    }

    let urlObj: URL;
    try {
      urlObj = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
    } catch {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: Invalid URL '${rawUrl}'` }],
      };
    }

    try {
      const resp = await fetch(urlObj.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `HTTP Error ${resp.status} ${resp.statusText} fetching ${urlObj.href}` }],
        };
      }

      const contentType = resp.headers.get("content-type") || "";
      const rawText = await resp.text();

      let markdown = contentType.includes("html") ? htmlToCleanMarkdown(rawText) : rawText;

      const mode = args.mode || (args.search_terms && args.search_terms.length > 0 ? "selective" : "truncated");

      let extracted = "";
      if (mode === "full") {
        extracted = markdown;
      } else if (mode === "selective") {
        const terms = Array.isArray(args.search_terms) ? args.search_terms : [];
        extracted = extractSelectiveSections(markdown, terms);
      } else {
        // truncated
        const MAX_CHARS = 8000;
        if (markdown.length > MAX_CHARS) {
          extracted = `${markdown.slice(0, MAX_CHARS)}\n\n---\n*(Content truncated at 8,000 characters. Use mode: 'full' or 'selective' to view more)*`;
        } else {
          extracted = markdown;
        }
      }

      return {
        content: [{ type: "text", text: extracted }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to fetch URL ${urlObj.href}: ${err.message || String(err)}` }],
      };
    }
  },
};
