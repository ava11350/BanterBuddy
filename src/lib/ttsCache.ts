/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface CachedTTSQuery {
  id: string; // `${voice}:::${text.trim()}`
  text: string;
  voice: string;
  audioUrl: string; // Blob URL
  timestamp: number;
}

const MAX_CACHE_SIZE = 5;
const cache: CachedTTSQuery[] = [];
const listeners: Array<(items: CachedTTSQuery[]) => void> = [];

/**
 * Retrieves cached audio URL for the given text and voice if present in the 5-item rolling window.
 * If found, moves it to the most recent position and updates timestamp.
 */
export function getCachedTTSAudio(text: string, voice: string): string | null {
  const key = `${voice}:::${text.trim()}`;
  const index = cache.findIndex(item => item.id === key);
  if (index !== -1) {
    const item = cache[index];
    // Move to end (most recent)
    cache.splice(index, 1);
    item.timestamp = Date.now();
    cache.push(item);
    notifyListeners();
    return item.audioUrl;
  }
  return null;
}

/**
 * Checks if a specific text is already cached in the rolling window.
 */
export function isTextCached(text: string, voice?: string): boolean {
  const trimmed = text.trim();
  if (voice) {
    return cache.some(item => item.id === `${voice}:::${trimmed}`);
  }
  return cache.some(item => item.text.trim() === trimmed);
}

/**
 * Stores a new TTS audio URL in the rolling cache (max 5 items).
 * Evicts the oldest item and revokes its Blob URL to prevent memory leaks during long streams.
 */
export function storeCachedTTSAudio(text: string, voice: string, audioUrl: string): void {
  const key = `${voice}:::${text.trim()}`;
  const existingIndex = cache.findIndex(item => item.id === key);

  if (existingIndex !== -1) {
    const existing = cache[existingIndex];
    if (existing.audioUrl !== audioUrl) {
      try {
        URL.revokeObjectURL(existing.audioUrl);
      } catch (e) {
        console.warn("Failed to revoke old object URL", e);
      }
    }
    cache.splice(existingIndex, 1);
  } else if (cache.length >= MAX_CACHE_SIZE) {
    // Evict oldest item to maintain strictly the 5 most recent queries
    const evicted = cache.shift();
    if (evicted) {
      try {
        URL.revokeObjectURL(evicted.audioUrl);
      } catch (e) {
        console.warn("Failed to revoke evicted object URL", e);
      }
    }
  }

  cache.push({
    id: key,
    text: text.trim(),
    voice,
    audioUrl,
    timestamp: Date.now()
  });

  notifyListeners();
}

/**
 * Returns a list of cached queries ordered from most recent to oldest.
 */
export function getRecentTTSCache(): CachedTTSQuery[] {
  return [...cache].reverse();
}

/**
 * Clears the cache and revokes all active Blob URLs to free memory.
 */
export function clearTTSCache(): void {
  while (cache.length > 0) {
    const item = cache.pop();
    if (item) {
      try {
        URL.revokeObjectURL(item.audioUrl);
      } catch (e) {
        console.warn("Failed to revoke object URL on clear", e);
      }
    }
  }
  notifyListeners();
}

/**
 * Subscribes to rolling cache updates for UI synchronization.
 */
export function subscribeTTSCache(listener: (items: CachedTTSQuery[]) => void): () => void {
  listeners.push(listener);
  listener(getRecentTTSCache());
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

function notifyListeners() {
  const items = getRecentTTSCache();
  listeners.forEach(l => {
    try {
      l(items);
    } catch (err) {
      console.error("Error notifying TTS cache listener", err);
    }
  });
}
