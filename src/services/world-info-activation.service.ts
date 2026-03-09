import type { WorldBookEntry } from "../types/world-book";
import type { WorldInfoCache } from "../types/world-book";
import type { Message } from "../types/message";

/**
 * Per-entry sticky/cooldown/delay tracking state, stored in chat.metadata.wi_state.
 * Keyed by entry UID.
 */
export interface WiEntryState {
  stickyLeft: number;   // turns remaining while sticky-active after keywords stop matching
  cooldownLeft: number; // turns remaining before re-activation allowed
  delayCount: number;   // consecutive turns keyword matched (for delay threshold)
  active: boolean;      // currently contributing to prompt
}

export type WiState = Record<string, WiEntryState>;

export interface ActivationInput {
  entries: WorldBookEntry[];
  messages: Message[];
  chatTurn: number;           // current turn number (messages.length)
  wiState: WiState;           // mutable — updated in place
}

export interface ActivationResult {
  cache: WorldInfoCache;
  activatedEntries: WorldBookEntry[];
  wiState: WiState;
}

/** Hoisted escaping regex — compiled once at module level. */
const REGEX_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * Run full World Info activation pipeline.
 *
 * Order: filter disabled → separate constants → keyword match → selective logic →
 * probability → sticky/cooldown/delay → group logic → sort → bucket by position.
 */
export function activateWorldInfo(input: ActivationInput): ActivationResult {
  const { entries, messages, wiState } = input;

  // 0. Cleanup wiState: Remove any keys that are no longer in the candidates list.
  // This prevents hidden sticky/active entries from persisting after a lorebook is removed.
  const entryUids = new Set(entries.map(e => e.uid));
  for (const uid in wiState) {
    if (!entryUids.has(uid)) {
      delete wiState[uid];
    }
  }

  // 1. Filter disabled entries
  const candidates = entries.filter(e => !e.disabled);

  // 2. Separate constants (always activate)
  const constants: WorldBookEntry[] = [];
  const conditional: WorldBookEntry[] = [];
  for (const e of candidates) {
    if (e.constant) constants.push(e);
    else conditional.push(e);
  }

  // 3. Evaluate conditional entries
  const activated: WorldBookEntry[] = [...constants];

  const blockedByCooldown = new Set<string>();
  const matchedThisTurn = new Set<string>();
  const delayIncremented = new Set<string>();

  for (const entry of conditional) {
    const state = getOrInitState(wiState, entry);
    if (state.cooldownLeft > 0) {
      state.cooldownLeft--;
      state.active = false;
      blockedByCooldown.add(entry.uid);
    }
  }

  const activatedUids = new Set<string>();
  for (const entry of constants) {
    activatedUids.add(entry.uid);
  }

  const recursionSourceParts: string[] = [];
  for (const entry of constants) {
    if (entry.content && !entry.exclude_recursion) recursionSourceParts.push(entry.content);
  }

  // Per-activation-cycle caches
  const regexCache = new Map<string, RegExp | null>();
  const scanTextCache = new Map<string, string>();

  const MAX_RECURSION_PASSES = 3;
  for (let pass = 0; pass <= MAX_RECURSION_PASSES; pass++) {
    let activatedThisPass = false;
    const recursionText = recursionSourceParts.join("\n");

    // Clear scan text cache between passes (recursionText grows)
    scanTextCache.clear();

    for (const entry of conditional) {
      if (activatedUids.has(entry.uid)) continue;
      if (blockedByCooldown.has(entry.uid)) continue;
      if (pass === 0 && entry.delay_until_recursion) continue;
      if (pass > 0 && entry.prevent_recursion) continue;

      const state = getOrInitState(wiState, entry);

      // Entries with no keys cannot match via keyword — they are left for
      // vector retrieval (or should be marked as constant if always-on).
      if (entry.key.length === 0) continue;

      const scanText = cachedBuildScanText(scanTextCache, messages, entry.scan_depth, recursionText);

      const primaryMatch = entry.key.some(k =>
        matchesKey(k, scanText, entry.case_sensitive, entry.match_whole_words, entry.use_regex, regexCache)
      );
      if (!primaryMatch) continue;

      if (entry.selective && entry.keysecondary.length > 0) {
        const secondaryPass = checkSecondaryKeys(
          entry.keysecondary,
          scanText,
          entry.case_sensitive,
          entry.match_whole_words,
          entry.use_regex,
          entry.selective_logic,
          regexCache,
        );
        if (!secondaryPass) continue;
      }

      matchedThisTurn.add(entry.uid);

      if (entry.delay > 0 && !delayIncremented.has(entry.uid)) {
        state.delayCount++;
        delayIncremented.add(entry.uid);
      }
      if (entry.delay > 0 && state.delayCount < entry.delay) {
        continue;
      }

      if (entry.use_probability && entry.probability < 100) {
        if (Math.random() * 100 >= entry.probability) {
          continue;
        }
      }

      state.active = true;
      state.delayCount = 0;
      if (entry.sticky > 0) state.stickyLeft = entry.sticky;

      activated.push(entry);
      activatedUids.add(entry.uid);
      activatedThisPass = true;
      if (entry.content && !entry.exclude_recursion) recursionSourceParts.push(entry.content);
    }

    if (!activatedThisPass) break;
  }

  for (const entry of conditional) {
    if (activatedUids.has(entry.uid)) continue;
    if (blockedByCooldown.has(entry.uid)) continue;
    if (matchedThisTurn.has(entry.uid)) continue;
    const state = getOrInitState(wiState, entry);
    handleNoMatch(state, entry);
  }

  // Also re-activate sticky entries that are still in their sticky window
  for (const entry of conditional) {
    if (activated.includes(entry)) continue;
    const state = wiState[entry.uid];
    if (state && state.stickyLeft > 0) {
      state.stickyLeft--;
      state.active = true;
      activated.push(entry);
      // When sticky expires, start cooldown
      if (state.stickyLeft === 0 && entry.cooldown > 0) {
        state.cooldownLeft = entry.cooldown;
      }
    }
  }

  // 4. Group logic — entries with same group_name compete
  const afterGroups = applyGroupLogic(activated);

  // 5. Sort by priority (desc), then order_value (asc)
  afterGroups.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.order_value - b.order_value;
  });

  // 6. Bucket by position into WorldInfoCache
  const cache = bucketByPosition(afterGroups);

  return { cache, activatedEntries: afterGroups, wiState };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOrInitState(wiState: WiState, entry: WorldBookEntry): WiEntryState {
  if (!wiState[entry.uid]) {
    wiState[entry.uid] = { stickyLeft: 0, cooldownLeft: 0, delayCount: 0, active: false };
  }
  return wiState[entry.uid];
}

