/**
 * restorer.mjs — Restore a backed-up Claude Code store onto the current machine.
 *
 * Reads the per-environment manifest written by exporter.mjs (originalPath +
 * repoRoot + isDir) and maps every item back to a destination on the current
 * machine. Handles same-OS restores (home/username rewrite) AND cross-OS
 * restores (path-separator translation + project-dir RE-ENCODING), including
 * restoring into a WSL distro from Windows over the UNC 9p share.
 *
 * Dry-run by default: nothing is written unless { apply: true }.
 */

import { readFile, writeFile, mkdir, copyFile, cp, access, rename, stat, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { discoverEnvironments } from "./environments.mjs";
import { readBackupIndex } from "./exporter.mjs";

const BACKUP_DIR = join(homedir(), ".claude-backups");

// ── Path-style primitives (operate on foreign-OS paths as strings) ──────

const styleOf = (osPlatform) => (osPlatform === "win32" ? "win" : "posix");
const sepOf = (style) => (style === "win" ? "\\" : "/");

/** Re-root a path P from srcRoot onto destRoot, translating separators. */
function reRoot(p, srcRoot, srcStyle, destRoot, destStyle) {
  const tail = p.slice(srcRoot.length);                 // begins with srcSep (or empty)
  const parts = tail.split(sepOf(srcStyle));
  return destRoot + parts.join(sepOf(destStyle));
}

/**
 * Encode a native absolute path into a ~/.claude/projects/<name> folder name.
 * Each separator maps to one dash (NOT collapsed) so a Windows drive root
 * encodes as "C:\\…" → "C--…" exactly as Claude Code does.
 */
function encodeProject(nativePath, style) {
  if (style === "win") return nativePath.replace(/[:\\/]/g, "-");
  return nativePath.replace(/\//g, "-");                // leading "/" → leading "-"
}

/** Native ~/.claude dir for an environment's HOME, in its own path style. */
function claudeOf(home, style) {
  return home + sepOf(style) + ".claude";
}

/** Convert a dest-native path into the real path to write through. */
function toWritePath(destNative, destEnv) {
  if (destEnv.accessVia === "unc" && destEnv.uncRoot) {
    return destEnv.uncRoot + destNative.replace(/\//g, "\\");
  }
  return destNative;
}

async function readJson(p) {
  try { return JSON.parse(await readFile(p, "utf-8")); } catch { return null; }
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

// ── Item mapping ────────────────────────────────────────────────────────

/**
 * Compute where one manifest item should land on the destination machine.
 * Returns { destNative, srcStyle, destStyle } or { skip, reason }.
 */
function mapItem(item, srcEnv, destEnv) {
  const srcStyle = styleOf(srcEnv.osPlatform);
  const destStyle = styleOf(destEnv.osPlatform);
  const srcHome = srcEnv.home;
  const destHome = destEnv.home;
  const srcClaude = claudeOf(srcHome, srcStyle);
  const destClaude = claudeOf(destHome, destStyle);
  const srcSep = sepOf(srcStyle);
  const op = item.originalPath;
  if (!op) return { skip: true, reason: "no originalPath" };

  // Project-scope items stored under ~/.claude/projects/<encoded>/… need the
  // encoded folder re-derived for the destination machine/OS.
  const projectsPrefix = srcClaude + srcSep + "projects" + srcSep;
  if (item.scopeId !== "global" && op.startsWith(projectsPrefix + item.scopeId + srcSep)) {
    if (!item.repoRoot) return { skip: true, reason: "project item without repoRoot" };
    if (!item.repoRoot.startsWith(srcHome)) return { skip: true, reason: "repoRoot outside source home" };
    const destRepoRoot = reRoot(item.repoRoot, srcHome, srcStyle, destHome, destStyle);
    const destEncoded = encodeProject(destRepoRoot, destStyle);
    const srcScopePrefix = projectsPrefix + item.scopeId;
    const destScopePrefix = destClaude + sepOf(destStyle) + "projects" + sepOf(destStyle) + destEncoded;
    const tail = op.slice(srcScopePrefix.length).split(srcSep).join(sepOf(destStyle));
    return { destNative: destScopePrefix + tail, srcStyle, destStyle };
  }

  // Project working-dir files (e.g. repoRoot/.claude/settings.json, repoRoot/CLAUDE.md).
  if (item.repoRoot && op.startsWith(item.repoRoot) && item.repoRoot.startsWith(srcHome)) {
    const destRepoRoot = reRoot(item.repoRoot, srcHome, srcStyle, destHome, destStyle);
    return { destNative: reRoot(op, item.repoRoot, srcStyle, destRepoRoot, destStyle), srcStyle, destStyle };
  }

  // Global items under ~/.claude (skills, config, memory, plans, rules, …).
  if (op.startsWith(srcClaude)) {
    return { destNative: reRoot(op, srcClaude, srcStyle, destClaude, destStyle), srcStyle, destStyle };
  }

  // Items directly under HOME (~/.claude.json, ~/.mcp.json).
  if (op.startsWith(srcHome)) {
    return { destNative: reRoot(op, srcHome, srcStyle, destHome, destStyle), srcStyle, destStyle };
  }

  // Managed/enterprise or other out-of-home paths — never restored.
  return { skip: true, reason: "outside home (managed/system path)" };
}

/** Safety: dest must resolve inside the destination HOME. Exported for tests. */
export function insideHome(destNative, destEnv) {
  const destStyle = styleOf(destEnv.osPlatform);
  if (destNative.includes("..")) return false;
  // Windows paths are case-insensitive: a backup's "C:\\Users\\me" must match a
  // homedir() reporting "c:\\users\\me". Without folding, every item is skipped
  // as "outside home" and the restore silently does nothing (C3).
  const fold = destStyle === "win" ? (s) => s.toLowerCase() : (s) => s;
  const home = fold(destEnv.home);
  const dest = fold(destNative);
  return dest.startsWith(home + sepOf(destStyle)) || dest === home;
}

/**
 * Newest mtime at/under a path. For a directory this recurses (a dir's own
 * mtime does NOT change when a nested file is edited — e.g. a skill folder's
 * source), so directory conflicts aren't missed. Returns null if path is missing.
 */
async function newestMtimeMs(p) {
  let st;
  try { st = await stat(p); } catch { return null; }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  let entries;
  try { entries = await readdir(p, { withFileTypes: true }); } catch { return newest; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;                 // don't follow symlinks
    const m = await newestMtimeMs(join(p, e.name));
    if (m !== null && m > newest) newest = m;
  }
  return newest;
}

/**
 * M5: a destination "conflicts" if it exists and was modified AFTER this item
 * was backed up — restoring would clobber newer local edits. For directories,
 * any newer file *inside* it counts. Missing dest or unparseable timestamp → no
 * conflict. NOTE: mtime-based, so it can't see across a clock-skewed pair of
 * machines; the dry-run default + --force keep the user in control.
 */
export async function isConflict(writePath, exportedAtIso) {
  const exportedMs = new Date(exportedAtIso).getTime();
  if (!Number.isFinite(exportedMs)) return false;
  const m = await newestMtimeMs(writePath);
  if (m === null) return false;            // dest doesn't exist → nothing to overwrite
  return m > exportedMs;
}

// ── MCP merge (read-modify-write the host JSON, never clobber) ───────────

/** Order-insensitive deep stringify, so key-order differences aren't "changes". */
function stableStringify(v) {
  if (v === undefined) return "undefined";          // keep undefined distinguishable
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
export const sameConfig = (a, b) => stableStringify(a) === stableStringify(b);

export async function mergeMcp(item, backupFile, writePath, destEnv, srcEnv, apply, opts = {}) {
  const fragment = await readJson(backupFile);          // { "<name>": {config} }
  if (!fragment) return { ok: false, reason: "unreadable fragment" };
  const name = item.mcpServerName || Object.keys(fragment)[0];
  const config = fragment[name];
  if (config === undefined) return { ok: false, reason: `no config for '${name}' in fragment` };
  const host = (await readJson(writePath)) || {};

  // Resolve the object that holds this server's config (project-scoped vs global).
  let container;
  if ((item.hostFile || "").toLowerCase() === ".claude.json" && item.claudeJsonProjectKey) {
    const srcStyle = styleOf(srcEnv.osPlatform), destStyle = styleOf(destEnv.osPlatform);
    const key = item.claudeJsonProjectKey.startsWith(srcEnv.home)
      ? reRoot(item.claudeJsonProjectKey, srcEnv.home, srcStyle, destEnv.home, destStyle)
      : item.claudeJsonProjectKey;
    host.projects = host.projects || {};
    host.projects[key] = host.projects[key] || {};
    host.projects[key].mcpServers = host.projects[key].mcpServers || {};
    container = host.projects[key].mcpServers;
  } else {
    host.mcpServers = host.mcpServers || {};
    container = host.mcpServers;
  }

  // C7: never silently clobber a locally-customized server. If one already
  // exists and differs, skip unless --force; if it's identical, it's a no-op.
  const existing = container[name];
  if (existing !== undefined) {
    if (sameConfig(existing, config)) return { ok: true, server: name, unchanged: true };
    if (!opts.force) return { ok: false, skipped: true, server: name, reason: "exists-differs" };
  }
  container[name] = config;

  if (apply) {
    await mkdir(dirname(writePath), { recursive: true });
    if (await exists(writePath)) await backup(writePath);
    await writeFile(writePath, JSON.stringify(host, null, 2) + "\n");
  }
  return { ok: true, server: name, overwritten: existing !== undefined };
}

async function backup(p) {
  try { await rename(p, p + ".bak"); } catch {}
}

// ── Source discovery ─────────────────────────────────────────────────────

async function loadSources(latestDir) {
  // Compute the index ON READ from env dirs, not the top-level cache, so a
  // concurrent run that clobbered backup-summary.json can't hide a machine (C6).
  const { environments } = await readBackupIndex(latestDir);
  if (!environments.length) {
    // A pre-v0.5.0 backup has a top-level summary but no per-environment dirs.
    const legacy = await readJson(join(latestDir, "backup-summary.json"));
    throw new Error(
      legacy
        ? "This backup predates the per-environment layout. Run `claude-code-backup run` once to regenerate it, then restore."
        : "No restorable environments found in backup. Run `claude-code-backup run` once to (re)generate, then restore."
    );
  }
  const sources = [];
  for (const e of environments) {
    const dir = join(latestDir, e.id);
    const manifest = await readJson(join(dir, "manifest.json"));
    const env = await readJson(join(dir, "env.json"));
    if (manifest && env) sources.push({ env, manifest, dir });
  }
  return sources;
}

/** Pick the destination environment for a given source env. */
function pickDest(srcEnv, destEnvs, opts) {
  if (opts.to) {
    const m = destEnvs.find((d) => d.id === opts.to);
    if (!m) throw new Error(`--to '${opts.to}' not found among: ${destEnvs.map((d) => d.id).join(", ")}`);
    return m;
  }
  return (
    destEnvs.find((d) => d.kind === srcEnv.kind && (d.kind !== "wsl" || d.distro === srcEnv.distro)) ||
    destEnvs.find((d) => d.kind === srcEnv.kind) ||
    destEnvs[0]
  );
}

// ── Main restore ─────────────────────────────────────────────────────────

/**
 * @param {string} backupDir  ~/.claude-backups
 * @param {object} opts  { apply, from, to, scope, force, log }
 */
export async function restore(backupDir = BACKUP_DIR, opts = {}) {
  const log = opts.log || (() => {});
  const latestDir = join(backupDir, "latest");
  const sources = await loadSources(latestDir);
  if (!sources.length) throw new Error("No restorable environments found in backup.");

  const destEnvs = await discoverEnvironments({ startStopped: true });

  // Choose which source env(s) to restore.
  let chosen = sources;
  if (opts.from) {
    chosen = sources.filter((s) => s.env.id === opts.from);
    if (!chosen.length) throw new Error(`--from '${opts.from}' not in backup: ${sources.map((s) => s.env.id).join(", ")}`);
  } else if (sources.length > 1 && !opts.to) {
    // Default: restore each source into its best-matching dest. Report the plan.
    log(`Backup contains ${sources.length} environments: ${sources.map((s) => s.env.id).join(", ")}`);
  }

  const result = { applied: !!opts.apply, restored: 0, merged: 0, skipped: 0, errors: [], pairs: [], conflicts: [] };

  // M5: scan for destinations that changed locally SINCE this backup (dest mtime
  // newer than the item's exportedAt) — restoring would overwrite newer edits.
  // Collect them all first; in apply mode, abort unless --force so nothing is
  // clobbered silently. Dry-run just lists them in the preview. MCP items are
  // excluded (they go through the C7 merge/skip path, not a blind overwrite).
  for (const src of chosen) {
    const dest = pickDest(src.env, destEnvs, opts);
    let items = src.manifest.items;
    if (opts.scope) items = items.filter((i) => i.scopeId === opts.scope);
    for (const item of items) {
      if (item.category === "mcp" || !item.exportedAt) continue;
      const m = mapItem(item, src.env, dest);
      if (m.skip || !insideHome(m.destNative, dest)) continue;
      if (await isConflict(toWritePath(m.destNative, dest), item.exportedAt)) {
        result.conflicts.push({ from: src.env.id, backupPath: item.backupPath, dest: m.destNative });
      }
    }
  }

  if (result.conflicts.length) {
    log(`\n⚠ ${result.conflicts.length} item(s) changed locally since this backup:`);
    for (const c of result.conflicts.slice(0, 20)) log(`  conflict  ${c.backupPath}  → ${c.dest}`);
    if (result.conflicts.length > 20) log(`  … +${result.conflicts.length - 20} more`);
    if (opts.apply && !opts.force) {
      log(`\n✗ Apply aborted to avoid overwriting newer local changes.`);
      log(`  Re-run with --force to overwrite, or narrow with --scope/--from.`);
      result.aborted = true;
      return result;
    }
    log(opts.apply ? `  (--force given — these will be overwritten)` : `  (these would be overwritten by --apply)`);
  }

  for (const src of chosen) {
    const dest = pickDest(src.env, destEnvs, opts);
    result.pairs.push({ from: src.env.id, to: dest.id, cross: src.env.osPlatform !== dest.osPlatform });
    log(`\n${src.env.id}  →  ${dest.id}${src.env.osPlatform !== dest.osPlatform ? "   (cross-OS)" : ""}`);

    let items = src.manifest.items;
    if (opts.scope) items = items.filter((i) => i.scopeId === opts.scope);

    for (const item of items) {
      const m = mapItem(item, src.env, dest);
      if (m.skip) {
        result.skipped++;
        if (opts.verbose) log(`  skip  ${item.backupPath}  (${m.reason})`);
        continue;
      }

      if (!insideHome(m.destNative, dest)) {
        result.skipped++;
        result.errors.push(`refused (outside home): ${item.backupPath} → ${m.destNative}`);
        continue;
      }

      const writePath = toWritePath(m.destNative, dest);
      const backupFile = join(src.dir, ...item.backupPath.split("/"));

      try {
        if (item.category === "mcp") {
          const r = await mergeMcp(item, backupFile, writePath, dest, src.env, opts.apply, { force: opts.force });
          if (r.ok) {
            if (!r.unchanged) result.merged++;   // a no-op isn't a merge
            const note = r.unchanged ? " (already current)" : r.overwritten ? " (overwritten)" : "";
            log(`  merge mcp  ${r.server}${note}  → ${m.destNative}`);
          } else if (r.skipped) {
            result.skipped++;
            result.errors.push(`mcp '${r.server}' already exists and differs — skipped (use --force to overwrite)`);
            log(`  skip  mcp ${r.server}  (exists & differs; --force to overwrite)`);
          } else {
            result.skipped++;
          }
          continue;
        }

        if (opts.apply) {
          await mkdir(dirname(writePath), { recursive: true });
          if (item.isDir) {
            await cp(backupFile, writePath, { recursive: true });
          } else {
            if (await exists(writePath)) await backup(writePath);
            await copyFile(backupFile, writePath);
          }
        }
        result.restored++;
        log(`  ${item.isDir ? "dir " : "file"}  ${item.backupPath}  → ${m.destNative}`);
      } catch (err) {
        result.errors.push(`${item.backupPath}: ${err.message}`);
      }
    }
  }

  return result;
}
