import { createHash, timingSafeEqual } from "crypto";
import { FastifyInstance } from "fastify";
import { Config } from "../Config";

const REALM = 'Basic realm="feedwatcher-newsletter", charset="UTF-8"';

export function AccessControlIsEnabled(config: Config): boolean {
  return (config.AUTH_PASSWORD || "") !== "";
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Constant-time comparison: hash both values first so neither the content nor
// the length of the expected credentials leaks through timing.
function valueEquals(expected: string, provided: string): boolean {
  return timingSafeEqual(digest(expected), digest(provided));
}

// HTTP Basic credentials: `username:password`, the password may contain `:`.
export function AccessControlIsAuthorized(
  header: string | undefined,
  config: Config,
): boolean {
  if (!header) {
    return false;
  }
  const match = /^Basic\s+(\S+)\s*$/i.exec(header.trim());
  if (!match) {
    return false;
  }
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return false;
  }
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  // Evaluate both comparisons so the timing does not reveal which one failed.
  const usernameOk = valueEquals(config.AUTH_USERNAME, username);
  const passwordOk = valueEquals(config.AUTH_PASSWORD, password);
  return usernameOk && passwordOk;
}

// Encapsulated request hook: registering it on a plugin scope protects only
// the routes of that scope (/ , /rss/* and /view/*), leaving /api/status open.
// When no password is configured the hook returns immediately: behaviour is
// unchanged and existing readers keep working.
export function AccessControlRegisterHook(
  fastify: FastifyInstance,
  config: Config,
): void {
  fastify.addHook("onRequest", async (request, reply) => {
    if (!AccessControlIsEnabled(config)) {
      return;
    }
    if (AccessControlIsAuthorized(request.headers.authorization, config)) {
      return;
    }
    reply.header("WWW-Authenticate", REALM);
    reply.code(401);
    return reply.send({ error: "Unauthorized" });
  });
}
