const test = require("node:test");
const assert = require("node:assert/strict");

const { checkForUpdatesWithRetry, describeUpdateError } = require("./autoUpdateBridge.cjs");

test("a check that fails once and then succeeds is retried, not surfaced", async () => {
  let calls = 0;
  const updater = {
    async checkForUpdates() {
      calls += 1;
      if (calls === 1) throw new Error("Fail to fetch");
      return { updateInfo: { version: "1.1.88" } };
    },
  };
  const outcome = await checkForUpdatesWithRetry(updater);
  assert.equal(calls, 2, "the failed attempt must be retried once");
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result.updateInfo.version, "1.1.88");
});

test("a check that keeps failing reports the last error after the retries", async () => {
  let calls = 0;
  const updater = {
    async checkForUpdates() {
      calls += 1;
      throw new Error("Fail to fetch");
    },
  };
  const outcome = await checkForUpdatesWithRetry(updater);
  assert.equal(calls, 3, "two retries on top of the first attempt");
  assert.ok(outcome.error instanceof Error);
  assert.match(outcome.error.message, /Fail to fetch/);
});

test("errors carry the HTTP status or error code when the updater provides one", () => {
  const httpError = new Error("Fail to fetch");
  httpError.statusCode = 404;
  assert.equal(describeUpdateError(httpError), "Fail to fetch (HTTP 404)");

  const netError = new Error("net::ERR_NAME_NOT_RESOLVED");
  netError.code = "ERR_NAME_NOT_RESOLVED";
  assert.equal(describeUpdateError(netError), "net::ERR_NAME_NOT_RESOLVED (ERR_NAME_NOT_RESOLVED)");

  assert.equal(describeUpdateError(new Error("plain")), "plain");
  assert.equal(describeUpdateError(undefined), "Unknown update check error");

  // electron-updater's real "release not published yet" shape: no statusCode,
  // and the raw 404 plus a stack trace stuffed into the message.
  const channelError = new Error(
    'Cannot find channel "latest-linux.yml" update info: HttpError: 404 Not Found\n' +
      "    at GenericProvider.getLatestVersion (/app/node_modules/electron-updater/out/providers/GenericProvider.js:26:23)",
  );
  channelError.code = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
  const described = describeUpdateError(channelError);
  assert.match(described, /latest-\*\.yml/, "says which metadata is missing");
  assert.match(described, /HTTP 404/, "keeps the status even though the error carries none");
  assert.ok(!described.includes("at GenericProvider"), "the stack never reaches the UI");

  // Multi-line messages are reduced to their first line whatever the code.
  const multiline = new Error("boom\n    at somewhere.js:1:1");
  multiline.code = "ERR_SOMETHING";
  assert.equal(describeUpdateError(multiline), "boom (ERR_SOMETHING)");
});
