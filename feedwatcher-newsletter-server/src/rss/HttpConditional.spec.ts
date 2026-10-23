import { FastifyRequest } from "fastify";
import {
  HttpConditionalEtag,
  HttpConditionalIsNotModified,
} from "./HttpConditional";

function makeRequest(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe("HttpConditionalEtag", () => {
  it("is a strong, quoted, content-derived validator", () => {
    const etag = HttpConditionalEtag("<rss>body</rss>");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(HttpConditionalEtag("<rss>body</rss>")).toBe(etag);
    expect(HttpConditionalEtag("<rss>other</rss>")).not.toBe(etag);
  });
});

describe("HttpConditionalIsNotModified", () => {
  const etag = '"abc123"';
  const lastModifiedMs = Date.parse("2026-10-22T10:00:00.000Z");

  it("matches a single, listed, weak or wildcard If-None-Match", () => {
    const matches = (header: string): boolean =>
      HttpConditionalIsNotModified(
        makeRequest({ "if-none-match": header }),
        etag,
        lastModifiedMs,
      );
    expect(matches('"abc123"')).toBe(true);
    expect(matches('"other", "abc123"')).toBe(true);
    expect(matches(`W/${etag}`)).toBe(true);
    expect(matches("*")).toBe(true);
    expect(matches('"other"')).toBe(false);
    expect(matches(`W/"other"`)).toBe(false);
  });

  it("compares If-Modified-Since at second granularity", () => {
    const check = (header: string): boolean =>
      HttpConditionalIsNotModified(
        makeRequest({ "if-modified-since": header }),
        etag,
        lastModifiedMs,
      );
    expect(check(new Date(lastModifiedMs).toUTCString())).toBe(true);
    expect(check(new Date(lastModifiedMs + 999).toUTCString())).toBe(true);
    expect(check(new Date(lastModifiedMs - 1000).toUTCString())).toBe(false);
    expect(check("not a date")).toBe(false);
  });

  it("gives If-None-Match precedence over If-Modified-Since", () => {
    const request = makeRequest({
      "if-none-match": '"stale"',
      "if-modified-since": new Date(lastModifiedMs).toUTCString(),
    });
    expect(HttpConditionalIsNotModified(request, etag, lastModifiedMs)).toBe(false);
  });

  it("returns false without validators", () => {
    expect(
      HttpConditionalIsNotModified(makeRequest({}), etag, lastModifiedMs),
    ).toBe(false);
  });
});
