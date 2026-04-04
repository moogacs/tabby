importScripts("limits.js");

/** Serialize applies so only one runs at a time; newer runId cancels the previous loop. */
let applyChain = Promise.resolve();

/** Debounce badge updates (tabs fire many events while loading). */
let badgeRefreshTimer = null;

/**
 * Same scope as popup "Tab count (excl. chrome://)": real tabs with a URL, not chrome:// pages.
 * @returns {Promise<number>}
 */
async function getTabCountForBadge() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.id != null && t.url && !t.url.startsWith("chrome://")).length;
}

/**
 * Badge text max 4 UTF-16 units (Chrome). Compact large counts.
 * @param {number} n
 * @returns {string}
 */
function formatBadgeCount(n) {
  if (n < 0) return "";
  if (n === 0) return "0";
  if (n < 10000) return String(n);
  if (n < 1000000) return `${Math.floor(n / 1000)}k`;
  return "999k";
}

async function refreshTabCountBadge() {
  try {
    const n = await getTabCountForBadge();
    const text = formatBadgeCount(n);
    await chrome.action.setBadgeText({ text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color: "#2563EB" });
    }
  } catch {
    /* ignore */
  }
}

function scheduleTabCountBadgeRefresh() {
  if (badgeRefreshTimer != null) {
    clearTimeout(badgeRefreshTimer);
  }
  badgeRefreshTimer = setTimeout(() => {
    badgeRefreshTimer = null;
    refreshTabCountBadge();
  }, 120);
}

chrome.runtime.onInstalled.addListener(() => {
  refreshTabCountBadge();
});
chrome.runtime.onStartup?.addListener(() => {
  refreshTabCountBadge();
});

chrome.tabs.onCreated.addListener(scheduleTabCountBadgeRefresh);
chrome.tabs.onRemoved.addListener(scheduleTabCountBadgeRefresh);
chrome.tabs.onMoved.addListener(scheduleTabCountBadgeRefresh);
chrome.tabs.onDetached.addListener(scheduleTabCountBadgeRefresh);
chrome.tabs.onAttached.addListener(scheduleTabCountBadgeRefresh);
chrome.tabs.onReplaced.addListener(scheduleTabCountBadgeRefresh);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url != null) {
    scheduleTabCountBadgeRefresh();
  }
});

refreshTabCountBadge();

/**
 * @param {string} runId
 */
async function isActiveOrganizeRun(runId) {
  const { organizeActiveRunId } = await chrome.storage.session.get("organizeActiveRunId");
  return organizeActiveRunId === runId;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} runId
 */
async function setOrganizeProgress(payload, runId) {
  await chrome.storage.session.set({
    organizeProgress: { ...payload, runId },
  });
}

/**
 * @param {{ name: string; tabIds: number[] }[]} groups
 * @param {string} runId
 */
