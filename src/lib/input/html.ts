/** Tiny dependency-free HTML helpers. Retrieved markup is untrusted data: we only extract text. */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: "...",
  bull: "-",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : match;
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

export interface ParsedPage {
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  jsonLdBlocks: string[];
  text: string;
}

function metaContent(html: string, key: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${key}["'][^>]*content=["']([^"']*)["'][^>]*>|<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${key}["'][^>]*>`,
    "i",
  );
  const m = html.match(re);
  const value = m?.[1] ?? m?.[2];
  return value ? decodeEntities(value).trim() || null : null;
}

export function parseHtml(html: string): ParsedPage {
  const jsonLdBlocks: string[] = [];
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = ldRe.exec(html); m; m = ldRe.exec(html)) jsonLdBlocks.push(m[1].trim());

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] ?? null;

  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|nav|footer|iframe|form|button)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|ul|ol|header|main|table)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() || null : null,
    description: metaContent(html, "description") ?? metaContent(html, "og:description"),
    canonicalUrl: canonical,
    jsonLdBlocks,
    text,
  };
}
