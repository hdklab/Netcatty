const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bumpVersion,
  changelogEntry,
  classifyReleaseAssets,
  compareVersions,
  expectedInstallers,
  isValidReleaseTag,
  parseArgs,
  parseRepoFromRemote,
  parseVersion,
  resolveNextVersion,
  resolveStatusTag,
  summarizeChangelogEntry,
  withLockfileVersion,
  withPackageVersion,
} = require("./release.cjs");

test("parseVersion accepts plain and prerelease versions, rejects anything else", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: "" });
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: "" });
  assert.equal(parseVersion("1.2.3-rc.1").prerelease, "rc.1");
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("01.2.3"), null);
  assert.equal(parseVersion("1.2.3-01"), null);
  assert.equal(parseVersion("1.2.3+build"), null);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion(null), null);
});

test("isValidReleaseTag mirrors the workflow's strict v<MAJOR>.<MINOR>.<PATCH> gate", () => {
  assert.equal(isValidReleaseTag("v1.1.93"), true);
  assert.equal(isValidReleaseTag("v1.2.3-rc.1"), true);
  assert.equal(isValidReleaseTag("1.1.93"), false);
  assert.equal(isValidReleaseTag("v1.1"), false);
  assert.equal(isValidReleaseTag("v1.1.93.1"), false);
  assert.equal(isValidReleaseTag("v1.1.93-"), false);
  assert.equal(isValidReleaseTag("vNEXT"), false);
});

test("compareVersions orders releases and prereleases", () => {
  assert.equal(compareVersions("1.1.94", "1.1.93"), 1);
  assert.equal(compareVersions("1.1.93", "1.1.93"), 0);
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1);
  assert.equal(compareVersions("1.1.93", "1.1.93-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
});

test("bumpVersion handles patch/minor/major and drops prereleases", () => {
  assert.equal(bumpVersion("1.1.93", "patch"), "1.1.94");
  assert.equal(bumpVersion("1.1.93", "minor"), "1.2.0");
  assert.equal(bumpVersion("1.1.93", "major"), "2.0.0");
  assert.equal(bumpVersion("1.2.0-rc.1", "patch"), "1.2.1");
  assert.throws(() => bumpVersion("1.2", "patch"), /not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => bumpVersion("1.2.3", "tiny"), /unknown bump kind/);
});

test("resolveNextVersion takes a keyword or an explicit version and refuses to go backwards", () => {
  assert.equal(resolveNextVersion("patch", "1.1.93"), "1.1.94");
  assert.equal(resolveNextVersion("1.4.0", "1.1.93"), "1.4.0");
  assert.equal(resolveNextVersion("v1.4.0", "1.1.93"), "1.4.0");
  assert.throws(() => resolveNextVersion("1.1.93", "1.1.93"), /not greater/);
  assert.throws(() => resolveNextVersion("1.1.92", "1.1.93"), /not greater/);
  assert.throws(() => resolveNextVersion("next", "1.1.93"), /not a valid version/);
  assert.throws(() => resolveNextVersion("", "1.1.93"), /missing version/);
});

test("changelogEntry extracts exactly the requested section", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [1.1.94] - 2026-10-20",
    "",
    "### 功能",
    "- 新东西",
    "",
    "## [1.1.93] - 2026-10-15",
    "",
    "### 功能",
    "- 节点工作流",
    "",
  ].join("\n");
  const entry = changelogEntry(changelog, "1.1.93");
  assert.match(entry, /^## \[1\.1\.93\] - 2026-10-15/);
  assert.match(entry, /节点工作流/);
  assert.doesNotMatch(entry, /新东西/);
  assert.equal(changelogEntry(changelog, "1.1.92"), null);
  assert.equal(summarizeChangelogEntry(entry), "### 功能");
  assert.equal(summarizeChangelogEntry("## [1.0.0]\n- 首条\n- 第二条"), "首条");
});

test("expectedInstallers/classifyReleaseAssets report found, missing and unrelated assets", () => {
  const version = "1.1.93";
  const names = [
    `Netcatty-${version}-win-x64.exe`,
    `Netcatty-${version}-win-x64.exe.blockmap`,
    `Netcatty-${version}-linux-x86_64.AppImage`,
    `Netcatty-${version}-linux-amd64.deb`,
    `Netcatty-${version}-linux-arm64.deb`,
    `Netcatty-${version}-linux-arm64.AppImage`,
    `Netcatty-${version}-mac-arm64.dmg`,
    "latest.yml",
    "latest-mac.yml",
  ];
  const report = classifyReleaseAssets(names, version);
  assert.equal(report.missing.filter((item) => item.required).length, 0);
  assert.deepEqual(
    report.found.map((item) => item.name).sort(),
    expectedInstallers(version)
      .filter((item) => names.includes(item.name))
      .map((item) => item.name)
      .sort(),
  );
  assert.deepEqual(report.extra, [`Netcatty-${version}-win-x64.exe.blockmap`, "latest-mac.yml", "latest.yml"]);
  assert.ok(report.missing.some((item) => item.name === `Netcatty-${version}-mac-x64.dmg`));

  const empty = classifyReleaseAssets([], version);
  assert.equal(empty.found.length, 0);
  assert.equal(empty.missing.filter((item) => item.required).length, 5);
});

