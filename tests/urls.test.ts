import { describe, expect, it } from "vitest";
import { canFetchDirectly, normalizeUrl, validateHttpUrl } from "@/lib/processing/urls";

describe("source URL validation (missing or invalid URLs never become links)", () => {
  it.each([
    [null],
    [undefined],
    [""],
    ["   "],
    ["not a url"],
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["ftp://files.example.com/a"],
    ["https://user:pass@example.com/"],
    ["https://localhost/"],
    ["https://example.com/a b"],
    ['https://example.com/"onmouseover="x'],
  ])("rejects %s", (value) => {
    expect(validateHttpUrl(value as string | null | undefined)).toBeNull();
  });

  it("accepts ordinary http(s) URLs", () => {
    expect(validateHttpUrl("https://www.eventbrite.com/e/abc-123")).toBe("https://www.eventbrite.com/e/abc-123");
    expect(validateHttpUrl("http://ispirt.in/events")).toBe("http://ispirt.in/events");
  });

  it("returns null from normalizeUrl for invalid input", () => {
    expect(normalizeUrl("nonsense")).toBeNull();
  });
});

describe("normalizeUrl", () => {
  it("collapses tracking params, www, fragments, trailing slashes and scheme", () => {
    const a = normalizeUrl("http://www.Example.com/events/cio/?utm_source=x&b=2&a=1#frag");
    const b = normalizeUrl("https://example.com/events/cio?a=1&b=2");
    expect(a).toBe(b);
  });
  it("keeps meaningful query parameters", () => {
    expect(normalizeUrl("https://example.com/e?id=5")).not.toBe(normalizeUrl("https://example.com/e?id=6"));
  });
});

describe("direct-fetch policy", () => {
  it("never fetches login-walled platforms directly", () => {
    expect(canFetchDirectly("https://www.linkedin.com/posts/abc")).toBe(false);
    expect(canFetchDirectly("https://m.facebook.com/events/1")).toBe(false);
  });
  it("allows ordinary event sites", () => {
    expect(canFetchDirectly("https://www.eventbrite.com/e/1")).toBe(true);
  });
});
