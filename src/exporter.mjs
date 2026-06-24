/**
 * exporter.mjs — Export all scanned Claude Code items to a backup directory.
 *
 * Discovers every reachable environment (Windows-native + WSL distros, or a
 * single native store on Linux/macOS), scans each, and writes them under
 * per-environment prefixes when more than one is present:
 *
 *   latest/<envId>/<scopeId>/<category>/<file>      (multi-environment)
 *   latest/<scopeId>/<category>/<file>              (single environment)
 *
 * Each environment dir also gets an env.json (identity) and a manifest.json
 * (per-item originalPath/repoRoot/isDir) so `restore` can map files back to
 * their real locations on any machine, including cross-OS.
 */

import { mkdir, copyFile, writeFile, cp, rm, rename, readdir, readFile, access } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { scan } from "./scanner.mjs";
import { discoverEnvironments, persistedMachineIdentity, uuid8, machineId } from "./environments.mjs";

const BACKUP_DIR = join(homedir(), ".claude-backups");

/**
 * Convert a path the current process used to READ a store into the path the
 * store itself sees natively. For a WSL store reached over UNC
 * (\\wsl.localhost\Ubuntu\home\u\…) this strips the UNC root and flips
 * separators → /home/u/…. Native stores pass through unchanged.
 */
function toNativePath(p, env) {
  if (!p) return p;
  if (env.accessVia === "unc" && env.uncRoot && p.startsWith(env.uncRoot)) {
    return p.slice(env.uncRoot.length).replace(/\\/g, "/") || "/";
  }
  return p;
}

/** Items that aren't backed up as files — already captured inside "config". */
function isExportable(item) {
  return item.category !== "setting" && item.category !== "hook";
}

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** Read a env dir's env.json, or null if absent/unparseable. */
async function readEnvJson(envBase) {
  try { return JSON.parse(await readFile(join(envBase, "env.json"), "utf-8")); }
  catch { return null; }
}

/**
 * The pre-v0.5.0 (hostname-based) env id this environment would have used, so a
 * legacy backup dir can be adopted under the new UUID-based id (C1 migration).
 */
function legacyEnvId(env, hostMid) {
  switch (env.kind) {
    case "win":   return `win-${hostMid}`;
    case "mac":   return `mac-${hostMid}`;
    case "wsl":   return env.distro ? `wsl-${env.distro}-${hostMid}` : null;
    case "linux": return `linux-${hostMid}`;
    default:      return null;
  }
}

/**
 * Copy one scanned environment's items into `envBase`, returning the manifest
 * entries plus copy stats. Mirrors the destination-name logic so manifest
 * backupPaths match what lands on disk.
 */
async function exportEnvItems(data, env, envBase) {
  let copied = 0;
  const errors = [];
  const manifestItems = [];
  const exportedAt = new Date().toISOString();   // M5: stamp items for conflict detection

  // scopeId → native repoRoot (for project-scope restore re-rooting)
  const repoRootByScope = new Map();
  for (const scope of data.scopes) {
    if (scope.repoDir) repoRootByScope.set(scope.id, toNativePath(scope.repoDir, env));
  }

  for (const item of data.items) {
    if (!isExportable(item)) continue;
    try {
      const subDir = join(envBase, item.scopeId, item.category);
      await mkdir(subDir, { recursive: true });

      let relName;          // file/dir name within the category dir
      let isDir = false;

      if (item.category === "skill" || (item.category === "plugin" && item.path)) {
        relName = item.fileName || basename(item.path);
        await cp(item.path, join(subDir, relName), { recursive: true });
        isDir = true;
      } else if (item.category === "mcp") {
        relName = `${item.name}.json`;
        await writeFile(
          join(subDir, relName),
          JSON.stringify({ [item.name]: item.mcpConfig || {} }, null, 2) + "\n"
        );
      } else if (item.path) {
        relName = item.fileName || basename(item.path);
        const dest = join(subDir, relName);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(item.path, dest);
      } else {
        continue;
      }

      const entry = {
        backupPath: [item.scopeId, item.category, relName].join("/"),
        originalPath: toNativePath(item.path, env),
        category: item.category,
        scopeId: item.scopeId,
        isDir,
        exportedAt,
      };
      if (repoRootByScope.has(item.scopeId)) entry.repoRoot = repoRootByScope.get(item.scopeId);
      if (item.category === "mcp") {
        entry.mcpServerName = item.name;
        entry.hostFile = basename(item.path || "");
        if (item.claudeJsonProjectKey) entry.claudeJsonProjectKey = toNativePath(item.claudeJsonProjectKey, env);
      }
      manifestItems.push(entry);
      copied++;
    } catch (err) {
      errors.push(`${item.category}/${item.name}: ${err.message}`);
    }
  }

  return { copied, errors, manifestItems };
}

