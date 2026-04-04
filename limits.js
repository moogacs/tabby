/**
 * Safety limits — many Chrome windows + tabs can exhaust RAM and freeze the system.
 * Tune in one place (loaded by popup + background via importScripts).
 */

/**
 * Per batch: Apply splits work into multiple batches so each step stays bounded.
 * Keep MAX_TABS_PER_CATEGORY_WINDOW ≤ MAX_TABS_PER_APPLY so one window fits one batch.
 */
const MAX_WINDOWS_PER_APPLY = 32;

/** Max tabs moved per batch (not total job — large jobs use many batches). */
const MAX_TABS_PER_APPLY = 350;

/** Pause between creating each window (ms) to reduce CPU/RAM spikes. */
const APPLY_THROTTLE_MS_BETWEEN_WINDOWS = 450;

/** Extra pause between batches (ms) so memory can settle. */
const APPLY_BATCH_PAUSE_MS = 900;

/** Max movable tabs to classify per Preview (keeps preview memory/time bounded). */
const MAX_ORGANIZE_TABS_CLASSIFY = 2500;

/** Tabs per window when splitting a category (higher = fewer total windows). */
const MAX_TABS_PER_CATEGORY_WINDOW = 75;

/**
 * @param {{ name: string; tabIds: number[] }[]} groups
 * @param {number} maxWindows
 * @param {number} maxTabs
 * @returns {{ name: string; tabIds: number[] }[][]}
 */
function splitOrganizeGroupsIntoBatches(groups, maxWindows, maxTabs) {
  const withTabs = groups.filter((g) => g.tabIds.some((id) => id != null));
  /** @type {{ name: string; tabIds: number[] }[][]} */
  const batches = [];
  /** @type {{ name: string; tabIds: number[] }[]} */
  let cur = [];
  let tabSum = 0;

  for (const g of withTabs) {
    const n = g.tabIds.filter((id) => id != null).length;
    if (n > maxTabs) {
      console.warn(
        "[Tabby] Window exceeds max tabs per batch; it will run alone.",
        g.name,
        n
      );
    }
    if (cur.length === 0) {
      cur.push(g);
      tabSum = n;
      continue;
    }
    if (cur.length >= maxWindows || tabSum + n > maxTabs) {
      batches.push(cur);
      cur = [g];
      tabSum = n;
    } else {
      cur.push(g);
      tabSum += n;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}
