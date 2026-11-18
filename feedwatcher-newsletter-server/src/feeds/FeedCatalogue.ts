import { FeedListEntry } from "./FeedListing";

// Contract version: additive fields keep the version, removals, renames and
// type changes bump it.
export const FEED_CATALOGUE_VERSION = 1;

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
}

// Stable snapshot of the offered feeds. The body is deterministic so the ETag
// derived from it only changes when the catalogue content changes.
export function FeedCatalogueBuild(entries: FeedListEntry[]): string {
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
    }))
    .sort(
      (a, b) =>
        a.title.localeCompare(b.title) || a.feedId.localeCompare(b.feedId),
    );
  return JSON.stringify({ version: FEED_CATALOGUE_VERSION, feeds });
}
