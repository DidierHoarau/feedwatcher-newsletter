import { RedactUrlPath, RequestSpanPathGet } from "./UrlPathRedaction";

describe("RedactUrlPath", () => {
  it("redacts a token-like final segment", () => {
    expect(RedactUrlPath("/rss/daily.abc123")).toBe("/rss/:redacted");
  });

  it("redacts a tokenized feed with a trailing slash", () => {
    expect(RedactUrlPath("/rss/daily.abc123/")).toBe("/rss/:redacted/");
  });

  it("redacts a token-like segment followed by another segment", () => {
    expect(RedactUrlPath("/rss/daily.abc123/extra")).toBe(
      "/rss/:redacted/extra",
    );
  });

  it("redacts an encoded dot", () => {
    expect(RedactUrlPath("/rss/daily%2Eabc123")).toBe("/rss/:redacted");
    expect(RedactUrlPath("/rss/daily%2eabc123")).toBe("/rss/:redacted");
  });

  it("redacts every token-like segment", () => {
    expect(RedactUrlPath("/rss/daily.abc/other.def")).toBe(
      "/rss/:redacted/:redacted",
    );
  });

  it("leaves paths without token-like segments unchanged", () => {
    for (const urlPath of [
      "/does-not-exist",
      "/",
      "",
      "/rss/",
      "/rss/opml",
      "/rss/thedaily",
      "/view/11111111-1111-4111-8111-111111111111",
      "/api/feeds",
    ]) {
      expect(RedactUrlPath(urlPath)).toBe(urlPath);
    }
  });

  it("keeps dot and dot-dot segments", () => {
    expect(RedactUrlPath("/a/./b/../c")).toBe("/a/./b/../c");
  });
});

describe("RequestSpanPathGet", () => {
  it("prefers the matched route template over the raw path", () => {
    const request = {
      routeOptions: { url: "/rss/:id" },
      url: "/rss/daily.abc123?format=json",
    } as never;
    expect(RequestSpanPathGet(request)).toBe("/rss/:id");
  });

  it("falls back to the redacted query-less path when no route matched", () => {
    const request = {
      routeOptions: { url: undefined },
      url: "/rss/daily.abc123/extra?format=json",
    } as never;
    expect(RequestSpanPathGet(request)).toBe("/rss/:redacted/extra");
  });
});
