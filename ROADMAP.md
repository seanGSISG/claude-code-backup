# claude-code-backup — v0.5.0 Roadmap

> Source: produced by the `multimachine-review` workflow (9 agents: 4 reviewers ×
> adversarial verifiers + synthesis), all line numbers verified against the code.
> The workflow is saved and re-runnable as `/multimachine-review`. The earlier
> design workflow is `/env-aware-backup-design`.
>
> **Current shipped state:** v0.4.0 — published public on npm
> (`@seangsisg/claude-code-backup`) and GitHub (`seanGSISG/claude-code-backup`).
> Multi-environment (Windows + WSL) backup, per-env layout `latest/<envId>/`,
> cross-OS restore, `gh` repo creation, public-remote guard, shared-repo
> no-clobber + clone-on-join + pull-before-push.

## Root cause behind most gaps

Machine identity is derived from `os.hostname()` (`src/environments.mjs:45-50`)
with **no persistence, no uniqueness check, and no human label**. That single
issue produces the P0 collision/clobber bug, the multi-machine model gaps, and
the installer/status UX gaps. **Fix it once, centrally (C1) — it unblocks
everything else.**

Target user: WORK Windows + HOME Windows, WORK WSL + HOME WSL, HOME Linux; one
private repo; sometimes keep work+home Windows in sync, sometimes isolated;
never leak work config to home.

---

## 1. Critical correctness fixes (data loss / collisions / secret leaks)

### C1 — Identity collision silently clobbers another machine's backup `[P0, M]`
- **Problem:** `envId = <kind>[-<distro>]-<machineId>` and `machineId()` is just
  the sanitized hostname (`environments.mjs:45-50`). Two machines named `DESKTOP`
  produce the same `envId`; `exporter.mjs:177` then `rm -rf`s that shared dir and
  rewrites it — last pusher wins, the other machine's backup is deleted. No
  uniqueness check anywhere.
- **Fix:**
  1. `persistedMachineIdentity()` in environments.mjs → write
     `~/.claude-backups/machine-id.json` once: `{ uuid: crypto.randomUUID(),
     label, role, hostname, createdAt }`. Read every run; never auto-regenerate.
  2. Derive `envId` as `<kind>[-<distro>]-<uuid8>` (first 8 hex of UUID).
  3. **Collision guard before the destructive `rm` at `exporter.mjs:177`:** read
     existing `envBase/env.json`; if it has a *different* uuid, abort with a clear
     error (`--confirm-collision` to override). This is the load-bearing check.
  4. One-time migration: a legacy hostname-based dir matching this host → adopt it
     (write env.json with the new UUID, keep the dir) so history isn't lost.

### C2 — `git pull --rebase` swallows rebase conflicts, then pushes anyway `[P0, S]`
- **Problem:** `git-sync.mjs:194` `try { git pull --rebase } catch {}` — a real
  conflict is indistinguishable from "no remote yet", leaving the worktree
  mid-rebase; the subsequent push operates on an inconsistent state and reports
  success.
- **Fix:** in the catch, check for `join(dir, ".git", "rebase-merge")` /
  `rebase-apply`; if present, `git rebase --abort` and return
  `{ committed:true, pushed:false, blocked:"rebase-conflict", message:… }`. Only
  swallow when no rebase state exists. Surface `blocked` in `cmdRun`.

### C3 — `insideHome()` is case-sensitive; restores silently skip on Windows `[P0, S]`
- **Problem:** `restorer.mjs:112-115` does `destNative.startsWith(destEnv.home + sep)`
  with no case folding. Windows is case-insensitive; `c:\users\…` vs `C:\Users`
  fails → every item skipped as "outside home" with no error.
- **Fix:** lowercase both sides when `destStyle === "win"`; keep the `".."` guard.

### C4 — Deleted items resurface from another machine's env dir `[P1, M]`
- **Problem:** `exporter.mjs:177` clears only *this* machine's env dir. If A deletes
  a skill/secret, B's copy is untouched; restore's best-env match can bring the
  deleted item (e.g. a rotated key) back.
