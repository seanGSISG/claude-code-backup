#!/usr/bin/env node

/**
 * claude-code-backup CLI
 *
 * Commands:
 *   init          — Interactive setup: create backup repo, configure remote, install scheduler
 *   run           — Run a backup now (scan + export + commit + push)
 *   status        — Show last backup info and scheduler status
 *   uninstall     — Remove scheduled backup (keeps backup data)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { acquireLock, releaseLock, ensureLocalIgnores, LOCAL_IGNORES } from "../src/runlock.mjs";

const HOME = homedir();
const BACKUP_DIR = join(HOME, ".claude-backups");
const CONFIG_PATH = join(BACKUP_DIR, "config.json");

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) {
  if (!process.argv.includes("--quiet")) {
    process.stdout.write(msg + "\n");
  }
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  await mkdir(BACKUP_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ── Commands ─────────────────────────────────────────────────────────

async function cmdInit() {
  const { scan } = await import("../src/scanner.mjs");
  const {
    isGitRepo, initRepo, addRemote, hasRemote, getRemoteUrl, cloneRepo,
    ghAvailable, ghAuthedUser, ghCreateRepo, getRemoteVisibility,
  } = await import("../src/git-sync.mjs");
  const { install } = await import("../src/scheduler.mjs");
  const { discoverEnvironments } = await import("../src/environments.mjs");

  log("🔍 Scanning Claude Code settings...\n");

  // Discover every reachable environment (Windows-native + WSL distros, or a
  // single native store). init is interactive, so wake stopped WSL distros.
  const environments = await discoverEnvironments({ startStopped: true });
  if (environments.length > 1) {
    log(`Found ${environments.length} Claude Code environments:`);
    for (const e of environments) log(`  ${e.id}${e.kind === "wsl" ? "  (WSL — backed up over UNC)" : ""}`);
    log("");
  }

  const data = await scan();
  const scopeCount = data.scopes.length;
  const itemCount = data.items.length;

  log(`Found ${itemCount} items across ${scopeCount} scopes (${environments[0].id}):`);
  for (const [cat, count] of Object.entries(data.counts)) {
    if (cat === "total") continue;
    log(`  ${cat}: ${count}`);
  }
  log("");

  // ── Repo + remote setup ──────────────────────────────────────────
  // One private repo holds EVERY machine, separated by per-environment
  // folders (latest/<envId>/) whose names embed the hostname. So the repo
  // itself is machine-agnostic: the first machine CREATES it, and later
  // machines JOIN by cloning it (sharing history so pushes don't clobber).

  async function writeRepoMeta() {
    await writeFile(
      join(BACKUP_DIR, ".gitignore"),
      [
        "# Don't track timestamped backups — only latest/", "backup-*/", "*.log", "config.json",
        "# Per-machine LOCAL state — must never be shared between machines",
        ...LOCAL_IGNORES, "",
      ].join("\n")
    );
    // Treat every backed-up file as binary: never normalize line endings, so
    // backups are byte-faithful and restores match the originals exactly.
    await writeFile(join(BACKUP_DIR, ".gitattributes"), ["* -text", ""].join("\n"));
  }

  async function warnIfPublic() {
    const vis = await getRemoteVisibility(BACKUP_DIR);
    if (vis.state === "public") {
      log(`⚠️  WARNING: ${vis.slug} is PUBLIC. Backups will be blocked until it's private (or you pass --allow-public).`);
    }
  }

  if ((await isGitRepo(BACKUP_DIR)) && (await hasRemote(BACKUP_DIR))) {
    log(`Existing backup repo: ${await getRemoteUrl(BACKUP_DIR)}`);
    await warnIfPublic();
  } else {
    log("Set up the backup repo (one private repo holds every machine):");
    log("  [1] First machine  — create a new private repo");
    log("  [2] Join existing  — clone the repo another machine already uses");
    const mode = (await ask("Choose 1 or 2 (default 1): ")).trim();

    if (mode === "2") {
      // JOIN — clone so we share history and only manage our own env dirs.
      let url = await ask("Existing backup repo URL (SSH or HTTPS): ");
      if (!url && (await ghAvailable())) {
        const u = await ghAuthedUser();
        if (u) {
          const guess = `https://github.com/${u}/claude-backup.git`;
          if ((await ask(`Use ${guess}? (Y/n): `)).toLowerCase() !== "n") url = guess;
        }
      }
      if (!url) { log("No repo URL given — aborting. Re-run init when ready."); return; }
      if (await exists(BACKUP_DIR)) {
        log("~/.claude-backups already exists, so it can't be cloned into. Move/remove it and re-run init.");
        return;
      }
      try {
        await cloneRepo(url, BACKUP_DIR);
        log("Cloned existing backup into ~/.claude-backups/");
      } catch (err) {
        log(`Clone failed: ${err.message}`);
        return;
      }
      await warnIfPublic();
    } else {
      // CREATE — new repo for the first machine.
      await mkdir(BACKUP_DIR, { recursive: true });
      if (!(await isGitRepo(BACKUP_DIR))) {
        log("Initializing git repo in ~/.claude-backups/");
        await initRepo(BACKUP_DIR);
        await writeRepoMeta();
      }

      let configured = false;
      if (await ghAvailable()) {
        const ghUser = await ghAuthedUser();
        if (ghUser) {
          const create = await ask(`Create a private GitHub repo with gh (as ${ghUser})? (Y/n): `);
          if (create.toLowerCase() !== "n") {
            const nameAns = await ask("Repo name (default: claude-backup): ");
            const repoName = nameAns || "claude-backup";
            try {
              const url = await ghCreateRepo(repoName);
              await addRemote(BACKUP_DIR, url);
              log(`Created and linked: ${url}`);
              configured = true;
            } catch (err) {
              log(`gh repo create failed (${err.message}). Falling back to manual setup.`);
            }
          }
        }
      }

      if (!configured) {
        log("Use a PRIVATE repo — backups can contain secrets (MCP keys, settings.local.json, sessions).");
        const repoUrl = await ask("GitHub repo URL (e.g. git@github.com:you/claude-backup.git): ");
        if (repoUrl) {
          await addRemote(BACKUP_DIR, repoUrl);
          log(`Remote added: ${repoUrl}`);
          await warnIfPublic();
        } else {
          log("Skipping remote setup. Run 'git remote add origin <url>' in ~/.claude-backups/ later.");
        }
      }
    }
  }

  // Scheduler setup
  log("");
  const intervalStr = await ask("Backup interval in hours (default: 4): ");
  const interval = parseInt(intervalStr) || 4;

  const nodePath = process.execPath;
  const cliPath = fileURLToPath(import.meta.url);

  try {
    const result = await install(nodePath, cliPath, interval);
    log(`\nScheduler installed (every ${interval}h + on boot)`);
    if (result.timerPath) log(`  Service: ${result.timerPath}`);
    if (result.plistPath) log(`  LaunchAgent: ${result.plistPath}`);
    if (result.taskName) log(`  Scheduled task: ${result.taskName}`);
  } catch (err) {
    log(`\nFailed to install scheduler: ${err.message}`);
    log("You can run backups manually with: npx @seangsisg/claude-code-backup run");
  }

  // Save config
  await saveConfig({ interval, installedAt: new Date().toISOString() });

  // Run first backup
  log("\nRunning first backup...\n");
  await cmdRun();

  log("\n✓ Setup complete! Your Claude Code settings are backed up.");
  log("  Backup location: ~/.claude-backups/latest/");
  log(`  Auto-backup: every ${interval} hours + on boot`);
}

