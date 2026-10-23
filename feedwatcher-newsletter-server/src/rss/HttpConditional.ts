import { createHash } from "crypto";
import { FastifyReply, FastifyRequest } from "fastify";

// Strong validator derived from the identity (uncompressed) response body:
// any content change changes the ETag, so append, purge and feed-identity
// changes invalidate cached responses automatically.
export function HttpConditionalEtag(body: string): string {
  const digest = createHash("sha256").update(body).digest("base64url");
  return `"${digest.slice(0, 32)}"`;
}

// RFC 9110 evaluation: If-None-Match takes precedence over If-Modified-Since;
// entity tags are compared weakly (W/"x" matches "x"). Last-Modified compares
// at second granularity, otherwise a client echoing the header it just
// received would never get a 304.
export function HttpConditionalIsNotModified(
  request: FastifyRequest,
  etag: string,
  lastModifiedMs: number,
): boolean {
  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch !== undefined) {
    const header = Array.isArray(ifNoneMatch)
      ? ifNoneMatch.join(",")
      : ifNoneMatch;
    if (header.trim() === "*") {
      return true;
    }
    return header.split(",").some((candidate) => {
      const value = candidate.trim();
      return value === etag || value.replace(/^W\//, "") === etag;
    });
  }
  const ifModifiedSince = request.headers["if-modified-since"];
  if (ifModifiedSince !== undefined) {
    const since = Date.parse(
      Array.isArray(ifModifiedSince) ? ifModifiedSince[0] : ifModifiedSince,
    );
    if (!Number.isNaN(since)) {
      return Math.floor(lastModifiedMs / 1000) * 1000 <= since;
    }
  }
  return false;
}

export interface ConditionalResponse {
  body: string;
  contentType: string;
  lastModifiedMs: number;
  extraHeaders?: Record<string, string>;
}

// Send a body with validators, or a bodyless 304 when the client's copy is
// still current. Validators stay present on the 304 response.
export function HttpConditionalSend(
  request: FastifyRequest,
  reply: FastifyReply,
  response: ConditionalResponse,
): FastifyReply {
  const etag = HttpConditionalEtag(response.body);
  reply.header("ETag", etag);
  reply.header("Last-Modified", new Date(response.lastModifiedMs).toUTCString());
  reply.header("Cache-Control", "private, no-cache");
  for (const [name, value] of Object.entries(response.extraHeaders || {})) {
    reply.header(name, value);
  }
  if (HttpConditionalIsNotModified(request, etag, response.lastModifiedMs)) {
    reply.code(304);
    return reply.send();
  }
  reply.header("Content-Type", response.contentType);
  return reply.send(response.body);
}