function handleNoMatch(state: WiEntryState, entry: WorldBookEntry): void {
  // If was previously active with sticky, let sticky handler deal with it
  if (state.active && state.stickyLeft <= 0) {
    state.active = false;
    state.delayCount = 0;
  }
  // Reset delay count on non-match (must be consecutive)
  if (entry.delay > 0) {
    state.delayCount = 0;
  }
}

function buildScanText(messages: Message[], scanDepth: number | null, recursionText = ""): string {
  const base = (() => {
    if (scanDepth === null || scanDepth <= 0) {
      return messages.map(m => m.content).join("\n");
    }
    const slice = messages.slice(-scanDepth);
    return slice.map(m => m.content).join("\n");
  })();

  if (!recursionText) return base;
  if (!base) return recursionText;
  return `${base}\n${recursionText}`;
}

/** Cache scan text by scan_depth within a single pass (same recursionText). */
function cachedBuildScanText(
  cache: Map<string, string>,
  messages: Message[],
  scanDepth: number | null,
  recursionText: string,
): string {
  const cacheKey = String(scanDepth);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = buildScanText(messages, scanDepth, recursionText);
  cache.set(cacheKey, result);
  return result;
}

/** Get or create a cached regex. Returns null for invalid patterns. */
function getCachedRegex(cache: Map<string, RegExp | null>, pattern: string, flags: string): RegExp | null {
  const cacheKey = `${pattern}|${flags}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;
  try {
    const regex = new RegExp(pattern, flags);
    cache.set(cacheKey, regex);
    return regex;
  } catch {
    cache.set(cacheKey, null);
    return null;
  }
}

/**
 * Match a single key against the scan text.
 */
export function matchesKey(
  key: string,
  text: string,
  caseSensitive: boolean,
  wholeWords: boolean,
  useRegex: boolean,
  regexCache?: Map<string, RegExp | null>,
): boolean {
  if (!key) return false;

  if (useRegex) {
    const flags = caseSensitive ? "g" : "gi";
    const regex = regexCache
      ? getCachedRegex(regexCache, key, flags)
      : (() => { try { return new RegExp(key, flags); } catch { return null; } })();
    if (!regex) return false;
    regex.lastIndex = 0;
    return regex.test(text);
  }

  let searchKey = key;
  let searchText = text;
  if (!caseSensitive) {
    searchKey = key.toLowerCase();
    searchText = text.toLowerCase();
  }

  if (wholeWords) {
    const escaped = searchKey.replace(REGEX_ESCAPE_PATTERN, "\\$&");
    const flags = caseSensitive ? "g" : "gi";
    const pattern = `\\b${escaped}\\b`;
    const regex = regexCache
      ? getCachedRegex(regexCache, pattern, flags)
      : new RegExp(pattern, flags);
    if (!regex) return false;
    regex.lastIndex = 0;
    return regex.test(text);
  }

  return searchText.includes(searchKey);
}

/**
 * Check secondary keys based on selective_logic:
 *  0 = AND (all must match)
 *  1 = NOT (none should match)
 *  2 = OR  (at least one must match)
 *  3 = NOT All (fail only if all keys match)
 */
function checkSecondaryKeys(
  keys: string[],
  text: string,
  caseSensitive: boolean,
  wholeWords: boolean,
  useRegex: boolean,
  logic: number,
  regexCache?: Map<string, RegExp | null>,
): boolean {
  if (keys.length === 0) return true;

  switch (logic) {
    case 0: // AND
      return keys.every(k => matchesKey(k, text, caseSensitive, wholeWords, useRegex, regexCache));
    case 1: // NOT
      return keys.every(k => !matchesKey(k, text, caseSensitive, wholeWords, useRegex, regexCache));
    case 2: // OR
      return keys.some(k => matchesKey(k, text, caseSensitive, wholeWords, useRegex, regexCache));
    case 3: // NOT All
      return !keys.every(k => matchesKey(k, text, caseSensitive, wholeWords, useRegex, regexCache));
    default:
      return true;
  }
}

/**
 * Apply group logic: entries with the same group_name compete.
 * - group_override: highest priority entry wins
 * - Otherwise: weighted random selection by group_weight
 */
function applyGroupLogic(entries: WorldBookEntry[]): WorldBookEntry[] {
  const grouped = new Map<string, WorldBookEntry[]>();
  const ungrouped: WorldBookEntry[] = [];

  for (const entry of entries) {
    if (entry.group_name) {
      const list = grouped.get(entry.group_name) || [];
      list.push(entry);
      grouped.set(entry.group_name, list);
    } else {
      ungrouped.push(entry);
    }
  }

  const result = [...ungrouped];

  for (const [, group] of grouped) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Check for override entries
    const overrides = group.filter(e => e.group_override);
    if (overrides.length > 0) {
      // Highest priority override wins
      overrides.sort((a, b) => b.priority - a.priority);
      result.push(overrides[0]);
      continue;
    }

    // Weighted random selection
    const totalWeight = group.reduce((sum, e) => sum + (e.group_weight || 1), 0);
    if (totalWeight <= 0) {
      result.push(group[0]);
      continue;
    }

    let roll = Math.random() * totalWeight;
    for (const entry of group) {
      roll -= entry.group_weight || 1;
      if (roll <= 0) {
        result.push(entry);
        break;
      }
    }
  }

  return result;
}

/**
 * Bucket activated entries into WorldInfoCache positions:
 *  0 = before, 1 = after, 2 = AN before, 3 = AN after,
 *  4 = depth-based, 5 = EM before, 6 = EM after
 */
function bucketByPosition(entries: WorldBookEntry[]): WorldInfoCache {
  const cache: WorldInfoCache = {
    before: [],
    after: [],
    anBefore: [],
    anAfter: [],
    depth: [],
    emBefore: [],
    emAfter: [],
  };

  for (const entry of entries) {
    const content = entry.content;
    if (!content) continue;
    const role = normalizeRole(entry.role);

    switch (entry.position) {
      case 0:
        cache.before.push({ content, role });
        break;
      case 1:
        cache.after.push({ content, role });
        break;
      case 2:
        cache.anBefore.push({ content, role });
        break;
      case 3:
        cache.anAfter.push({ content, role });
        break;
      case 4:
        cache.depth.push({
          content,
          depth: entry.depth,
          role,
        });
        break;
      case 5:
        cache.emBefore.push({ content, role });
        break;
      case 6:
        cache.emAfter.push({ content, role });
        break;
      default:
        // Unknown position — treat as "before"
        cache.before.push({ content, role });
        break;
    }
  }

  return cache;
}

function normalizeRole(role: string | null): "system" | "user" | "assistant" {
  if (role === "user" || role === "assistant") return role;
  return "system";
}
