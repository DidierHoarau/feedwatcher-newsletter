import { HtmlSanitizerGetTextSummary, HtmlSanitizerSanitize } from "./HtmlSanitizer";
import type { EmailItem } from "./EmailFetcher";

// Bounded LRU of sanitized email bodies, shared by feed builds and the /view
// pages so a body is sanitized (and summarized) once per sanitizer
// configuration instead of on every poll. The bound keeps the cache far below
// the 1 GiB container limit: entries are accounted as UTF-16 code units, i.e.
// roughly twice their heap footprint.
export const SANITIZED_BODY_CACHE_MAX_BYTES = 32 * 1024 * 1024;

// Bump whenever the sanitizer options change so stale entries are never served.
const CACHE_KEY_VERSION = 2;

export interface SanitizedBody {
  html: string;
  summary: string;
}

interface CacheEntry extends SanitizedBody {
  bytes: number;
}

const cache = new Map<string, CacheEntry>();
let cachedBytes = 0;

// Item id, not messageId: a re-saved message keeps its messageId but carries a
// new body and item id. The sanitizer configuration is part of the key, so
// different configurations never share entries.
function cacheKeyFor(
  itemId: string,
  stripTrackingPixels: boolean,
  blockRemoteImages: boolean,
): string {
  return `${CACHE_KEY_VERSION}|${stripTrackingPixels ? "strip" : "keep"}|${
    blockRemoteImages ? "block" : "allow"
  }|${itemId}`;
}

function evictOldest(): void {
  const oldestKey = cache.keys().next().value;
  if (oldestKey === undefined) return;
  const oldest = cache.get(oldestKey);
  cache.delete(oldestKey);
  if (oldest) {
    cachedBytes -= oldest.bytes;
  }
}

export function SanitizedBodyCacheGet(
  item: EmailItem,
  stripTrackingPixels = true,
  blockRemoteImages = false,
): SanitizedBody {
  const key = cacheKeyFor(item.id, stripTrackingPixels, blockRemoteImages);
  const existing = cache.get(key);
  if (existing) {
    // Map iteration order is insertion order: re-insert on hit to keep the
    // least recently used entries at the front.
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  const html = HtmlSanitizerSanitize(
    item.body,
    stripTrackingPixels,
    blockRemoteImages,
  );
  const summary = HtmlSanitizerGetTextSummary(html);
  const entry: CacheEntry = {
    html,
    summary,
    bytes: (html.length + summary.length) * 2,
  };
  cache.set(key, entry);
  cachedBytes += entry.bytes;
  while (cachedBytes > SANITIZED_BODY_CACHE_MAX_BYTES) {
    evictOldest();
  }
  return entry;
}

export function SanitizedBodyCacheEvict(itemIds: Iterable<string>): void {
  for (const itemId of itemIds) {
    for (const strip of [true, false]) {
      for (const block of [true, false]) {
        const key = cacheKeyFor(itemId, strip, block);
        const entry = cache.get(key);
        if (entry) {
          cache.delete(key);
          cachedBytes -= entry.bytes;
        }
      }
    }
  }
}

export function SanitizedBodyCacheReset(): void {
  cache.clear();
  cachedBytes = 0;
}

export function SanitizedBodyCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cachedBytes };
}
