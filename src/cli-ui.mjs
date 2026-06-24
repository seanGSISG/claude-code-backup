/**
 * cli-ui.mjs — pure presentation helpers for the CLI.
 *
 * Everything here is side-effect-free (no fs, no clock reads — callers pass
 * `nowMs`) so the UX surfaces (init/status/list/doctor/restore --interactive)
 * can be unit-tested without a real backup repo. The CLI does the I/O; this
 * module only formats and decides.
 */

/**
 * Parse a [Y/n]-style answer into a boolean. Blank → the default.
 * @param {string} answer   raw user input
 * @param {boolean} dflt    value to use when the answer is blank
 */
export function parseYesNo(answer, dflt = true) {
  const a = String(answer ?? "").trim().toLowerCase();
  if (a === "") return dflt;
  if (a === "y" || a === "yes") return true;
  if (a === "n" || a === "no") return false;
  return dflt;
}

/** Human-readable "time since" for a backup timestamp. */
export function formatAge(iso, nowMs) {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "never";
  const sec = Math.max(0, Math.round((nowMs - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

/** Compact byte size: 0 B, 512 B, 2.1 KB, 1.8 MB, 3.0 GB. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Is a backup stale? Stale = older than 2× the configured interval (the
 * threshold the roadmap's status mockup uses). With no interval known, fall
 * back to 2× the default 4h. A missing timestamp is treated as stale.
 */
export function isStale(iso, intervalHours, nowMs) {
  if (!iso) return true;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return true;
  const hours = Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 4;
  return nowMs - then > 2 * hours * 3600 * 1000;
}

/**
 * Group env records by MACHINE, not by label. A machine's env dirs (win + wsl)
 * all carry the same identity uuid, while two distinct machines never do — even
 * if a user gives them the same human label. So key on uuid (falling back to
 * label, then "(unlabeled)" for legacy dirs with neither). The display label is
 * derived per group from its first env.
 */
export function groupByMachine(environments) {
  const groups = new Map();
  for (const e of environments) {
    const key = e.uuid || e.label || "(unlabeled)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return groups;
}

/**
 * Render the "Machines in backup" block as an array of lines.
 *
 * @param {Array} environments   records from readBackupIndex (each may carry `bytes`)
 * @param {object} opts
 * @param {string} [opts.thisUuid]      mark the group owning this UUID as "this machine"
 * @param {number} [opts.intervalHours] staleness threshold basis (status only)
 * @param {number} opts.nowMs           clock, injected for testability
 * @param {boolean} [opts.showSize]     include a size column (status)
 * @param {boolean} [opts.showStale]    include a ✓ / ⚠ stale marker column (status)
 * @returns {string[]}
 */
export function renderMachineLines(environments, opts = {}) {
  const { thisUuid, intervalHours, nowMs, showSize = false, showStale = false } = opts;
  if (!environments || !environments.length) return [];

  // Pre-compute cell strings so columns can be width-aligned.
  const rows = environments.map((e) => ({
    env: e,
    id: e.id || "(unknown)",
    items: `${e.copied ?? 0} items`,
    size: showSize ? formatBytes(e.bytes) : "",
    age: formatAge(e.lastBackupAt, nowMs),
    stale: showStale ? isStale(e.lastBackupAt, intervalHours, nowMs) : false,
  }));
  const w = (key) => rows.reduce((m, r) => Math.max(m, r[key].length), 0);
  const idW = w("id"), itemsW = w("items"), sizeW = showSize ? w("size") : 0, ageW = w("age");

  const lines = [];
  for (const [key, envs] of groupByMachine(environments)) {
    const label = envs[0]?.label || "(unlabeled)";
    const isThis = thisUuid && key === thisUuid;
    const tags = [];
    if (isThis) tags.push("this machine");
    if (envs[0]?.role) tags.push(`role: ${envs[0].role}`);
    lines.push(`  ${label}${tags.length ? `  (${tags.join(" · ")})` : ""}`);
    for (const r of rows.filter((r) => envs.includes(r.env))) {
      let line = `    ${r.id.padEnd(idW)}   ${r.items.padStart(itemsW)}`;
      if (showSize) line += `  ${r.size.padStart(sizeW)}`;
      line += `  ${r.age.padStart(ageW)}`;
      if (showStale) line += `   ${r.stale ? "⚠ stale" : "✓"}`;
      lines.push(line);
    }
  }
  return lines;
}
