const statusEl = document.getElementById("status");
const barWrap = document.getElementById("barWrap");
const barFill = document.getElementById("barFill");
const detailEl = document.getElementById("detail");
const closeBtn = document.getElementById("closeBtn");

/** @type {string | null} */
let myRunId = null;
let replacedNoticeShown = false;

/**
 * @param {{
 *   phase?: string;
 *   runId?: string;
 *   windowsDone?: number;
 *   totalWindows?: number;
 *   tabsDone?: number;
 *   totalTabs?: number;
 *   currentGroup?: string;
 *   label?: string;
 * } | undefined} p
 */
function renderProgress(p) {
  if (!p) return;
  if (p.runId != null && myRunId != null && p.runId !== myRunId) {
    if (!replacedNoticeShown) {
      replacedNoticeShown = true;
      statusEl.textContent =
        "This run was replaced by a newer Apply from the extension. You can close this window.";
      detailEl.textContent = "";
      barFill.style.width = "0%";
      closeBtn.hidden = false;
    }
    return;
  }

  const total = p.totalTabs ?? 0;
  const done = p.tabsDone ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((100 * done) / total)) : 0;
  barFill.style.width = `${pct}%`;
  barWrap.setAttribute("aria-valuenow", String(pct));
  statusEl.textContent = p.label || `${done} / ${total} tabs`;
  detailEl.textContent = p.currentGroup ? `Last: ${p.currentGroup}` : "";

  if (p.phase === "error") {
    statusEl.textContent = p.label || "Apply could not run.";
    detailEl.textContent = "";
    barFill.style.width = "0%";
    closeBtn.hidden = false;
    closeBtn.focus();
    return;
  }

  if (p.phase === "superseded") {
    statusEl.textContent = p.label || "This run was stopped.";
    closeBtn.hidden = false;
    closeBtn.focus();
    return;
  }

  if (p.phase === "done") {
    statusEl.textContent = `Done — ${p.tabsDone ?? 0} tab(s) in ${p.totalWindows ?? 0} window(s).`;
    closeBtn.hidden = false;
    closeBtn.focus();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  closeBtn.addEventListener("click", async () => {
    await chrome.storage.session.remove(["organizeJob", "organizeProgress", "organizeActiveRunId"]);
    window.close();
  });

  const { organizeJob } = await chrome.storage.session.get("organizeJob");
  if (!organizeJob?.groups?.length) {
    statusEl.textContent =
      "No organize job found. Close this window and run Preview → Apply from the extension popup.";
    closeBtn.hidden = false;
    return;
  }

  myRunId = organizeJob.runId ?? null;
  if (!myRunId) {
    statusEl.textContent = "Outdated job format. Run Preview → Apply again from the extension.";
    closeBtn.hidden = false;
    return;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session" || !changes.organizeProgress) return;
    renderProgress(changes.organizeProgress.newValue);
  });

  const existing = await chrome.storage.session.get("organizeProgress");
  if (existing.organizeProgress) renderProgress(existing.organizeProgress);

  renderProgress({
    phase: "apply",
    runId: myRunId,
    tabsDone: 0,
    totalTabs: organizeJob.groups.reduce(
      (n, g) => n + g.tabIds.filter((id) => id != null).length,
      0
    ),
    label: "Connecting…",
  });

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "ORGANIZE_APPLY",
      groups: organizeJob.groups,
      runId: myRunId,
    });
  } catch (e) {
    statusEl.textContent = `Error: ${e?.message || e}`;
    detailEl.textContent = "";
    closeBtn.hidden = false;
    return;
  }

  if (!res?.ok) {
    statusEl.textContent = `Failed: ${res?.error || "unknown error"}`;
    closeBtn.hidden = false;
    return;
  }

  if (res.runId !== myRunId) {
    statusEl.textContent = "Response was for a different run. Close this window.";
    closeBtn.hidden = false;
    return;
  }

  if (res.superseded) {
    const final = await chrome.storage.session.get("organizeProgress");
    if (final.organizeProgress?.runId === myRunId) {
      renderProgress(final.organizeProgress);
    } else {
      statusEl.textContent = "This run was replaced by a newer Apply. Close this window.";
      closeBtn.hidden = false;
    }
    return;
  }

  const { organizeActiveRunId } = await chrome.storage.session.get("organizeActiveRunId");
  if (organizeActiveRunId === myRunId) {
    await chrome.storage.session.remove("organizeJob");
  }

  const final = await chrome.storage.session.get("organizeProgress");
  if (final.organizeProgress?.runId === myRunId) {
    renderProgress(final.organizeProgress);
  }
});
