import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { FastifyInstance } from "fastify";
import { Config } from "../Config";
import {
  EmailFeedsListAllForManagement,
  FeedManagementSummary,
} from "../emails/EmailsData";
import {
  FeedSetting,
  FeedSettingsGet,
  FeedSettingsSave,
  FeedSettingsValidationError,
  SenderRule,
} from "../feeds/FeedSettings";
import { OTelLogger, OTelRunWithRequestContext } from "../OTelContext";
import { SchedulerOnFeedSettingsChanged } from "../Scheduler";
import {
  ManageFeedRow,
  ManagePageModel,
  ManageSenderRow,
  renderManagePage,
} from "../rss/HtmlPages";

const logger = OTelLogger().createModuleLogger("FeedSettingsRoutes");

const FORM_BODY_LIMIT_BYTES = 256 * 1024;
const CSRF_HEADER = "x-feedwatcher-csrf";
const BLANK_SENDER_ROWS = 3;

// Process-local form token: single-instance deployments are the supported
// form UI (the documented assumption). The JSON API uses a stateless custom
// header, so multi-replica deployments can still write through /api.
const FORM_CSRF_TOKEN = randomBytes(32).toString("hex");

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function formTokenEquals(provided: string): boolean {
  if (!provided) return false;
  return timingSafeEqual(digest(FORM_CSRF_TOKEN), digest(provided));
}

// Parse the tri-state privacy/visibility select: blank means inherit (the field
// is omitted), otherwise the literal true/false.
function parseBooleanField(
  value: string,
): boolean | string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  // Pass the raw value through so strict validation reports the field path.
  return value;
}

function parseMaxItemsField(value: string): number | string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return value;
}

function feedIdFromManagement(
  feed: FeedManagementSummary,
  configured: FeedSetting | undefined,
): ManageFeedRow {
  return {
    feedId: feed.feedId,
    titlePlaceholder: feed.title,
    senderEmail: feed.senderEmail,
    itemCount: feed.itemCount,
    hidden: feed.hidden,
    mergedInto: feed.mergedInto,
    setting: configured ?? {},
  };
}

// Every base feed (including hidden and merged sources) plus settings-only
// feeds and merge targets: a full form submit therefore never drops curation.
function buildManageFeedRows(): ManageFeedRow[] {
  const settings = FeedSettingsGet();
  const rows = new Map<string, ManageFeedRow>();
  for (const feed of EmailFeedsListAllForManagement()) {
    rows.set(feed.feedId, feedIdFromManagement(feed, settings.feeds[feed.feedId]));
  }
  for (const [feedId, entry] of Object.entries(settings.feeds)) {
    if (!rows.has(feedId)) {
      rows.set(feedId, {
        feedId,
        titlePlaceholder: entry.title ?? feedId,
        hidden: entry.hidden === true,
        mergedInto: entry.mergeInto,
        setting: entry,
      });
    }
  }
  for (const entry of Object.values(settings.feeds)) {
    if (entry.mergeInto && !rows.has(entry.mergeInto)) {
      const target = settings.feeds[entry.mergeInto];
      rows.set(entry.mergeInto, {
        feedId: entry.mergeInto,
        titlePlaceholder: target?.title ?? entry.mergeInto,
        hidden: target?.hidden === true,
        mergedInto: target?.mergeInto,
        setting: target ?? {},
      });
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.titlePlaceholder.localeCompare(b.titlePlaceholder) ||
      a.feedId.localeCompare(b.feedId),
  );
}

function buildManageSenderRows(): ManageSenderRow[] {
  const settings = FeedSettingsGet();
  const rows: ManageSenderRow[] = Object.entries(settings.senders)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([match, rule]) => ({
      match,
      feedId: rule.feedId,
      title: rule.title,
    }));
  for (let index = 0; index < BLANK_SENDER_ROWS; index++) {
    rows.push({ match: "" });
  }
  return rows;
}

function buildManagePage(config: Config, saved: boolean, error?: string): string {
  const model: ManagePageModel = {
    csrfToken: FORM_CSRF_TOKEN,
    feeds: buildManageFeedRows(),
    senders: buildManageSenderRows(),
    defaults: {
      maxItems: config.FEED_MAX_ITEMS,
      blockRemoteImages: config.EMAIL_BLOCK_REMOTE_IMAGES,
      stripTrackingPixels: config.EMAIL_STRIP_TRACKING_PIXELS,
    },
    saved,
    error,
  };
  return renderManagePage(model);
}

const FEED_FIELD_PATTERN =
  /^feed\.(.+)\.(title|hidden|maxItems|blockRemoteImages|stripTrackingPixels|mergeInto)$/;
const SENDER_FIELD_PATTERN = /^sender\.(\d+)\.(match|feedId|title)$/;

