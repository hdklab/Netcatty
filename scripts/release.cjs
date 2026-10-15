#!/usr/bin/env node
/* eslint-disable no-console */
//
// Netcatty release driver — "发布一个版本" 的单一入口.
//
// Why this exists: installers are produced by the tag-triggered
// `build-packages` workflow (.github/workflows/build.yml). Creating the GitHub
// Release by hand (web UI or `gh release create`) publishes a release with zero
// assets: nothing ever ran the packaging matrix, so there is nothing to attach.
// Only the workflow's own `release` job may create/populate the release.
//
// So the release path is: write the CHANGELOG section -> this script bumps the
// version, commits `chore(release): X.Y.Z`, creates an annotated `vX.Y.Z` tag and
// pushes both refs -> CI builds every platform -> the script then verifies that a
// workflow run was actually created for the tag AND that installer assets landed
// on the release. A missing run or an asset-less release is reported as failure.
//
// Usage:
//   node scripts/release.cjs patch                 # 1.1.93 -> 1.1.94 (also minor|major|<X.Y.Z>)
//   node scripts/release.cjs 1.2.0 --dry-run       # print the plan, change nothing
//   node scripts/release.cjs --status [v1.2.0]     # read-only: run + assets for a tag
//   node scripts/release.cjs --retry v1.1.93       # no run exists for the tag: trigger CI, then verify
//
// Flags: --dry-run  --yes  --no-push  --no-changelog-check  --timeout <minutes>  --help

"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const BUILD_WORKFLOW_FILE = "build.yml";
const DEFAULT_RUN_CREATE_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_MINUTES = 60;
const LOG_PREFIX = "[release]";

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message) {
  console.warn(`${LOG_PREFIX} WARN ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --------------------------------------------------------------------------
// shell helpers
// --------------------------------------------------------------------------

function run(command, args, options = {}) {
  const { cwd = REPO_ROOT, allowFailure = false } = options;
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    if (allowFailure) {
      return { ok: false, status: -1, stdout: "", stderr: String(result.error.message) };
    }
    fail(`${command} ${args.join(" ")} could not run: ${result.error.message}`);
  }
  const ok = result.status === 0;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (!ok && !allowFailure) {
    fail(`${command} ${args.join(" ")} exited ${result.status}\n${(stderr || stdout).trim()}`);
  }
  return { ok, status: result.status, stdout, stderr };
}

function git(args, options) {
  return run("git", args, options);
}

function gitText(args, options) {
  return git(args, options).stdout.trim();
}

function runVisible(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: options.cwd || REPO_ROOT, stdio: "inherit" });
  if (result.error) {
    fail(`${command} ${args.join(" ")} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

function readLineSync(promptText) {
  process.stdout.write(promptText);
  const buffer = Buffer.alloc(1);
  let input = "";
  for (;;) {
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(0, buffer, 0, 1, null);
    } catch (error) {
      if (error.code === "EAGAIN") {
        sleepSync(25);
        continue;
      }
      throw error;
    }
    if (bytesRead === 0) {
      break;
    }
    const char = buffer.toString("utf8");
    if (char === "\n" || char === "\r") {
      break;
    }
    input += char;
  }
  return input.trim();
}

function confirm(question) {
  if (!process.stdin.isTTY) {
    fail(`${question} — non-interactive shell, re-run with --yes`);
  }
  const answer = readLineSync(`${LOG_PREFIX} ${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}

// --------------------------------------------------------------------------
// version helpers (mirror the workflow's strict v<MAJOR>.<MINOR>.<PATCH> rule)
// --------------------------------------------------------------------------

const NUMERIC_IDENTIFIER = /^(0|[1-9][0-9]*)$/;
const PRERELEASE_IDENTIFIER = /^(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)$/;

function parseVersion(value) {
  const text = String(value === null || value === undefined ? "" : value).trim().replace(/^v/, "");
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) {
    return null;
  }
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  const prerelease = match[4] || "";
  if (![major, minor, patch].every((part) => NUMERIC_IDENTIFIER.test(part))) {
    return null;
  }
  if (prerelease) {
    const identifiers = prerelease.split(".");
    if (!identifiers.every((identifier) => identifier.length > 0 && PRERELEASE_IDENTIFIER.test(identifier))) {
      return null;
    }
  }
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

function formatVersion(parsed) {
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ""}`;
}

function isValidReleaseTag(tag) {
  return typeof tag === "string" && tag.startsWith("v") && parseVersion(tag) !== null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    fail(`cannot compare versions: ${left} / ${right}`);
  }
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) {
      return a[key] < b[key] ? -1 : 1;
    }
  }
  if (a.prerelease === b.prerelease) {
    return 0;
  }
  if (!a.prerelease) {
    return 1;
  }
  if (!b.prerelease) {
    return -1;
  }
  return a.prerelease < b.prerelease ? -1 : 1;
}

