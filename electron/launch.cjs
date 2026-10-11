const { spawn } = require("node:child_process");
const electronPath = require("electron"); // returns binary path
const { applyElectronLaunchEnv } = require("./launchEnv.cjs");

const env = applyElectronLaunchEnv(process.env);

// Extra CLI flags are forwarded to Electron so launchers can pass e.g.
// `--no-sandbox` or `--remote-debugging-port=9222` via `npm start -- --no-sandbox`.
const child = spawn(electronPath, [".", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));

// Forward SIGINT/SIGTERM to the Electron child process so Ctrl+C works
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) {
      child.kill(sig);
    }
  });
}
