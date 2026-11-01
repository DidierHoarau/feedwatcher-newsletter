import { FastifyInstance, FastifyRequest } from "fastify";
import { OTelRequestSpan } from "@devopsplaybook.io/otel-utils-fastify";

export const URL_PATH_ATTRIBUTE = "url.path";
export const REDACTED_PATH_SEGMENT = ":redacted";

// Feed URLs carry their capability token as the last dotted segment
// (<feedId>.<token>). Redact every segment that contains a dot or an encoded
// dot so a malformed or unmatched request cannot leak the token through the
// raw request path. Over-redacting a dotted segment is harmless for telemetry.
function isTokenLikeSegment(segment: string): boolean {
  return /\.|%2e/i.test(segment);
}

export function RedactUrlPath(urlPath: string): string {
  return urlPath
    .split("/")
    .map((segment) =>
      segment !== "." && segment !== ".." && isTokenLikeSegment(segment)
        ? REDACTED_PATH_SEGMENT
        : segment,
    )
    .join("/");
}

// Matched routes expose their template in routeOptions.url (e.g. "/rss/:id"),
// which never contains a token. Unmatched requests fall back to the redacted
// raw path without the query string.
export function RequestSpanPathGet(request: FastifyRequest): string {
  const routeTemplate = request.routeOptions?.url;
  if (routeTemplate) {
    return routeTemplate;
  }
  return RedactUrlPath(request.url.split("?")[0]);
}

// The tracing library records the raw request path as url.path in its own
// onRequest hook. This hook is registered after it and before the
// encapsulated access-control hook, so it overwrites the attribute for every
// traced request (including early 401s) before the span is exported.
export function UrlPathRedactionRegisterHook(fastify: FastifyInstance): void {
  fastify.addHook("onRequest", async (request) => {
    const span = OTelRequestSpan(request);
    if (!span) return;
    span.setAttribute(URL_PATH_ATTRIBUTE, RequestSpanPathGet(request));
  });
}