function bumpVersion(current, kind) {
  const parsed = parseVersion(current);
  if (!parsed) {
    fail(`package.json version "${current}" is not MAJOR.MINOR.PATCH`);
  }
  if (kind === "major") {
    return formatVersion({ major: parsed.major + 1, minor: 0, patch: 0, prerelease: "" });
  }
  if (kind === "minor") {
    return formatVersion({ major: parsed.major, minor: parsed.minor + 1, patch: 0, prerelease: "" });
  }
  if (kind === "patch") {
    return formatVersion({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1, prerelease: "" });
  }
  fail(`unknown bump kind: ${kind}`);
  return "";
}

function resolveNextVersion(input, current) {
  const raw = String(input || "").trim();
  if (!raw) {
    fail("missing version argument (patch|minor|major|X.Y.Z)");
  }
  let next;
  if (["major", "minor", "patch"].includes(raw)) {
    next = bumpVersion(current, raw);
  } else {
    const parsed = parseVersion(raw);
    if (!parsed) {
      fail(`"${raw}" is not a valid version (expected patch|minor|major or X.Y.Z)`);
    }
    next = formatVersion(parsed);
  }
  if (compareVersions(next, current) <= 0) {
    fail(`next version ${next} is not greater than the current ${current}`);
  }
  return next;
}

