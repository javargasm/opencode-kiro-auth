import type { RegisteredTool, McpToolResult } from "../types.js";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Decodes DuckDuckGo redirect link (e.g. /l/?uddg=https%3A%2F%2Fexample.com)
 */
function cleanDuckDuckGoUrl(rawUrl: string): string {
  try {
    if (rawUrl.startsWith("//")) {
      rawUrl = "https:" + rawUrl;
    }
    const parsed = new URL(rawUrl, "https://html.duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Parse DuckDuckGo HTML results into structured SearchResult objects
 */
export function parseDuckDuckGoHtml(html: string, maxResults = 5): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result elements: <div class="result ...">...</div> or <a class="result__url" ...>
  // In html.duckduckgo.com:
  // Title link: <a class="result__snippet ... href="...">...</a> or <a class="result__url" href="...">
  // Snippet: <a class="result__snippet" ...>...</a>
  const resultBlocks = html.split(/class="result\s+results_links/gi);

  for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
    const block = resultBlocks[i];
    if (!block) continue;

    // Extract title & link (prioritize result__a and result__url for actual titles)
    const titleMatch =
      block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/is) ||
      block.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>(.*?)<\/a>/is) ||
      block.match(/<a[^>]*class="[^"]*result__url[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/is) ||
      block.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__url[^"]*"[^>]*>(.*?)<\/a>/is) ||
      block.match(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/is);

    // Extract snippet text
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/is) ||
      block.match(/<td[^>]*class="result-snippet"[^>]*>(.*?)<\/td>/is);

    let rawUrl = "";
    let rawTitle = "";

    if (titleMatch) {
      rawUrl = titleMatch[1] || "";
      rawTitle = titleMatch[2] || "";
    }

    // Try alternate title match if needed
    if (!rawTitle) {
      const altTitle = block.match(/<h2[^>]*>.*?<a[^>]*>(.*?)<\/a>.*?<\/h2>/is);
      if (altTitle) rawTitle = altTitle[1] || "";
    }

    let rawSnippet = snippetMatch ? (snippetMatch[1] || "") : "";

    // Clean HTML tags and entities
    const cleanText = (str: string) =>
      str
        .replace(/<[^>]+>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const title = cleanText(rawTitle);
    const snippet = cleanText(rawSnippet);
    const url = cleanDuckDuckGoUrl(rawUrl);

    if (url && (title || snippet)) {
      results.push({
        title: title || url,
        url,
        snippet: snippet || "No description available.",
      });
    }
  }

  return results;
}

export const webSearchTool: RegisteredTool = {
  tool: {
    name: "web_search",
    description:
      "Search the web for up-to-date information, documentation, and technical references outside the model's training data.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to look up on the web (e.g. 'AWS Bedrock Claude Opus 4.8 streaming API').",
        },
        max_results: {
          type: "number",
          description: "Maximum number of search results to return (default: 5, maximum: 10).",
        },
      },
      required: ["query"],
    },
  },
  handler: async (args): Promise<McpToolResult> => {
    const query = String(args.query || "").trim();
    if (!query) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'query' parameter is required." }],
      };
    }

    const maxResults = Math.min(Math.max(1, Number(args.max_results) || 5), 10);

    try {
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const resp = await fetch(searchUrl, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!resp.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Search error: Web search provider responded with HTTP status ${resp.status} ${resp.statusText}`,
            },
          ],
        };
      }

      const html = await resp.text();
      const results = parseDuckDuckGoHtml(html, maxResults);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No search results found for query: "${query}". Try adjusting your keywords.`,
            },
          ],
        };
      }

      const markdownResults = results
        .map((r, i) => `${i + 1}. [**${r.title}**](${r.url})\n   ${r.snippet}\n   *URL: ${r.url}*`)
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `## Web Search Results for "${query}"\n\n${markdownResults}\n\n> *Tip: Use \`web_fetch\` with mode \`selective\` on any of the URLs above to extract specific sections.*`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to execute web search for "${query}": ${err.message || String(err)}`,
          },
        ],
      };
    }
  },
};