async function cmdRun() {
  // Serialize runs so a scheduled run and a manual one can't race (C6).
  if (!(await acquireLock(BACKUP_DIR))) {
    log("Another backup is already running (lock held) — skipping this run.");
    process.exitCode = 1;
    return;
  }
  try {
    await cmdRunLocked();
  } finally {
    await releaseLock(BACKUP_DIR);
  }
}

async function cmdRunLocked() {
  const { exportLatest } = await import("../src/exporter.mjs");
  const { commitAndPush } = await import("../src/git-sync.mjs");

  // Interactive runs wake stopped WSL distros to back them up; scheduled
  // (--quiet) runs leave them asleep and capture WSL only when it's running.
  const startStopped = !process.argv.includes("--quiet");

  log("Scanning and exporting...");
  let exported;
  try {
    exported = await exportLatest(BACKUP_DIR, {
      startStopped,
      confirmCollision: process.argv.includes("--confirm-collision"),
    });
  } catch (err) {
    log(`\n✗ Backup aborted: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const { backupRoot, copied, errors, summary, environments } = exported;

  if (environments && environments.length > 1) {
    log(`Environments: ${environments.map((e) => e.id).join(", ")}`);
  }
  log(`Exported ${copied} items to ${backupRoot}`);
  if (errors.length > 0) {
    log(`Warnings: ${errors.length} items failed to export`);
    for (const err of errors.slice(0, 5)) log(`  - ${err}`);
  }

  // C5: heuristic secret scan over THIS run's exported data — a non-blocking
  // private-repo reminder. The backup intentionally keeps secrets; we never drop
  // them, we just remind the user to keep the remote private and rotate leaks.
  try {
    const { scanForSecrets, secretWarning } = await import("../src/secret-scan.mjs");
    const dirs = (environments || []).map((e) => join(backupRoot, e.id));
    const { hits } = await scanForSecrets(dirs);
    const warning = secretWarning(hits);
    if (warning) log(warning);
  } catch {}

  // Keep per-machine local state (identity, lock) out of the shared repo.
  await ensureLocalIgnores(BACKUP_DIR);

  // Git commit + push (backups must go to a private repo — see the guard below)
  log("Committing...");
  const result = await commitAndPush(BACKUP_DIR, { allowPublic: process.argv.includes("--allow-public") });
  log(result.message);
  // A blocked push (public-remote guard or rebase conflict) committed locally but
  // did NOT reach the remote — exit non-zero so scheduled runs surface it.
  if (result.blocked) process.exitCode = 1;

  // Write last-run info
  await saveConfig({
    ...(await loadConfig()),
    lastRun: new Date().toISOString(),
    lastCopied: copied,
    lastErrors: errors.length,
  });
}

async function cmdStatus() {
  const { status } = await import("../src/scheduler.mjs");
  const config = await loadConfig();

  if (config.lastRun) {
    const ago = Math.round((Date.now() - new Date(config.lastRun).getTime()) / 60000);
    log(`Last backup: ${config.lastRun} (${ago} min ago)`);
    log(`  Items backed up: ${config.lastCopied || "unknown"}`);
    log(`  Errors: ${config.lastErrors || 0}`);
  } else {
    log("No backup has been run yet.");
  }

  // Show every machine/env in the backup, computed ON READ from env dirs (not
  // the clobberable top-level cache — C6), grouped by machine label.
  try {
    const { readBackupIndex } = await import("../src/exporter.mjs");
    const { environments } = await readBackupIndex(join(BACKUP_DIR, "latest"));
    if (environments.length) {
      log("\nMachines in backup:");
      const byLabel = new Map();
      for (const e of environments) {
        const key = e.label || "(unlabeled)";
        if (!byLabel.has(key)) byLabel.set(key, []);
        byLabel.get(key).push(e);
      }
      for (const [label, envs] of byLabel) {
        const role = envs[0].role ? ` · role: ${envs[0].role}` : "";
        log(`  ${label}${role}`);
        for (const e of envs) {
          const when = e.lastBackupAt ? new Date(e.lastBackupAt).toISOString().slice(0, 16).replace("T", " ") : "never";
          log(`    ${e.id}   ${e.copied ?? 0} items   ${when}`);
        }
      }
    }
  } catch {}

  log("\nScheduler status:");
  const s = await status();
  log(s);

  // Check git status
  const { isGitRepo, hasRemote, getRemoteUrl, getRemoteVisibility } = await import("../src/git-sync.mjs");
  if (await isGitRepo(BACKUP_DIR)) {
    log("\nGit repo: ~/.claude-backups/");
    if (await hasRemote(BACKUP_DIR)) {
      log(`Remote: ${await getRemoteUrl(BACKUP_DIR)}`);
      // C5: re-verify visibility on every status — a repo can be flipped public
      // after init, and the backup contains secrets.
      const vis = await getRemoteVisibility(BACKUP_DIR);
      const tag = vis.state === "private" ? "private ✓"
        : vis.state === "public" ? "PUBLIC ⚠"
        : "unknown (not a verifiable GitHub remote)";
      log(`  Visibility: ${tag}`);
      if (vis.state === "public") {
        log("  ⚠ Backups are BLOCKED until this repo is private (or you pass --allow-public).");
      } else if (vis.state === "unknown") {
        log("  Treat this as untrusted — ensure the remote is private; the backup holds secrets.");
      }
    } else {
      log("Remote: not configured");
    }
  } else {
    log("\nGit repo: not initialized. Run 'claude-code-backup init' first.");
  }
}

async function cmdUninstall() {
  const { remove } = await import("../src/scheduler.mjs");
  await remove();
  log("Scheduler removed. Backup data preserved in ~/.claude-backups/");
}

/** Read the value following a flag in argv (e.g. --from <value>). */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function cmdRestore() {
  const { restore } = await import("../src/restorer.mjs");
  const apply = process.argv.includes("--apply");
  const opts = {
    apply,
    from: argValue("--from"),
    to: argValue("--to"),
    scope: argValue("--scope"),
    force: process.argv.includes("--force"),
    verbose: process.argv.includes("--verbose"),
    log,
  };

  if (!apply) log("DRY RUN — no files will be written. Re-run with --apply to restore.\n");

  let result;
  try {
    result = await restore(BACKUP_DIR, opts);
  } catch (err) {
    log(`Restore failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // M5: apply aborted because dest files changed locally since the backup.
  if (result.aborted) {
    log(`\nNothing was restored. ${result.conflicts.length} local file(s) are newer than the backup.`);
    process.exitCode = 1;
    return;
  }

  log("");
  log(`${apply ? "Restored" : "Would restore"}: ${result.restored} files/dirs, ${result.merged} MCP merges, ${result.skipped} skipped`);
  if (result.conflicts?.length) {
    log(`${apply ? "Overwrote" : "Conflicts"}: ${result.conflicts.length} item(s) newer locally than the backup${apply ? " (--force)" : " (use --force to overwrite)"}`);
  }
  for (const p of result.pairs) {
    log(`  ${p.from} → ${p.to}${p.cross ? " (cross-OS)" : ""}`);
  }
  if (result.errors.length) {
    log(`Warnings (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 10)) log(`  - ${e}`);
  }
  if (!apply) log("\nRun again with --apply to perform the restore.");
}

// ── Main ─────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "init":
    await cmdInit();
    break;
  case "run":
    await cmdRun();
    break;
  case "status":
    await cmdStatus();
    break;
  case "restore":
    await cmdRestore();
    break;
  case "uninstall":
    await cmdUninstall();
    break;
  default:
    log("claude-code-backup — Automatic backup of all Claude Code settings\n");
    log("Usage:");
    log("  claude-code-backup init        Set up backup repo + schedule");
    log("  claude-code-backup run         Run backup now");
    log("  claude-code-backup status      Show backup status");
    log("  claude-code-backup restore     Restore from backup (dry-run; add --apply)");
    log("  claude-code-backup uninstall   Remove scheduled backup\n");
    log("  run flags:     --quiet  --allow-public  --confirm-collision");
    log("  restore flags: --apply  --from <envId>  --to <envId>  --scope <id>  --force  --verbose");
    log("Backs up Windows-native AND WSL stores; restores across machines and OSes.");
    break;
}