// --------------------------------------------------------------------------
// release notes / installer expectations
// --------------------------------------------------------------------------

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function changelogEntry(changelog, version) {
  const lines = String(changelog || "").split(/\r?\n/);
  const heading = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`);
  const startIndex = lines.findIndex((line) => heading.test(line));
  if (startIndex === -1) {
    return null;
  }
  const collected = [lines[startIndex]];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      break;
    }
    collected.push(lines[index]);
  }
  while (collected.length > 1 && collected[collected.length - 1].trim() === "") {
    collected.pop();
  }
  return collected.join("\n");
}

function summarizeChangelogEntry(entry) {
  const lines = String(entry || "").split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].replace(/^[-*]\s*/, "").trim();
    if (line) {
      return line;
    }
  }
  return "";
}

// Per-platform installer names produced by electron-builder's artifactName
// `${productName}-${version}-${os}-${arch}.${ext}`. `required` marks the files
// this fork's healthy build always publishes; macOS is optional here because a
// fork without Apple credentials may not produce a signed/notarized leg.
function expectedInstallers(version) {
  const base = `Netcatty-${version}`;
  return [
    { name: `${base}-win-x64.exe`, platform: "windows", required: true },
    { name: `${base}-linux-x86_64.AppImage`, platform: "linux", required: true },
    { name: `${base}-linux-arm64.AppImage`, platform: "linux", required: true },
    { name: `${base}-linux-amd64.deb`, platform: "linux", required: true },
    { name: `${base}-linux-arm64.deb`, platform: "linux", required: true },
    { name: `${base}-linux-x86_64.rpm`, platform: "linux", required: false },
    { name: `${base}-linux-aarch64.rpm`, platform: "linux", required: false },
    { name: `${base}-linux-x64.pacman`, platform: "linux", required: false },
    { name: `${base}-linux-aarch64.pacman`, platform: "linux", required: false },
    { name: `${base}-mac-arm64.dmg`, platform: "macos", required: false },
    { name: `${base}-mac-x64.dmg`, platform: "macos", required: false },
  ];
}

function classifyReleaseAssets(assetNames, version) {
  const present = new Set((assetNames || []).map((name) => String(name)));
  const expected = expectedInstallers(version);
  const found = [];
  const missing = [];
  for (const item of expected) {
    (present.has(item.name) ? found : missing).push(item);
  }
  const expectedNames = new Set(expected.map((item) => item.name));
  const extra = [...present].filter((name) => !expectedNames.has(name)).sort();
  return { found, missing, extra };
}

// --------------------------------------------------------------------------
// file edits (targeted, so the diff stays one line per field)
// --------------------------------------------------------------------------

function withPackageVersion(text, version) {
  const pattern = /("version"\s*:\s*")([^"]*)(")/;
  if (!pattern.test(text)) {
    fail("package.json has no \"version\" field");
  }
  return text.replace(pattern, (match, prefix, _old, suffix) => `${prefix}${version}${suffix}`);
}

function withLockfileVersion(text, version) {
  const replaced = String(text).replace(/("version"\s*:\s*")([^"]*)(")/, (match, prefix, _old, suffix) => `${prefix}${version}${suffix}`);
  const rootEntry = /("packages"\s*:\s*\{\s*"":\s*\{)([\s\S]*?)(\n\s*\})/.exec(replaced);
  if (!rootEntry) {
    return replaced;
  }
  const updatedBlock = rootEntry[2].replace(/("version"\s*:\s*")([^"]*)(")/, (match, prefix, _old, suffix) => `${prefix}${version}${suffix}`);
  return `${replaced.slice(0, rootEntry.index)}${rootEntry[1]}${updatedBlock}${rootEntry[3]}${replaced.slice(rootEntry.index + rootEntry[0].length)}`;
}

function parseRepoFromRemote(url) {
  const text = String(url || "").trim();
  const scpStyle = /^git@([^:]+):(.+)$/.exec(text);
  if (scpStyle) {
    return { host: scpStyle[1], slug: scpStyle[2].replace(/\.git$/, "") };
  }
  const urlStyle = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::[0-9]+)?\/(.+)$/.exec(text);
  if (urlStyle) {
    return { host: urlStyle[1], slug: urlStyle[2].replace(/\.git$/, "") };
  }
  return null;
}

// --------------------------------------------------------------------------
// GitHub access (gh CLI; anonymous is enough for a public repo)
// --------------------------------------------------------------------------

function ghAuthenticated() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    return true;
  }
  return run("gh", ["auth", "status"], { allowFailure: true }).ok;
}

function isRateLimited(text) {
  return /rate limit|api rate limit exceeded|secondary rate limit/i.test(String(text || ""));
}

function ghApiJson(endpoint) {
  const result = run("gh", ["api", endpoint], { allowFailure: true });
  if (!result.ok) {
    return { ok: false, error: (result.stderr || result.stdout || "").trim() };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `invalid JSON from gh api ${endpoint}: ${error.message}` };
  }
}

function findRunForRef(slug, tag, sha) {
  const result = ghApiJson(`repos/${slug}/actions/runs?per_page=50`);
  if (!result.ok) {
    return result;
  }
  const runs = Array.isArray(result.data.workflow_runs) ? result.data.workflow_runs : [];
  const matches = runs
    .filter((item) => item.head_branch === tag || (sha && item.head_sha === sha))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { ok: true, run: matches[0] || null };
}

function getRelease(slug, tag) {
  const result = ghApiJson(`repos/${slug}/releases/tags/${tag}`);
  if (!result.ok) {
    if (/not found|404/i.test(result.error)) {
      return { ok: true, release: null };
    }
    return result;
  }
  return { ok: true, release: result.data };
}

// --------------------------------------------------------------------------
// context + remote refs
// --------------------------------------------------------------------------

function loadContext() {
  if (!git(["rev-parse", "--is-inside-work-tree"], { allowFailure: true }).ok) {
    fail(`${REPO_ROOT} is not a git work tree`);
  }
  const remote = gitText(["remote", "get-url", "origin"]);
  const parsed = parseRepoFromRemote(remote);
  if (!parsed) {
    fail(`cannot parse a GitHub repository out of the origin remote: ${remote}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  return {
    root: REPO_ROOT,
    slug: parsed.slug,
    remote,
    branch: run("git", ["symbolic-ref", "--short", "HEAD"], { allowFailure: true }).stdout.trim(),
    currentVersion: String(pkg.version),
    ghAuthenticated: ghAuthenticated(),
  };
}