- **Fix:** keep env-dir isolation (cross-deletion would be dangerous). For the
  *sync* use case (M2), write a per-env `deleted.json` tombstone
  `{ "<scopeId>/<backupPath>": "<iso>" }`; restore skips tombstoned items for a
  declared sync relationship. No auto-propagation without opt-in.

### C5 — Secrets exported with only a GitHub-public guard `[P1, M]`
- **Problem:** `settings.local.json`, full `.claude.json`/`.mcp.json` MCP configs
  (command+args carry tokens), and session `.jsonl` are exported byte-for-byte.
  Only gate is `getRemoteVisibility()` via `gh repo view` (`git-sync.mjs:181-189`),
  blind to non-GitHub remotes and to a repo flipped public after init.
- **Fix (layered):** (1) re-verify visibility every `run` + surface in `status`;
  (2) `secretScan` pass flagging `/(bearer|api[_-]?key|secret|token|password|sk-[a-z0-9]{16,})/i`
  in exported items → one-line warning per run; (3) opt-in `excludePaths`/
  `excludeCategories` (M4) to drop settings.local.json / sessions; (4) README:
  rotate MCP keys if exposed; treat non-GitHub remotes as `unknown` and warn.

### C6 — Concurrent runs race on top-level `backup-summary.json` `[P1, S]`
- **Problem:** `exporter.mjs:189-200` rewrites the single top-level summary from all
  env dirs each run; two machines (or manual racing scheduler — `scheduler.mjs:211`
  `IgnoreNew` doesn't cover manual) clobber it.
- **Fix:** compute the aggregate **on read** in `status`/`restore` by scanning env
  dirs (each owns `env.json`); top-level file becomes a best-effort cache. Add a
  local `~/.claude-backups/.lock` (PID) at the start of `cmdRun`.

### C7 — MCP merge overwrites an existing server config with no signal `[P1, S]`
- **Problem:** `restorer.mjs:140,144` unconditionally `host.mcpServers[name] = config`;
  a locally-customized server is replaced (`.bak` made at :149 but no message).
- **Fix:** if the server already exists and differs, default to **skip** with a
  logged message; overwrite only with `opts.force`. Count skips.

### C8 — Lossy project-path encoding can collide `[P2, S]`
- **Problem:** `restorer.mjs:38-39` maps `_` and separators both to `-`, so
  `My_Projects` and `My-Projects` encode identically (mitigated by the decoder's
  backtracking, not eliminated).
- **Fix:** write a per-env `project-encodings.json` (`encoded -> originalNativePath`)
  at export; restore consults it and warns on collisions.

### C9 — Orphaned env dirs linger after a distro/machine is removed `[P2, M]`
- **Problem:** a removed distro is no longer discovered, so its
  `latest/wsl-<distro>-<id>/` never clears and shows as a phantom restore source.
- **Fix:** add `prune` (§3); in restore, skip sources not currently reachable with
  a log line. No auto-delete on export (history value).

### C10 — `cp(..., {recursive:true})` follows symlinked skill dirs `[P2, S]`
- **Problem:** Node `cp` follows symlinks by default; a symlinked marketplace skill
  gets its full target copied (bloat); read-only UNC target may error.
- **Fix:** `lstat` skill entries; record `{ symlinkTarget }` in the manifest instead
  of copying; recreate the link on restore (POSIX) / copy-once + warn (Windows).

---

## 2. Multi-machine model gaps

Build on **C1's `machine-id.json` (UUID identity)**. New local (non-secret) state:
`~/.claude-backups/machine-id.json` (identity) and `sync-config.json` (relationships).

### M1 — Human labels + machine metadata `[P1, S]`
- Dirs are cryptic; no label/role/username/timestamps in `env.json`.
- **Proposal:** `machine-id.json: { uuid, label, role: "work"|"home"|"shared",
  hostname, createdAt }`. Stamp every `env.json` with
  `{ uuid, label, role, createdAt, lastBackupAt }`. Prompt for label+role at init.
  Surface label everywhere instead of envId.

### M2 — Sync groups (work-vs-home) `[P1, M]`
- No grouping; every machine is an island.
- **Proposal:** `sync-config.json`:
  ```json
  { "machineUuid": "…",
    "groups": [
      { "id": "windows-shared", "members": ["<uuidWorkWin>","<uuidHomeWin>"],
        "direction": "bidirectional", "conflict": "preview",
        "exclude": { "categories": ["session"], "labels": ["sensitive"] } },
      { "id": "home-linux", "members": ["<uuidHomeLinux>"], "direction": "isolated" }
    ] }
  ```
  `restore`/`sync` refuse to move items between machines not sharing a group (the
  leak guard). Scheduler can auto-run a group's direction.

### M3 — Per-item labels + selective restore filters `[P1, M]`
- Restore filters by `--scope` only (`restorer.mjs:225`); can't pick "only skills"
  or "exclude MCP/sessions"; a WORK MCP secret can restore into HOME.
- **Proposal:** scanner tags each manifest item with `labels` (MCP/settings.local.json
  → `sensitive`; project items → scope name). Restore gains `--only-categories`,
  `--exclude-categories`, `--include-labels`, `--exclude-labels`. Group excludes
  (M2) apply automatically.

### M4 — Per-machine include/exclude at export `[P2, S]`
- No way to keep personal projects off the work machine's backup.
- **Proposal:** optional `~/.claude-backups/exclude.json`
  `{ excludeScopes, excludeCategories, excludePaths, projectFilter:{mode,patterns} }`
  loaded before the export loop. Also satisfies C5's secret-exclusion path.

### M5 — Conflict detection / preview before overwrite `[P1, M]`
- Restore overwrites diverged files (`.bak` only, silent).
- **Proposal:** add `exportedAt` per manifest item; in restore compare dest mtime
  vs source `exportedAt`; if dest is newer, collect as conflict and (unless
  `--force`) list all conflicts and abort apply. Pairs with the dry-run default.

---

## 3. Installer & CLI UX

### Recommended `init` question script (replaces `cmdInit` ~`cli.mjs:60-218`)
1. **Scan summary** (no question): discovered environments + item counts by
   category; if WSL absent, one line: `WSL not detected — only this OS backed up.`
2. **Machine label** — `Label for this machine [<hostname>]:`
3. **Machine role** — `Role: [1] work  [2] home  [3] shared  (3):`
4. **WSL distros** (Windows, if found) — `Back up WSL distros? [Y/n]:` then
   `Which? (comma-sep, blank = all) [all]:`
5. **First vs join** — `Is this the first machine? [1] create repo  [2] join existing (1):`
   - 1 → `Create private repo via gh as <user>? [Y/n]:`, `Repo name [claude-backup]:`
     (catch name-taken); gh-missing → manual SSH URL.
   - 2 → `Repo URL:`, clone, confirm.
6. **Private-repo ack (gate)** — `This backup CONTAINS SECRETS … Use a PRIVATE
   repo. I understand [y/N]:` proceed only on `y`; then `Remote verified: private`.
7. **Interval** — `[1] 1h  [2] 4h (recommended)  [3] 8h  [4] 24h  [5] manual  (2):`
   note scheduled runs use `--quiet` (won't wake stopped WSL).
8. **Install scheduler? [Y/n]** — if one exists: `keep / update interval` (idempotent).
9. **Run first backup now? [Y/n]** — print result + next steps (`status`, `list`).

### Improved `status` (replaces `cmdStatus` ~`cli.mjs:254-290`)
Compute aggregate by scanning env dirs (not the cached summary — C6). Group by
machine label; staleness = `> 2× interval`.
```
claude-code-backup — status

Repo:   ~/.claude-backups  →  github.com/me/claude-backup  (private ✓)
Branch: main  ·  0 ahead / 0 behind  ·  0 unpushed

Machines in backup:
  Work Desktop  (this machine · role: work)
    win-550e8400      245 items  2.1 MB  1h ago   ✓
    wsl-Ubuntu-550e8  180 items  1.8 MB  1h ago   ✓
  Home Laptop  (role: home)
    win-a1b2c3d4      189 items  1.2 MB  3d ago   ⚠ stale
  Home Linux  (role: home · isolated)
    linux-9e8f7g6h     78 items  0.5 MB  5m ago   ✓

This machine:
  Scheduler: Task Scheduler · every 4h · next ~3h · last OK
  Last run:  340 items · 0 errors · committed & pushed
  Warnings:  (surface C2 rebase-conflict / C5 secret + visibility here)
```

### Missing QoL commands
- **`list`** `[P1, S]` — machines + env counts + last-backup age.
- **`doctor`** `[P1, M]` — repo exists, remote set + private, scheduler enabled,
  freshness, summary parseable; each with a remediation hint.
- **`restore --interactive`** `[P1, M]` — pick source machine → env → dest → dry-run → confirm.
- **`run --dry-run`** `[P2, S]` — scan/export to temp, print what would back up + secret flags, no commit.
- **`prune <machine|envId>`** `[P2, S]` — remove an env/machine dir and commit (C9).
- **`relabel <new-label>`** `[P2, S]` — update machine-id.json + env.json labels.
- **Cross-cutting:** consistent `[Y/n]` parsing (`.toLowerCase()`); validate numeric
  interval; document `--allow-public` in `--help`.

---

## 4. Nice-to-haves / future
- Progress output for large backups (`copied N/M`).
- Default-exclude or flag the `session` category (transcripts may hold secrets).
- VM-clone identity drift note (UUID fixes most; document relabel/new-UUID step).
- Self-hosted remote visibility (treat unknown remotes as untrusted).
- Per-machine scheduler pause/resume.
- 3-way merge for config files (beyond M5 preview).

---

## Recommended build order (v0.5.0)
1. **Foundation:** C1 (persisted UUID identity + collision guard + envId redesign + legacy migration).
2. **P0 hardening (ship together):** C2 (rebase guard), C3 (case-insensitive insideHome), C6 (summary-on-read + run lock).
3. **P1 safety:** C7 (MCP skip-unless-force), C5 (secret scan + re-verify + exclude hook), M5 (conflict preview).
4. **Model:** M1 (labels/role + env.json metadata) → M3 (item labels + selective restore) → M2 (sync groups + leak guard) → M4 (per-machine exclude).
5. **UX:** new `init` script + `status` rewrite → `list` / `doctor` / `restore --interactive`.
6. **Cleanup:** C9 + `prune`, C4 tombstones, C8 encoding index, C10 symlinks, `run --dry-run`, `relabel`, progress.

## Key file:line anchors
- identity: `src/environments.mjs:45-50`
- destructive clear + summary race: `src/exporter.mjs:177`, `:189-200`
- rebase swallow: `src/git-sync.mjs:194`; public guard: `src/git-sync.mjs:181-189`
- insideHome: `src/restorer.mjs:112-115`; MCP merge: `src/restorer.mjs:140,144`
- scope-only filter: `src/restorer.mjs:225`; project encoding: `src/restorer.mjs:37-39`
- scheduler instance policy: `src/scheduler.mjs:211`

---

## Task checklist
- [x] **C1** persisted UUID identity + collision guard + envId redesign + legacy migration
- [x] **C2** rebase-conflict detection/abort in commitAndPush
- [x] **C3** case-insensitive insideHome on Windows
- [x] **C6** compute summary on read + per-run lockfile
- [x] **C7** MCP merge skip-unless-force (+ count skips)
- [x] **C5** secret-scan warning + per-run visibility re-check + README rotate note (exclude hook deferred to M4)
- [x] **M5** conflict preview via manifest `exportedAt` (abort apply unless --force)
- [x] **M1** labels/role in machine-id.json + stamp env.json; show labels everywhere
- [x] **M3** per-item labels + selective restore filters (only/exclude categories/labels)
- [x] **M2** sync groups + cross-group leak guard (opt-in; fail-closed once groups declared)
- [x] **M4** per-machine exclude.json at export
- [ ] **UX** new init question script
- [ ] **UX** status rewrite (scan env dirs, group by label, staleness/unpushed/warnings)
- [x] **UX** `list` command
- [ ] **UX** `doctor` command
- [ ] **UX** `restore --interactive`
- [ ] **C9** `prune` + skip unreachable sources in restore
- [ ] **C4** deletion tombstones (with M2 sync relationships)
- [ ] **C8** project-encodings.json index
- [ ] **C10** symlink-aware skill backup/restore
- [ ] **QoL** `run --dry-run`, `relabel`, progress output, consistent prompt parsing, --help docs
- [ ] Bump version, update CHANGELOG + README, republish
