import { createHash } from "crypto";
import { FastifyInstance } from "fastify";
import { COPY_SCRIPT } from "./HtmlPages";

// Hash-based CSP: the index page's inline script is allowed by its SHA-256
// digest. A hash (not a nonce) keeps the HTML byte-stable, so the ETag/304
// caching added in follow-up 3/5 keeps working.
const COPY_SCRIPT_HASH = createHash("sha256")
  .update(COPY_SCRIPT)
  .digest("base64");

export const HTML_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'sha256-${COPY_SCRIPT_HASH}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src http: https: data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Baseline security headers on every response; the CSP is added to HTML
// representations only (feed/RSS/JSON/OPML payloads do not need it).
export function SecurityHeadersRegisterHook(fastify: FastifyInstance): void {
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    const contentType = String(reply.getHeader("content-type") || "");
    if (contentType.startsWith("text/html")) {
      reply.header("Content-Security-Policy", HTML_CONTENT_SECURITY_POLICY);
    }
    return payload;
  });
}