function remoteTagLines(tag) {
  const result = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { allowFailure: true });
  if (!result.ok) {
    return [];
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function remoteTagSha(tag) {
  const lines = remoteTagLines(tag);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  if (peeled) {
    return peeled.split(/\s+/)[0];
  }
  const direct = lines.find((line) => line.endsWith(`refs/tags/${tag}`));
  return direct ? direct.split(/\s+/)[0] : "";
}

function headShaForTag(tag) {
  const result = git(["rev-parse", `${tag}^{}`], { allowFailure: true });
  return result.ok ? result.stdout.trim() : "";
}

// --------------------------------------------------------------------------
// verification
// --------------------------------------------------------------------------

function describeRunStatus(run) {
  return `${run.event} | ${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`;
}

async function waitForRunCreated(context, { tag, sha, timeoutMs = DEFAULT_RUN_CREATE_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = context.ghAuthenticated ? 10_000 : 15_000;
  let warned = false;
  while (Date.now() < deadline) {
    const found = findRunForRef(context.slug, tag, sha);
    if (!found.ok) {
      if (isRateLimited(found.error)) {
        warn("gh api is rate limited (anonymous); stop polling and check the Actions tab manually");
        return null;
      }
      warn(`gh api failed: ${found.error.split("\n")[0]}`);
    } else if (found.run) {
      log(`workflow run created: #${found.run.run_number} (${describeRunStatus(found.run)}) ${found.run.html_url}`);
      return found.run;
    }
    if (!warned) {
      log(`waiting for a workflow run on ${tag} ...`);
      warned = true;
    }
    await sleep(intervalMs);
  }
  return null;
}

async function waitForRunCompletion(context, run, { timeoutMs }) {
  const intervalMs = context.ghAuthenticated ? 30_000 : 60_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = ghApiJson(`repos/${context.slug}/actions/runs/${run.id}`);
    if (result.ok) {
      const current = result.data;
      if (current.status === "completed") {
        log(`run #${current.run_number} completed: ${current.conclusion} (${current.html_url})`);
        return current;
      }
      log(`... run #${current.run_number} ${current.status}`);
    } else if (isRateLimited(result.error)) {
      warn("gh api is rate limited (anonymous); stop polling, check the run URL manually");
      return null;
    }
    await sleep(intervalMs);
  }
  warn(`run #${run.run_number} did not finish within ${Math.round(timeoutMs / 60000)} min`);
  return null;
}

async function printRunJobs(context, runId) {
  const result = ghApiJson(`repos/${context.slug}/actions/runs/${runId}/jobs?per_page=100`);
  if (!result.ok) {
    return;
  }
  for (const job of result.data.jobs || []) {
    console.log(`${LOG_PREFIX}   job ${job.name}: ${job.status}${job.conclusion ? `/${job.conclusion}` : ""}`);
  }
}

function reportAssets(release, version) {
  const names = (release.assets || []).map((asset) => asset.name);
  const report = classifyReleaseAssets(names, version);
  const byPlatform = new Map();
  for (const item of report.found) {
    byPlatform.set(item.platform, (byPlatform.get(item.platform) || []).concat(item.name));
  }
  log(`release ${release.tag_name}: ${names.length} asset(s) attached`);
  for (const [platform, items] of byPlatform) {
    log(`  ${platform}: ${items.length} installer(s)`);
  }
  const missingRequired = report.missing.filter((item) => item.required);
  const missingOptional = report.missing.filter((item) => !item.required);
  if (missingRequired.length > 0) {
    warn(`required installers missing: ${missingRequired.map((item) => item.name).join(", ")}`);
  }
  if (missingOptional.length > 0) {
    log(`optional installers not published this run: ${missingOptional.map((item) => item.name).join(", ")}`);
  }
  return { ok: names.length > 0 && missingRequired.length === 0, names, report };
}

async function verifyRelease(context, tag, version) {
  const version_ = version || tag.replace(/^v/, "");
  const result = getRelease(context.slug, tag);
  if (!result.ok) {
    warn(`could not read the release for ${tag}: ${result.error.split("\n")[0]}`);
    return { ok: false };
  }
  if (!result.release) {
    warn(`no GitHub Release exists for ${tag} — the workflow's release job has not published yet`);
    return { ok: false };
  }
  const assets = reportAssets(result.release, version_);
  if (assets.ok) {
    log(`OK: ${tag} is published with installers`);
  }
  return assets;
}

function noRunGuidance(tag) {
  warn(`no workflow run was created for ${tag}.`);
  warn("The tag is on origin but GitHub never queued `build-packages`, so the release stays asset-less.");
  warn(`Fix it with:  node scripts/release.cjs --retry ${tag} --yes`);
  warn("If a re-trigger also produces no run, the repository's Actions side is the problem:");
  warn("  gh auth login   # then  gh workflow run build.yml --ref " + tag + " -f publish_release=true");
  warn("  or check Settings -> Actions on github.com/hdklab/Netcatty (workflow must be enabled).");
}

// --------------------------------------------------------------------------
// commands
// --------------------------------------------------------------------------

function printHelp() {
  console.log(`${LOG_PREFIX} Netcatty release driver

  node scripts/release.cjs <patch|minor|major|X.Y.Z> [flags]
      bump package.json/package-lock.json, commit "chore(release): X.Y.Z",
      create the annotated tag vX.Y.Z, push main + tag, then wait for CI and
      verify the installers landed on the GitHub Release.

  node scripts/release.cjs --status [vX.Y.Z]
      read-only: current version, tag sha, workflow run and release assets.

  node scripts/release.cjs --retry vX.Y.Z [--yes]
      a tag with no workflow run (or a release with 0 assets): dispatch
      ${BUILD_WORKFLOW_FILE} on the tag when gh is authenticated, otherwise delete
      and re-push the tag, then verify the installers.

  flags:
    --dry-run              print the plan, change nothing
    --yes, -y              do not ask for confirmation (required off a TTY)
    --no-push              commit + tag locally, skip the push (and the wait)
    --no-changelog-check   allow a release without a CHANGELOG.md section
    --timeout <minutes>    how long to wait for the build (default ${DEFAULT_RUN_TIMEOUT_MINUTES})
    --help, -h             this text
`);
}

function parseArgs(argv) {
  const options = {
    mode: "release",
    version: null,
    retryTag: null,
    statusTag: null,
    dryRun: false,
    yes: false,
    push: true,
    requireChangelog: true,
    timeoutMinutes: DEFAULT_RUN_TIMEOUT_MINUTES,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--no-push") {
      options.push = false;
    } else if (arg === "--no-changelog-check") {
      options.requireChangelog = false;
    } else if (arg === "--status") {
      options.mode = "status";
    } else if (arg === "--retry") {
      options.mode = "retry";
      options.retryTag = argv[index + 1] || null;
      index += 1;
    } else if (arg === "--timeout") {
      options.timeoutMinutes = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.mode = "help";
    } else if (arg.startsWith("-")) {
      fail(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (options.mode === "release") {
    options.version = positional[0] || null;
  }
  if (options.mode === "status") {
    options.statusTag = positional[0] || null;
  }
  return options;
}

async function releaseCommand(context, options) {
  const nextVersion = resolveNextVersion(options.version, context.currentVersion);
  const tag = `v${nextVersion}`;
  log(`repo ${context.slug} | version ${context.currentVersion} -> ${nextVersion} | tag ${tag}`);

  if (context.branch !== "main") {
    fail(`release from main (currently on ${context.branch || "a detached HEAD"})`);
  }
  git(["fetch", "origin", "--tags"]);
  const head = gitText(["rev-parse", "HEAD"]);
  const upstream = gitText(["rev-parse", "origin/main"]);
  if (head !== upstream) {
    fail(`HEAD ${head.slice(0, 8)} is not origin/main ${upstream.slice(0, 8)} — push or fast-forward first`);
  }

  const allowedDirty = new Set(["package.json", "package-lock.json", "CHANGELOG.md"]);
  const staged = gitText(["diff", "--cached", "--name-only"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const stagedOutside = staged.filter((file) => !allowedDirty.has(file));
  if (stagedOutside.length > 0) {
    fail(`staged changes outside the release files would be swept into the release commit: ${stagedOutside.join(", ")}`);
  }
  const inProgress = gitText(["status", "--porcelain"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\S+\s+/, "").replace(/^(.*) -> (.*)$/, "$2"))
    .filter((file) => file && !allowedDirty.has(file) && !staged.includes(file));
  if (inProgress.length > 0) {
    warn(`other work in progress is left untouched (not committed): ${inProgress.join(", ")}`);
  }

  if (git(["rev-parse", "--verify", `refs/tags/${tag}`], { allowFailure: true }).ok) {
    fail(`tag ${tag} already exists locally`);
  }
  if (remoteTagLines(tag).length > 0) {
    fail(`tag ${tag} already exists on origin`);
  }

  const changelogPath = path.join(context.root, "CHANGELOG.md");
  const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, "utf8") : "";
  const entry = changelogEntry(changelog, nextVersion);
  if (!entry) {
    if (options.requireChangelog && !options.dryRun) {
      fail(`CHANGELOG.md has no "## [${nextVersion}]" section — write the release notes first (or pass --no-changelog-check)`);
    }
    warn(`CHANGELOG.md has no "## [${nextVersion}]" section`);
  } else {
    log(`CHANGELOG.md section found (${entry.split("\n").length} lines)`);
  }

  const summary = summarizeChangelogEntry(entry || "");
  const commitSubject = `chore(release): ${nextVersion}`;
  const commitBody = [
    summary ? `发布 ${nextVersion}：${summary}` : `发布 ${nextVersion}`,
    "",
    `- package.json / package-lock.json 版本 ${context.currentVersion} -> ${nextVersion}`,
    `- CHANGELOG.md 收录 ${nextVersion} 段`,
    `- 安装包由 ${BUILD_WORKFLOW_FILE} 的 release job 上传（本地不要手工创建 Release）`,
  ].join("\n");

  log("plan:");
  log(`  1. edit package.json + package-lock.json version -> ${nextVersion}`);
  log(`  2. git commit -m "${commitSubject}"`);
  log(`  3. git tag -a ${tag} -m "release: ${tag}"`);
  if (options.push) {
    log(`  4. git push origin main && git push origin ${tag}`);
    log(`  5. wait for build-packages on ${tag}, then verify installer assets`);
  } else {
    log("  4. push skipped (--no-push)");
  }

  if (options.dryRun) {
    log("--dry-run: nothing changed");
    return 0;
  }
  if (!options.yes && !confirm(`proceed with commit + tag${options.push ? " + push" : ""}?`)) {
    log("aborted");
    return 0;
  }

  const packagePath = path.join(context.root, "package.json");
  const lockPath = path.join(context.root, "package-lock.json");
  fs.writeFileSync(packagePath, withPackageVersion(fs.readFileSync(packagePath, "utf8"), nextVersion));
  if (fs.existsSync(lockPath)) {
    const before = fs.readFileSync(lockPath, "utf8");
    const after = withLockfileVersion(before, nextVersion);
    if (after === before) {
      warn("package-lock.json version fields unchanged (cosmetic only; npm ci does not validate them)");
    }
    fs.writeFileSync(lockPath, after);
  }

  git(["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
  const stagedStat = git(["diff", "--cached", "--stat"]).stdout.trim();
  if (stagedStat) {
    log("staged for the release commit:");
    for (const line of stagedStat.split("\n")) {
      log(`  ${line}`);
    }
  }
  git(["commit", "-m", commitSubject, "-m", commitBody]);
  log(`committed ${gitText(["rev-parse", "--short", "HEAD"])}`);

  git(["tag", "-a", tag, "-m", `release: ${tag}`]);
  log(`created annotated tag ${tag}`);

  if (!options.push) {
    log("--no-push: publish later with");
    log(`  git push origin main && git push origin ${tag}`);
    return 0;
  }

  runVisible("git", ["push", "origin", "main"]);
  runVisible("git", ["push", "origin", tag]);

  const sha = headShaForTag(tag);
  const run = await waitForRunCreated(context, { tag, sha });
  if (!run) {
    noRunGuidance(tag);
    return 1;
  }

  const finished = await waitForRunCompletion(context, run, { timeoutMs: options.timeoutMinutes * 60_000 });
  if (finished) {
    await printRunJobs(context, finished.id);
  }
  const assets = await verifyRelease(context, tag, nextVersion);
  if (!assets.ok) {
    warn(`release ${tag} is not complete yet — re-check with: node scripts/release.cjs --status ${tag}`);
    return 1;
  }
  return 0;
}

function resolveStatusTag(context, options) {
  if (!options.statusTag) {
    return `v${context.currentVersion}`;
  }
  const raw = String(options.statusTag).trim();
  const tag = raw.startsWith("v") ? raw : `v${raw}`;
  if (!isValidReleaseTag(tag)) {
    fail(`"${options.statusTag}" is not a v<MAJOR>.<MINOR>.<PATCH> tag`);
  }
  return tag;
}

async function statusCommand(context, options) {
  const tag = resolveStatusTag(context, options);
  const version = tag.replace(/^v/, "");
  const sha = remoteTagSha(tag);
  if (!sha) {
    fail(`tag ${tag} does not exist on origin`);
  }
  const localSha = headShaForTag(tag);
  log(`repo ${context.slug} | package.json ${context.currentVersion} | tag ${tag}`);
  log(`origin tag -> ${sha.slice(0, 8)}${localSha && localSha !== sha ? ` | LOCAL tag differs: ${localSha.slice(0, 8)}` : ""}`);
  if (!context.ghAuthenticated) {
    warn("gh is not authenticated: reads use the anonymous API (60 requests/hour)");
  }

  const found = findRunForRef(context.slug, tag, sha);
  if (!found.ok) {
    warn(`could not list workflow runs: ${found.error.split("\n")[0]}`);
  } else if (!found.run) {
    warn(`NO workflow run exists for ${tag} — the release cannot have installers`);
    log(`retry with: node scripts/release.cjs --retry ${tag} --yes`);
  } else {
    const run = found.run;
    log(`run #${run.run_number} (${describeRunStatus(run)}) created ${run.created_at}`);
    log(`  ${run.html_url}`);
    const finished = run.status === "completed" ? run : await waitForRunCompletion(context, run, { timeoutMs: options.timeoutMinutes * 60_000 });
    if (finished) {
      await printRunJobs(context, finished.id);
    }
  }

  const assets = await verifyRelease(context, tag, version);
  if (!assets.ok) {
    return 1;
  }
  return 0;
}

async function retryCommand(context, options) {
  const raw = String(options.retryTag || "").trim();
  const tag = raw.startsWith("v") ? raw : `v${raw}`;
  if (!isValidReleaseTag(tag)) {
    fail("--retry needs a v<MAJOR>.<MINOR>.<PATCH> tag, e.g. --retry v1.1.93");
  }
  const sha = remoteTagSha(tag);
  if (!sha) {
    fail(`tag ${tag} does not exist on origin — publish it normally with scripts/release.cjs <version>`);
  }
  const version = tag.replace(/^v/, "");
  log(`retry ${tag} (origin -> ${sha.slice(0, 8)})`);

  const existing = findRunForRef(context.slug, tag, sha);
  if (existing.ok && existing.run) {
    log(`existing run #${existing.run.run_number} (${describeRunStatus(existing.run)}) ${existing.run.html_url}`);
  } else if (existing.ok) {
    warn(`no workflow run exists for ${tag} yet`);
  }

  const release = getRelease(context.slug, tag);
  if (release.ok && release.release) {
    const names = (release.release.assets || []).map((asset) => asset.name);
    log(`release ${tag} currently has ${names.length} asset(s)`);
    if (names.length > 0) {
      const assets = reportAssets(release.release, version);
      if (assets.ok) {
        log(`${tag} already carries installers; nothing to retry`);
        return 0;
      }
    }
  }

  if (!options.dryRun && !options.yes && !confirm(`trigger ${BUILD_WORKFLOW_FILE} for ${tag}?`)) {
    log("aborted");
    return 0;
  }
  if (options.dryRun) {
    log("--dry-run: nothing triggered");
    return 0;
  }

  if (context.ghAuthenticated) {
    runVisible("gh", ["workflow", "run", BUILD_WORKFLOW_FILE, "--ref", tag, "-f", "publish_release=true"]);
  } else {
    warn("gh is not authenticated, falling back to a tag re-push (delete + push creates a new push event)");
    const localSha = headShaForTag(tag);
    if (localSha !== sha) {
      fail(`local tag ${tag} (${localSha ? localSha.slice(0, 8) : "missing"}) does not match origin (${sha.slice(0, 8)}); fetch the tag first`);
    }
    runVisible("git", ["push", "origin", `:refs/tags/${tag}`]);
    runVisible("git", ["push", "origin", `refs/tags/${tag}`]);
  }

  const run = await waitForRunCreated(context, { tag, sha });
  if (!run) {
    noRunGuidance(tag);
    return 1;
  }
  const finished = await waitForRunCompletion(context, run, { timeoutMs: options.timeoutMinutes * 60_000 });
  if (finished && finished.conclusion !== "success") {
    warn(`run finished ${finished.conclusion}: platform legs can fail individually, check the jobs above`);
  }
  if (finished) {
    await printRunJobs(context, finished.id);
  }
  const assets = await verifyRelease(context, tag, version);
  if (!assets.ok) {
    warn(`release ${tag} still has no installers — inspect ${run.html_url}`);
    return 1;
  }
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === "help") {
    printHelp();
    return 0;
  }
  const context = loadContext();
  if (options.mode === "status") {
    return statusCommand(context, options);
  }
  if (options.mode === "retry") {
    return retryCommand(context, options);
  }
  return releaseCommand(context, options);
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code || 0;
    })
    .catch((error) => {
      console.error(`${LOG_PREFIX} ERROR ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  BUILD_WORKFLOW_FILE,
  bumpVersion,
  changelogEntry,
  classifyReleaseAssets,
  compareVersions,
  escapeRegExp,
  expectedInstallers,
  findRunForRef,
  formatVersion,
  isValidReleaseTag,
  main,
  parseArgs,
  parseRepoFromRemote,
  parseVersion,
  resolveNextVersion,
  resolveStatusTag,
  summarizeChangelogEntry,
  withLockfileVersion,
  withPackageVersion,
};