/** Write env.json + manifest.json + backup-summary.json for one environment. */
async function writeEnvMetadata(envBase, env, data, manifestItems, copied, errors, identity) {
  const { id, kind, distro, home, claudeDir, osPlatform, accessVia } = env;
  await writeFile(
    join(envBase, "env.json"),
    JSON.stringify({
      id, kind, distro, home, claudeDir, osPlatform, accessVia,
      // Identity stamp (C1): ties this env dir to a specific machine so the
      // collision guard can refuse to overwrite another machine's backup.
      uuid: identity?.uuid,
      label: identity?.label,
      role: identity?.role,
      createdAt: identity?.createdAt,
      lastBackupAt: new Date().toISOString(),
    }, null, 2) + "\n"
  );
  await writeFile(
    join(envBase, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      env: { id, kind, distro, home, claudeDir, osPlatform },
      items: manifestItems,
    }, null, 2) + "\n"
  );
  const summary = {
    exportedAt: new Date().toISOString(),
    envId: id,
    copied,
    errors: errors.length,
    errorDetails: errors.length > 0 ? errors : undefined,
    scopes: data.scopes.map((s) => ({ id: s.id, name: s.name, type: s.type })),
    categories: [...new Set(manifestItems.map((i) => i.category))],
    counts: data.counts,
  };
  await writeFile(join(envBase, "backup-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

/**
 * Enumerate every environment dir present under rootDir (all machines), reading
 * each dir's OWN env.json + backup-summary.json. This is the authoritative,
 * race-free view: each machine owns its env dir, so a clobbered top-level
 * backup-summary.json (C6) can never hide a machine that's actually on disk.
 */
async function readEnvDirs(rootDir) {
  const out = [];
  let entries;
  try { entries = await readdir(rootDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const envBase = join(rootDir, e.name);
    let ej;
    try { ej = JSON.parse(await readFile(join(envBase, "env.json"), "utf-8")); }
    catch { continue; }                       // not an env dir
    let sum = null;
    try { sum = JSON.parse(await readFile(join(envBase, "backup-summary.json"), "utf-8")); } catch {}
    out.push({
      id: ej.id, kind: ej.kind, distro: ej.distro,
      uuid: ej.uuid, label: ej.label, role: ej.role, lastBackupAt: ej.lastBackupAt,
      copied: sum?.copied ?? 0, errors: sum?.errors ?? 0,
      counts: sum?.counts, exportedAt: sum?.exportedAt,
    });
  }
  return out;
}

/**
 * Compute the multi-machine backup index ON READ by scanning env dirs, instead
 * of trusting the top-level backup-summary.json cache (which concurrent runs can
 * clobber — C6). Used by `status` and `restore`.
 */
export async function readBackupIndex(latestDir) {
  return { multiEnv: true, environments: await readEnvDirs(latestDir) };
}

/**
 * Core export routine: discover this machine's environments, scan each, and
 * write them under latest/<envId>/.
 *
 * Backups from multiple machines share ONE repo, separated by envId (which
 * embeds the hostname). So this run only ever clears and rewrites THIS
 * machine's own env dirs — other machines' backups under rootDir are left
 * untouched. The top-level index is then rebuilt from every env dir present,
 * so `restore`/status see all machines.
 *
 * @param {string} rootDir   directory that receives the per-env tree
 * @param {object} opts      { startStopped, machineId, identity, confirmCollision }
 */
async function exportToRoot(rootDir, opts = {}) {
  const environments = await discoverEnvironments({
    startStopped: opts.startStopped,
    machineId: opts.machineId,
  });
  const identity = opts.identity;
  if (!identity?.uuid) throw new Error("exportToRoot requires a persisted machine identity (opts.identity)");
  const hostMid = machineId();

  let copied = 0;
  const errors = [];
  const envSummaries = [];

  for (const env of environments) {
    const envBase = join(rootDir, env.id);        // always per-env, so machines never collide

    // C1 migration: adopt a pre-v0.5.0 hostname-based dir for this same env so
    // its git history carries forward under the new UUID-based id. Rename only
    // when the new dir doesn't already exist (export rewrites contents below).
    const legacyId = legacyEnvId(env, hostMid);
    if (legacyId && legacyId !== env.id && !(await pathExists(envBase))) {
      const legacyBase = join(rootDir, legacyId);
      if (await pathExists(legacyBase)) {
        // Adopt only a TRULY legacy dir (no uuid) or one already ours. A
        // same-hostname legacy dir owned by a different machine is left untouched.
        const legacy = await readEnvJson(legacyBase);
        if (!legacy?.uuid || legacy.uuid === identity.uuid) await rename(legacyBase, envBase);
      }
    }

    // C1 collision guard: never rm/overwrite an env dir owned by a DIFFERENT
    // machine. Adopted legacy dirs have no uuid yet, so they pass.
    const existing = await readEnvJson(envBase);
    if (existing?.uuid && identity?.uuid && existing.uuid !== identity.uuid && !opts.confirmCollision) {
      throw new Error(
        `Refusing to overwrite ${env.id}: it belongs to a different machine ` +
        `(uuid ${uuid8(existing.uuid)}, label "${existing.label || "?"}"). ` +
        `Your identity is ${uuid8(identity.uuid)} ("${identity.label}"). ` +
        `Re-run with --confirm-collision to override.`
      );
    }

    const data = await scan(env);                 // sequential — avoids UNC/local 9p contention
    await rm(envBase, { recursive: true, force: true });  // clear only THIS machine's env dir
    await mkdir(envBase, { recursive: true });

    const r = await exportEnvItems(data, env, envBase);
    copied += r.copied;
    for (const e of r.errors) errors.push(`[${env.id}] ${e}`);
    await writeEnvMetadata(envBase, env, data, r.manifestItems, r.copied, r.errors, identity);
    envSummaries.push({ envId: env.id, kind: env.kind, copied: r.copied, errors: r.errors.length, counts: data.counts });
  }

  // Rebuild the top-level index from ALL env dirs present (every machine),
  // not just the ones this run touched.
  const allEnvironments = await readEnvDirs(rootDir);
  const summary = {
    exportedAt: new Date().toISOString(),
    multiEnv: true,                               // layout is always per-env prefixed
    environments: allEnvironments,
    thisRun: environments.map((e) => ({ id: e.id, kind: e.kind, distro: e.distro })),
    copied,
    errors: errors.length,
    errorDetails: errors.length > 0 ? errors : undefined,
    envSummaries,
  };
  await writeFile(join(rootDir, "backup-summary.json"), JSON.stringify(summary, null, 2) + "\n");

  return { copied, errors, summary, environments };
}

/**
 * Export to a timestamped directory (historical snapshot). Not used by the
 * scheduler; kept for ad-hoc full snapshots.
 */
export async function exportAll(backupDir = BACKUP_DIR, opts = {}) {
  const identity = await persistedMachineIdentity(backupDir, opts);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupRoot = join(backupDir, `backup-${ts}`);
  await mkdir(backupRoot, { recursive: true });
  const { copied, errors, summary, environments } =
    await exportToRoot(backupRoot, { ...opts, identity, machineId: uuid8(identity.uuid) });
  return { backupRoot, copied, errors, summary, environments };
}

/**
 * Export to a stable "latest/" directory (for git tracking). Overwrites the
 * previous export so git only stores the diff.
 */
export async function exportLatest(backupDir = BACKUP_DIR, opts = {}) {
  // Resolve (or mint, on first run) this machine's stable UUID identity — the
  // envId suffix derives from it, so different machines never share an env dir.
  const identity = await persistedMachineIdentity(backupDir, opts);
  // Do NOT wipe latest/ wholesale — other machines' env dirs live here too.
  // exportToRoot clears only this machine's own env dirs.
  const latestDir = join(backupDir, "latest");
  await mkdir(latestDir, { recursive: true });
  const { copied, errors, summary, environments } =
    await exportToRoot(latestDir, { ...opts, identity, machineId: uuid8(identity.uuid) });
  return { backupRoot: latestDir, copied, errors, summary, environments };
}
