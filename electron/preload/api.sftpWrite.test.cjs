const assert = require("node:assert/strict");
const test = require("node:test");
const { createPreloadApi } = require("./api.cjs");

function harness() {
  const invokes = [];
  const api = createPreloadApi({
    ipcRenderer: {
      send: () => {},
      on: () => {},
      removeListener: () => {},
      invoke: async (...args) => {
        invokes.push(args);
      },
    },
    webUtils: {},
  });
  return { api, invokes };
}

test("writeSftp keeps the historical LF normalization by default", async () => {
  const { api, invokes } = harness();
  await api.writeSftp("sftp-1", "/root/run.sh", "a\r\nb\r\n", undefined);
  assert.deepEqual(invokes[0], [
    "netcatty:sftp:write",
    {
      sftpId: "sftp-1",
      path: "/root/run.sh",
      content: "a\r\nb\r\n",
      encoding: undefined,
      preserveLineEndings: false,
    },
  ]);
});

test("writeSftp forwards the editor's preserveLineEndings opt-in", async () => {
  const { api, invokes } = harness();
  await api.writeSftp("sftp-1", "/win/run.bat", "a\r\nb\r\n", undefined, { preserveLineEndings: true });
  assert.equal(invokes[0][1].preserveLineEndings, true);
  assert.equal(invokes[0][1].content, "a\r\nb\r\n");
});