test("withPackageVersion rewrites only the top-level version field", () => {
  const pkg = ['{', '  "name": "netcatty",', '  "version": "1.1.93",', '  "dependencies": {', '    "left-pad": "1.1.93"', "  }", "}"].join("\n");
  const updated = withPackageVersion(pkg, "1.1.94");
  assert.match(updated, /"version": "1\.1\.94"/);
  assert.match(updated, /"left-pad": "1\.1\.93"/);
});

test("withLockfileVersion rewrites the two root entries and leaves dependencies alone", () => {
  const lock = [
    "{",
    '  "name": "netcatty",',
    '  "version": "1.1.93",',
    '  "lockfileVersion": 3,',
    '  "packages": {',
    '    "": {',
    '      "name": "netcatty",',
    '      "version": "1.1.93",',
    '      "license": "GPL-3.0-or-later"',
    "    },",
    '    "node_modules/left-pad": {',
    '      "version": "1.1.93"',
    "    }",
    "  }",
    "}",
  ].join("\n");
  const updated = withLockfileVersion(lock, "1.1.94");
  assert.match(updated, /^  "version": "1\.1\.94",$/m);
  assert.match(updated, /"name": "netcatty",\n      "version": "1\.1\.94",/);
  assert.match(updated, /"node_modules\/left-pad": \{\n      "version": "1\.1\.93"/);
  assert.equal(JSON.parse(updated).version, "1.1.94");
});

test("parseRepoFromRemote understands the remote shapes this repo uses", () => {
  assert.deepEqual(parseRepoFromRemote("git@github.com:hdklab/Netcatty.git"), { host: "github.com", slug: "hdklab/Netcatty" });
  assert.deepEqual(parseRepoFromRemote("https://github.com/hdklab/Netcatty.git"), { host: "github.com", slug: "hdklab/Netcatty" });
  assert.deepEqual(parseRepoFromRemote("https://github.com/hdklab/Netcatty"), { host: "github.com", slug: "hdklab/Netcatty" });
  assert.deepEqual(parseRepoFromRemote("ssh://git@github.com:22/hdklab/Netcatty.git"), { host: "github.com", slug: "hdklab/Netcatty" });
  assert.equal(parseRepoFromRemote(""), null);
  assert.equal(parseRepoFromRemote("/Volumes/MacintoshEx/Workspace/Netcatty"), null);
});

test("parseArgs wires the release/status/retry modes", () => {
  assert.deepEqual(parseArgs([]), {
    mode: "release",
    version: null,
    retryTag: null,
    statusTag: null,
    dryRun: false,
    yes: false,
    push: true,
    requireChangelog: true,
    timeoutMinutes: 60,
  });
  const release = parseArgs(["patch", "--yes", "--timeout", "25"]);
  assert.equal(release.version, "patch");
  assert.equal(release.yes, true);
  assert.equal(release.timeoutMinutes, 25);
  assert.equal(parseArgs(["1.2.0", "--dry-run", "--no-push"]).dryRun, true);
  assert.equal(parseArgs(["1.2.0", "--no-push"]).push, false);
  assert.equal(parseArgs(["--no-changelog-check", "patch"]).requireChangelog, false);
  assert.equal(parseArgs(["--retry", "v1.1.93"]).retryTag, "v1.1.93");
  assert.equal(parseArgs(["--status", "v1.1.93"]).statusTag, "v1.1.93");
  assert.equal(parseArgs(["--help"]).mode, "help");
  assert.throws(() => parseArgs(["--nope"]), /unknown flag/);
});

test("resolveStatusTag defaults to the package.json version", () => {
  const context = { currentVersion: "1.1.93" };
  assert.equal(resolveStatusTag(context, { statusTag: null }), "v1.1.93");
  assert.equal(resolveStatusTag(context, { statusTag: "1.1.92" }), "v1.1.92");
  assert.equal(resolveStatusTag(context, { statusTag: "v1.1.92" }), "v1.1.92");
  assert.throws(() => resolveStatusTag(context, { statusTag: "v1.1" }), /not a v<MAJOR>/);
});
