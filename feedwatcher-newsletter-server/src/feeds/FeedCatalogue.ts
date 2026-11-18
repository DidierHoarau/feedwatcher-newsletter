import { FeedActivityIsQuiet } from "../status/FeedActivity";
import type { IngestionHealthStatus } from "../status/Health";
import { FeedListEntry } from "./FeedListing";

// Contract version: additive fields keep the version, removals, renames and
// type changes bump it.
export const FEED_CATALOGUE_VERSION = 1;

// Stable subset of the ingestion health, shaped for machine consumers: no
// ages (they would churn the body) and no absolute stale deadline.
export interface FeedCatalogueHealth {
  status: IngestionHealthStatus;
  staleAfterSeconds: number;
  quietAfterDays: number;
  lastSuccessfulFetchAt: string | null;
  idle: { enabled: boolean; connected: boolean };
  lastError: string | null;
  storageFresh: boolean;
}

export interface FeedCatalogueEntry {
  feedId: string;
  title: string;
  senderName: string;
  senderEmail: string;
  itemCount: number;
  servedItemCount: number;
  latestDate: string;
  feedUrl: string;
  archiveUrl: string;
  lastEmailAt: string;
  quiet: boolean;
}

// Stable snapshot of the offered feeds. The body is deterministic for a given
// `nowMs`, so the ETag derived from it only changes when the catalogue content
// or the time-dependent `quiet` flag changes.
export function FeedCatalogueBuild(
  entries: FeedListEntry[],
  health: FeedCatalogueHealth,
  nowMs: number = Date.now(),
): string {
  const feeds: FeedCatalogueEntry[] = entries
    .map((entry) => ({
      feedId: entry.feedId,
      title: entry.title,
      senderName: entry.senderName,
      senderEmail: entry.senderEmail,
      itemCount: entry.itemCount,
      servedItemCount: entry.servedItemCount,
      latestDate: entry.latestDate,
      feedUrl: entry.feedUrl,
      archiveUrl: entry.archiveUrl,
      lastEmailAt: entry.latestDate,
      quiet: FeedActivityIsQuiet(entry.latestDate, nowMs),
    }))
    .sort(
      (a, b) =>
        a.title.localeCompare(b.title) || a.feedId.localeCompare(b.feedId),
    );
  return JSON.stringify({
    version: FEED_CATALOGUE_VERSION,
    health,
    feeds,
  });
}
