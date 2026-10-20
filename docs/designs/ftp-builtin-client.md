# FTP/FTPS file access without an external client

Status: **implemented** (replaces the external `lftp` driver).
Ask: 「lftp 可不可以打包到 Netcatty 中发现用户使用比较麻烦，兼容不同的平台」 → then
「换成 basic-ftp 吧，更方便些」.

## Goal

Hosts whose only file service is FTP/FTPS (telnet / serial devices, no SSH at all) must be
browsable and transferable on every supported platform **without the user installing anything**.

Non-goals: SFTP/SCP parity (chmod, symlinks, per-path stat), active-mode FTP, lftp's
mirror/parallel/queue features — the app never used them.

## Why not bundle the lftp binary

- Windows has no official build: only Cygwin/MSYS2 packages, i.e. the `msys-2.0.dll` +
  gnutls/readline «DLL bag» this repo already rejected when it picked MoshCatty for mosh
  (`scripts/fetch-mosh-binaries.cjs` header).
- macOS bottles link `/opt/homebrew` paths and a chain of dylibs (libidn2, openssl, readline,
  gettext); shipping it means static builds plus per-arch codesigning/notarization.
- Linux needs static glibc avoidance or a musl rebuild — a third binary pipeline to maintain.
- lftp is GPLv3+; shipping the binary is aggregation but requires source/offer bookkeeping.

## Chosen approach

`basic-ftp` (MIT, zero dependencies) runs inside the Electron main process.

| Concern | Before (`lftp`) | After (`basic-ftp`) |
|---|---|---|
| Install | user installs lftp or points at a path | nothing |
| Connection | one process per operation | one control connection per session, serialized |
| Listing | hand-rolled `cls -l` parser (+ `cls -1` fallback) | `list()` — MLSD with Unix/DOS fallback |
| Progress | `/proc/<pid>/io` poll (Linux only) and file-size poll | `trackProgress()` byte counter on upload and download |
| Abort | `SIGKILL` the child | `client.close()` (socket close), transparent reconnect |
| Path safety | shell-style quoting inside a script file | raw FTP commands with CR/LF rejection |
| Credentials | 0600 script in the app temp dir | FTP `USER`/`PASS` on the wire only |
| FTPS | `ftp:ssl-force` | explicit TLS (`secure: true`), implicit supported |
| Error codes | text sniffing of lftp stderr | FTP reply codes (530/550/552/553) mapped to `EAUTH`/`ENOENT`/`ENOSPC`/`EACCES` |

Deleted with it: Settings → 文件传输 → 「FTP 客户端（lftp）」, `netcatty_lftp_path_v1`,
`useFtpClientLftpPath.ts`, the `ftpCapabilities` "is lftp installed" probe, `NETCATTY_LFTP_PATH`,
and the `no-lftp` drag-drop refusal path.

## Implementation map

- `electron/bridges/sftpBridge/ftpBackend.cjs` — the backend (list/stat/realpath/mkdir/remove/
  rename/read/write/upload/download + abort), plus `uploadFilesToEndpoint` for drop uploads.
  `clientFactory` is the test seam.
- `electron/bridges/ftpBridge.cjs` — IPC edge: `netcatty:ftp:capabilities` (always available),
  `netcatty:ftp:upload` (stages in-memory drops, then uploads) and
  `netcatty:ftp:cancel-upload`. Uploads push throttled `netcatty:ftp:upload-progress`
  frames (`{uploadId, transferred, total, speed}`) to the requesting window, and an
  `AbortController` per upload lets the transfer center's Cancel close the data
  connection and drop the half-written file.
- `electron/bridges/sftpBridge/ftpSession.cjs`, `fileOps.cjs`, `remoteFileBackend.cjs` — unchanged
  contract; only the `settings:` lftp option is gone.
- Tests: `electron/bridges/ftpBackend.test.cjs`, `ftpBridge.test.cjs` drive the real backend
  against `electron/bridges/ftpTestClient.cjs` (scripted client, in-memory tree).

## Verification performed

- `node --test` on the FTP suites + `lib/ftpDragDrop.test.ts` + `domain/sftpFtpHost.test.ts` +
  capability dispatch suites: 77/77 pass; `application/state/sftp/*` + `AppHandlers.connect`:
  487/487 pass on Node 22 (Node 25 here cannot import the transfer store — environment gap).
- Live protocol run against `pyftpdlib` (127.0.0.1:2121) driving `createFtpBackend` directly:
  15/15 checks — list, mkdir -p, write/read, upload and download with byte progress, staged
  download, streaming download (caller stream stays open), rename, ENOTEMPTY, recursive delete,
  abort mid-transfer (ABORT_ERR, no `.part`, reconnect works), wrong password → EAUTH.
- FTPS against a self-signed pyftpdlib TLS server: works with `insecure: true`, rejected with
  `EFTP` («self-signed certificate») when verification is on.
- Packaged app (`release/linux-unpacked`, asar contains `node_modules/basic-ftp`), driven over CDP
  through the real bridge: `openSftp{fileProtocol:'ftp'}` → list → mkdir → write → read → stat →
  realpath → rename → delete file → delete dir → close. Main log:
  `[SFTP] Connection established … (protocol=ftp 127.0.0.1:2121)`.
- Drag-drop progress in the packaged app: subscribing `onFtpUploadProgress` and uploading a 120 MB
  file produced 5 monotonic frames in 817 ms (`0 → 63 → 100 %`, with `total` known from the first
  frame), so the transfer-center row is a real bar rather than a spinner.

## Known gaps

- FTP remains passive-mode only (the lftp path was too).
- `permissions` in the file list stays empty unless the server's LIST carries mode bits; MLSD
  does not.
- Terminal drag-drop uploads report byte progress, but the row cannot be paused/cancelled: the
  main process has no per-upload id to interrupt (the file panel's transfers can).