function formToDocument(values: URLSearchParams): Record<string, unknown> {
  const feeds: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of values.entries()) {
    const match = FEED_FIELD_PATTERN.exec(key);
    if (!match) continue;
    const [, feedId, field] = match;
    const entry = feeds[feedId] ?? (feeds[feedId] = {});
    if (field === "title" || field === "mergeInto") {
      const trimmed = value.trim();
      if (trimmed !== "") entry[field] = value;
      continue;
    }
    if (field === "maxItems") {
      const parsed = parseMaxItemsField(value);
      if (parsed !== undefined) entry.maxItems = parsed;
      continue;
    }
    const parsed = parseBooleanField(value);
    if (parsed !== undefined) entry[field] = parsed;
  }

  const senderRows = new Map<number, { match: string; feedId: string; title: string }>();
  for (const [key, value] of values.entries()) {
    const match = SENDER_FIELD_PATTERN.exec(key);
    if (!match) continue;
    const index = Number(match[1]);
    const row = senderRows.get(index) ?? {
      match: "",
      feedId: "",
      title: "",
    };
    row[match[2] as "match" | "feedId" | "title"] = value;
    senderRows.set(index, row);
  }
  const senders: Record<string, SenderRule> = {};
  for (const [index, row] of [...senderRows.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const match = row.match.trim();
    const feedId = row.feedId.trim();
    const title = row.title.trim();
    if (match === "") {
      if (feedId !== "" || title !== "") {
        throw new FeedSettingsValidationError([
          `senders.${index}.match: a sender match is required when a feed id or title is set`,
        ]);
      }
      continue;
    }
    const rule: SenderRule = {};
    if (feedId !== "") rule.feedId = feedId;
    if (title !== "") rule.title = title;
    senders[match] = rule;
  }

  return { version: 1, feeds, senders };
}

export class FeedSettingsRoutes {
  constructor(private config: Config) {}

  public getRoutes = async (fastify: FastifyInstance) => {
    // Fastify has no built-in form parser; URLSearchParams keeps this
    // dependency-free. The parser is scoped to this plugin instance.
    if (!fastify.hasContentTypeParser("application/x-www-form-urlencoded")) {
      fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string", bodyLimit: FORM_BODY_LIMIT_BYTES },
        (_request, body, done) => {
          try {
            done(null, new URLSearchParams(body as string));
          } catch (err) {
            done(err as Error);
          }
        },
      );
    }

    fastify.get("/api/feeds/settings", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        reply.header("Cache-Control", "no-store");
        return reply.send(FeedSettingsGet());
      }),
    );

    // Full-document replace. The custom header is required: a cross-site form
    // cannot set it, so the write is not CSRF-able even when auth is disabled.
    fastify.put("/api/feeds/settings", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        reply.header("Cache-Control", "no-store");
        const contentType = String(request.headers["content-type"] || "")
          .trim()
          .toLowerCase();
        if (!contentType.startsWith("application/json")) {
          reply.code(415);
          return reply.send({
            error: "Content-Type must be application/json",
          });
        }
        if (request.headers[CSRF_HEADER] !== "1") {
          reply.code(403);
          return reply.send({
            error: `Missing ${CSRF_HEADER}: 1 header`,
          });
        }
        try {
          FeedSettingsSave(request.body);
        } catch (err) {
          if (err instanceof FeedSettingsValidationError) {
            reply.code(400);
            return reply.send({
              error: "Invalid feed settings",
              details: err.errors,
            });
          }
          logger.error("Failed to save feed settings", err as Error);
          reply.code(500);
          return reply.send({ error: "Failed to save feed settings" });
        }
        SchedulerOnFeedSettingsChanged();
        return reply.send(FeedSettingsGet());
      }),
    );

    fastify.get("/manage", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        reply.header("Cache-Control", "no-store");
        reply.header("Content-Type", "text/html; charset=utf-8");
        const saved =
          (request.query as Record<string, unknown>)?.saved === "1";
        return reply.send(buildManagePage(this.config, saved));
      }),
    );

    fastify.post("/manage", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        reply.header("Cache-Control", "no-store");
        const values =
          request.body instanceof URLSearchParams
            ? request.body
            : new URLSearchParams();
        if (!formTokenEquals(values.get("csrf") ?? "")) {
          reply.code(403);
          return reply.send({ error: "Invalid CSRF token" });
        }
        reply.header("Content-Type", "text/html; charset=utf-8");
        try {
          FeedSettingsSave(formToDocument(values));
        } catch (err) {
          const message =
            err instanceof FeedSettingsValidationError
              ? err.errors.join("; ")
              : `The settings could not be saved: ${(err as Error).message}`;
          if (!(err instanceof FeedSettingsValidationError)) {
            logger.error("Failed to save feed settings form", err as Error);
          }
          reply.code(
            err instanceof FeedSettingsValidationError ? 400 : 500,
          );
          return reply.send(buildManagePage(this.config, false, message));
        }
        SchedulerOnFeedSettingsChanged();
        reply.code(303);
        reply.header("Location", "/manage?saved=1");
        return reply.send();
      }),
    );
  };
}