async function applyOrganizeGroups(groups, runId) {
  if (!(await isActiveOrganizeRun(runId))) {
    await setOrganizeProgress(
      {
        phase: "superseded",
        label: "Stopped — a newer Apply started.",
        windowsDone: 0,
        totalWindows: 0,
        tabsDone: 0,
        totalTabs: 0,
        totalBatches: 0,
        batchIndex: 0,
        currentGroup: "",
      },
      runId
    );
    return { superseded: true };
  }

  const groupsWithTabs = groups.filter((g) => g.tabIds.some((id) => id != null));
  const totalWindows = groupsWithTabs.length;
  const totalTabs = groupsWithTabs.reduce(
    (n, g) => n + g.tabIds.filter((id) => id != null).length,
    0
  );

  const batches = splitOrganizeGroupsIntoBatches(
    groupsWithTabs,
    MAX_WINDOWS_PER_APPLY,
    MAX_TABS_PER_APPLY
  );
  const totalBatches = batches.length;

  await setOrganizeProgress(
    {
      phase: "apply",
      windowsDone: 0,
      totalWindows,
      tabsDone: 0,
      totalTabs,
      totalBatches,
      batchIndex: 1,
      currentGroup: "",
      label:
        totalBatches > 1
          ? `Batch 1 / ${totalBatches} (automatic) · 0 / ${totalWindows} windows`
          : "Starting…",
    },
    runId
  );

  let windowsDone = 0;
  let tabsDone = 0;
  let sinceProgressWrite = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    if (!(await isActiveOrganizeRun(runId))) {
      await setOrganizeProgress(
        {
          phase: "superseded",
          windowsDone,
          totalWindows,
          tabsDone,
          totalTabs,
          totalBatches,
          batchIndex: bi + 1,
          currentGroup: "",
          label: "Stopped — a newer Apply replaced this run.",
        },
        runId
      );
      return { superseded: true };
    }

    if (bi > 0 && APPLY_BATCH_PAUSE_MS > 0) {
      await setOrganizeProgress(
        {
          phase: "apply",
          windowsDone,
          totalWindows,
          tabsDone,
          totalTabs,
          totalBatches,
          batchIndex: bi + 1,
          currentGroup: "",
          label: `Pausing ${APPLY_BATCH_PAUSE_MS}ms before batch ${bi + 1} / ${totalBatches}…`,
        },
        runId
      );
      await new Promise((r) => setTimeout(r, APPLY_BATCH_PAUSE_MS));
    }

    const batch = batches[bi];

    for (let i = 0; i < batch.length; i++) {
      if (!(await isActiveOrganizeRun(runId))) {
        await setOrganizeProgress(
          {
            phase: "superseded",
            windowsDone,
            totalWindows,
            tabsDone,
            totalTabs,
            totalBatches,
            batchIndex: bi + 1,
            currentGroup: "",
            label: "Stopped — a newer Apply replaced this run.",
          },
          runId
        );
        return { superseded: true };
      }

      const g = batch[i];
      const ids = g.tabIds.filter((id) => id != null);
      if (ids.length === 0) continue;
      const [first, ...rest] = ids;

      const win = await chrome.windows.create({
        tabId: first,
        focused: false,
      });
      const winId = win.id;
      if (winId == null) continue;
      if (rest.length > 0) {
        try {
          await chrome.tabs.move(rest, { windowId: winId, index: -1 });
        } catch {
          for (const tabId of rest) {
            try {
              await chrome.tabs.move(tabId, { windowId: winId, index: -1 });
            } catch {
              /* tab closed or restricted */
            }
          }
        }
      }
      windowsDone += 1;
      tabsDone += ids.length;
      sinceProgressWrite += 1;

      const isLastWindowOverall =
        bi === batches.length - 1 && i === batch.length - 1;
      if (sinceProgressWrite >= 3 || isLastWindowOverall) {
        sinceProgressWrite = 0;
        if (await isActiveOrganizeRun(runId)) {
          const batchLabel =
            totalBatches > 1 ? `Batch ${bi + 1} / ${totalBatches} · ` : "";
          await setOrganizeProgress(
            {
              phase: "apply",
              windowsDone,
              totalWindows,
              tabsDone,
              totalTabs,
              totalBatches,
              batchIndex: bi + 1,
              currentGroup: g.name,
              label: `${batchLabel}${windowsDone} / ${totalWindows} windows · ${tabsDone} / ${totalTabs} tabs`,
            },
            runId
          );
        }
      }

      if (
        APPLY_THROTTLE_MS_BETWEEN_WINDOWS > 0 &&
        !isLastWindowOverall &&
        (await isActiveOrganizeRun(runId))
      ) {
        await new Promise((r) => setTimeout(r, APPLY_THROTTLE_MS_BETWEEN_WINDOWS));
      }
    }
  }

  if (!(await isActiveOrganizeRun(runId))) {
    await setOrganizeProgress(
      {
        phase: "superseded",
        windowsDone,
        totalWindows,
        tabsDone,
        totalTabs,
        totalBatches,
        batchIndex: totalBatches,
        label: "Stopped before finish — a newer Apply started.",
      },
      runId
    );
    return { superseded: true };
  }

  await setOrganizeProgress(
    {
      phase: "done",
      windowsDone: totalWindows,
      totalWindows,
      tabsDone,
      totalTabs,
      totalBatches,
      batchIndex: totalBatches,
      label: "Finished",
    },
    runId
  );
  return { superseded: false };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "ORGANIZE_APPLY") return false;

  const groups = msg.groups || [];
  const runId = msg.runId;
  if (!runId || typeof runId !== "string") {
    sendResponse({ ok: false, error: "Missing runId" });
    return false;
  }

  applyChain = applyChain
    .then(async () => {
      try {
        const r = await applyOrganizeGroups(groups, runId);
        if (r?.error) {
          sendResponse({
            ok: false,
            error: r.message || "Apply blocked by safety limits",
            runId,
          });
          return;
        }
        sendResponse({
          ok: true,
          superseded: !!r?.superseded,
          runId,
        });
      } catch (e) {
        sendResponse({
          ok: false,
          error: String(e?.message || e),
          runId,
        });
      }
    })
    .catch(() => {});

  return true;
});
