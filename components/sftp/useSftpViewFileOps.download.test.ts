import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SftpFileEntry } from "../../types";
import type { SftpConnection } from "../../domain/models";
import type { SftpPane } from "../../application/state/sftp/types";
import type { SftpStateApi } from "../../application/state/useSftpState";
import { useSftpViewFileOps } from "./hooks/useSftpViewFileOps";

const file = (
  name: string, size: number, type: SftpFileEntry["type"] = "file",
  linkTarget?: SftpFileEntry["linkTarget"],
): SftpFileEntry => ({
  name, size, type, linkTarget, lastModified: 0, sizeFormatted: "", lastModifiedFormatted: "",
});

test("single and batch downloads route by current remote type and size", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;

  const current = new Map<string, SftpStatResult>([
    ["/remote/smaller", { name: "smaller", size: 50_000, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/larger", { name: "larger", size: 50_000, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/became-dir", { name: "became-dir", size: 0, sizeKnown: true, type: "directory", lastModified: 0 }],
    ["/remote/became-file", { name: "became-file", size: 12, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/changes-in-picker", { name: "changes-in-picker", size: 15, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/type-changes-in-picker", { name: "type-changes-in-picker", size: 15, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/statless", { name: "statless", size: 0, sizeKnown: false, type: "file", lastModified: 0 }],
    ["/remote/file-link", { name: "file-link", size: 9, sizeKnown: true, type: "symlink", lastModified: 0 }],
    ["/remote/dir-link", { name: "dir-link", size: 9, sizeKnown: true, type: "symlink", lastModified: 0 }],
  ]);
  const downloads: Array<{ sourcePath: string; totalBytes?: number; isDirectory: boolean }> = [];
  let saveCalls = 0;
  let directoryCalls = 0;
  let onSave: (name: string) => void = () => undefined;
  const connection = { id: "conn-1", hostId: "host-1", hostLabel: "Host", currentPath: "/remote", isLocal: false };
  const pane = { connection, filenameEncoding: "auto" };
  const sftpRef = { current: {
    leftPane: pane, rightPane: pane,
    joinPath: (parent: string, name: string) => `${parent}/${name}`,
    downloadToLocal: async (params: { sourcePath: string; totalBytes?: number; isDirectory: boolean }) => {
      downloads.push(params);
      return "completed";
    },
  } as unknown as SftpStateApi };
  let ops: ReturnType<typeof useSftpViewFileOps> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    ops = useSftpViewFileOps({
      sftpRef,
      behaviorRef: { current: "" },
      autoSyncRef: { current: false },
      getOpenerForFileRef: { current: () => null },
      setOpenerForExtension: () => undefined,
      t: (key) => key,
      showSaveDialog: async (name) => { saveCalls++; onSave(name); return `/downloads/${name}`; },
      selectDirectory: async () => { directoryCalls++; return "/downloads"; },
      getSftpIdForConnection: () => "sftp-1",
      statSftp: async (_id, path) => current.get(path) ?? null as unknown as SftpStatResult,
      listSftp: async (_id, parent) => {
        assert.equal(parent, "/remote");
        return [
          { name: "file-link", type: "symlink", linkTarget: "file", size: "9 bytes", lastModified: "" },
          { name: "dir-link", type: "symlink", linkTarget: "directory", size: "9 bytes", lastModified: "" },
        ];
      },
    });
    return null;
  }

  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    const single = ops!.onDownloadFileLeft as unknown as (entry: SftpFileEntry) => Promise<void>;
    const batch = ops!.onDownloadFilesLeft as unknown as (entries: SftpFileEntry[]) => Promise<void>;

    await act(async () => { await single(file("smaller", 100_000)); });
    await act(async () => { await single(file("larger", 25_000)); });
    assert.deepEqual(downloads.map(({ totalBytes }) => totalBytes), [50_000, 50_000]);
    assert.equal(saveCalls, 2, "save dialog still opens for every single-file download");

    onSave = (name) => {
      if (name === "changes-in-picker") current.set("/remote/changes-in-picker", {
        name, size: 30, sizeKnown: true, type: "file", lastModified: 0,
      });
      if (name === "type-changes-in-picker") current.set("/remote/type-changes-in-picker", {
        name, size: 0, sizeKnown: true, type: "directory", lastModified: 0,
      });
    };
    await act(async () => { await single(file("changes-in-picker", 100)); });
    assert.equal(downloads.at(-1)?.totalBytes, 30, "size is checked again after Save As");
    const countBeforeTypeChange = downloads.length;
    await act(async () => { await single(file("type-changes-in-picker", 100)); });
    assert.equal(downloads.length, countBeforeTypeChange, "type changes during Save As abort the transfer");
    const countBeforeMissing = saveCalls;
    await act(async () => { await single(file("missing", 100_000)); });
    assert.equal(saveCalls, countBeforeMissing, "missing source never opens Save As");

    await act(async () => { await single(file("statless", 100_000)); });
    assert.equal(downloads.at(-1)?.totalBytes, undefined, "stat-less SCP does not use listed size");
    await act(async () => { await single(file("file-link", 9, "symlink", "directory")); });
    assert.equal(downloads.at(-1)?.isDirectory, false);
    assert.equal(downloads.at(-1)?.totalBytes, undefined, "link node size is not file size");

    await act(async () => { await single(file("became-dir", 100_000)); });
    assert.equal(downloads.at(-1)?.isDirectory, true);
    assert.equal(directoryCalls, 1);

    await act(async () => {
      await batch([
        file("became-file", 0, "directory"),
        file("missing", 100_000),
        file("dir-link", 9, "symlink", "file"),
      ]);
    });
    assert.equal(directoryCalls, 2, "batch chooses one directory");
    const becameFile = downloads.find(({ sourcePath }) => sourcePath === "/remote/became-file");
    assert.equal(becameFile?.isDirectory, false);
    assert.equal(becameFile?.totalBytes, 12);
    assert.equal(downloads.find(({ sourcePath }) => sourcePath === "/remote/dir-link")?.isDirectory, true);
    assert.equal(downloads.some(({ sourcePath }) => sourcePath === "/remote/missing"), false);
  } finally {
    await act(async () => { renderer?.unmount(); });
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

const makeConnection = (
  id: string, currentPath: string, isLocal: boolean,
): SftpConnection => ({
  id, hostId: `${id}-host`, hostLabel: id, isLocal, status: "connected", currentPath,
});

const makePane = (
  id: string, connection: SftpConnection | null, files: SftpFileEntry[] = [], selected: string[] = [],
): SftpPane => ({
  id,
  connection,
  files,
  loading: false,
  reconnecting: false,
  error: null,
  connectionLogs: [],
  selectedFiles: new Set(selected),
  filter: "",
  filenameEncoding: "auto",
  showHiddenFiles: false,
  transferMutationToken: 0,
});

interface DownloadPickerHarness {
  ops: ReturnType<typeof useSftpViewFileOps>;
  saveDialogCalls: unknown[][];
  selectDirectoryCalls: unknown[][];
  transferCalls: Array<{
    files: Array<{ name: string; isDirectory: boolean }>;
    sourceSide: string;
    targetSide: string;
    options: Record<string, unknown> | undefined;
  }>;
  renderer: ReactTestRenderer;
}

const renderDownloadOps = async (
  leftPane: SftpPane,
  rightPane: SftpPane,
  stats: Map<string, SftpStatResult>,
): Promise<DownloadPickerHarness> => {
  const saveDialogCalls: unknown[][] = [];
  const selectDirectoryCalls: unknown[][] = [];
  const transferCalls: DownloadPickerHarness["transferCalls"] = [];
  let ops: ReturnType<typeof useSftpViewFileOps> | undefined;
  let renderer: ReactTestRenderer | undefined;
  const sftpRef = {
    current: {
      leftPane,
      rightPane,
      joinPath: (parent: string, name: string) => `${parent}/${name}`,
      downloadToLocal: async () => "completed",
      startTransfer: async (
        files: Array<{ name: string; isDirectory: boolean }>,
        sourceSide: string,
        targetSide: string,
        options?: Record<string, unknown>,
      ) => {
        transferCalls.push({ files, sourceSide, targetSide, options });
        return [];
      },
    } as unknown as SftpStateApi,
  };

  function Probe() {
    ops = useSftpViewFileOps({
      sftpRef,
      behaviorRef: { current: "" },
      autoSyncRef: { current: false },
      getOpenerForFileRef: { current: () => null },
      setOpenerForExtension: () => undefined,
      t: (key) => key,
      // Record the raw argument lists so "no defaultPath" stays observable.
      showSaveDialog: async (...args: unknown[]) => {
        saveDialogCalls.push(args);
        return "/chosen/target";
      },
      selectDirectory: async (...args: unknown[]) => {
        selectDirectoryCalls.push(args);
        return "/chosen";
      },
      getSftpIdForConnection: () => "sftp-1",
      statSftp: async (_id, path) => stats.get(path) ?? (null as unknown as SftpStatResult),
      listSftp: async () => [],
    });
    return null;
  }

  await act(async () => { renderer = create(React.createElement(Probe)); });
  return {
    ops: ops as ReturnType<typeof useSftpViewFileOps>,
    saveDialogCalls,
    selectDirectoryCalls,
    transferCalls,
    renderer: renderer as ReactTestRenderer,
  };
};

test("downloads are delivered into the opposite pane folder, local or remote", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;

  const stats = new Map<string, SftpStatResult>([
    ["/remote/report.txt", { name: "report.txt", size: 12, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/folder", { name: "folder", size: 0, sizeKnown: true, type: "directory", lastModified: 0 }],
    ["/remote/a.txt", { name: "a.txt", size: 3, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/b.txt", { name: "b.txt", size: 4, sizeKnown: true, type: "file", lastModified: 0 }],
  ]);
  const localPane = makePane(
    "local", makeConnection("local", "/home/me/projects", true),
    [file("docs", 0, "directory"), file("notes.txt", 10)],
  );
  const remotePane = makePane(
    "remote", makeConnection("remote", "/remote", false),
    [file("report.txt", 12), file("folder", 0, "directory")],
  );
  const harness = await renderDownloadOps(localPane, remotePane, stats);
  const single = harness.ops.onDownloadFileRight as unknown as (entry: SftpFileEntry) => Promise<void>;
  const downloadFiles = harness.ops.onDownloadFilesRight as unknown as (entries: SftpFileEntry[]) => Promise<void>;

  try {
    await act(async () => { await single(file("report.txt", 12)); });
    assert.deepEqual(harness.transferCalls.at(-1), {
      files: [{ name: "report.txt", isDirectory: false }],
      sourceSide: "right",
      targetSide: "left",
      options: { sourceConnectionId: "remote", sourcePath: "/remote", targetPath: "/home/me/projects" },
    });
    assert.equal(harness.saveDialogCalls.length, 0, "no native picker while the local pane is usable");

    await act(async () => { await single(file("folder", 0, "directory")); });
    assert.deepEqual(harness.transferCalls.at(-1)?.files, [{ name: "folder", isDirectory: true }]);
    assert.equal(harness.transferCalls.at(-1)?.options?.targetPath, "/home/me/projects");
    assert.equal(harness.selectDirectoryCalls.length, 0);

    await act(async () => { await downloadFiles([file("a.txt", 3), file("b.txt", 4)]); });
    assert.deepEqual(harness.transferCalls.at(-1)?.files, [
      { name: "a.txt", isDirectory: false },
      { name: "b.txt", isDirectory: false },
    ]);
    assert.equal(harness.transferCalls.at(-1)?.options?.targetPath, "/home/me/projects");
    assert.equal(harness.transferCalls.at(-1)?.options?.sourcePath, "/remote");

    // A single selected directory is an explicit destination and wins.
    localPane.selectedFiles = new Set(["docs"]);
    await act(async () => { await single(file("report.txt", 12)); });
    assert.equal(harness.transferCalls.at(-1)?.options?.targetPath, "/home/me/projects/docs");

    // A selected file, or an ambiguous multi-selection, keeps the shown folder.
    localPane.selectedFiles = new Set(["notes.txt"]);
    await act(async () => { await single(file("report.txt", 12)); });
    assert.equal(harness.transferCalls.at(-1)?.options?.targetPath, "/home/me/projects");
    localPane.selectedFiles = new Set(["docs", "notes.txt"]);
    await act(async () => { await single(file("report.txt", 12)); });
    assert.equal(harness.transferCalls.at(-1)?.options?.targetPath, "/home/me/projects");

    // Both panes remote: the file lands in the other remote pane's folder.
    localPane.selectedFiles = new Set();
    const remotePair = await renderDownloadOps(
      makePane("remote-a", makeConnection("remote-a", "/remote", false), [file("report.txt", 12)]),
      makePane("remote-b", makeConnection("remote-b", "/other", false), [file("inbox", 0, "directory")]),
      stats,
    );
    const singleFromLeft = remotePair.ops.onDownloadFileLeft as unknown as (entry: SftpFileEntry) => Promise<void>;
    await act(async () => { await singleFromLeft(file("report.txt", 12)); });
    assert.deepEqual(remotePair.transferCalls.at(-1), {
      files: [{ name: "report.txt", isDirectory: false }],
      sourceSide: "left",
      targetSide: "right",
      options: { sourceConnectionId: "remote-a", sourcePath: "/remote", targetPath: "/other" },
    });
    assert.equal(remotePair.saveDialogCalls.length, 0, "remote pairs no longer open the local picker");
    await act(async () => { remotePair.renderer.unmount(); });
  } finally {
    await act(async () => { harness.renderer.unmount(); });
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

test("the native pickers come back when the opposite pane cannot receive", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;

  const stats = new Map<string, SftpStatResult>([
    ["/remote/report.txt", { name: "report.txt", size: 12, sizeKnown: true, type: "file", lastModified: 0 }],
  ]);
  const disconnectedLocal = makePane(
    "local",
    { ...makeConnection("local", "/home/me/projects", true), status: "disconnected" },
  );
  const source = makePane("remote", makeConnection("remote", "/remote", false));
  const disconnectedHarness = await renderDownloadOps(source, disconnectedLocal, stats);
  const singleFromLeft = disconnectedHarness.ops.onDownloadFileLeft as unknown as (
    entry: SftpFileEntry,
  ) => Promise<void>;

  // Both panes on one connection: a copy onto itself is not a download.
  const sameHostHarness = await renderDownloadOps(
    makePane("host", makeConnection("host", "/remote", false)),
    makePane("host", makeConnection("host", "/remote/sub", false)),
    stats,
  );
  const sameHostSingle = sameHostHarness.ops.onDownloadFileLeft as unknown as (
    entry: SftpFileEntry,
  ) => Promise<void>;

  try {
    await act(async () => { await singleFromLeft(file("report.txt", 12)); });
    assert.equal(disconnectedHarness.transferCalls.length, 0, "a disconnected pane receives nothing");
    assert.deepEqual(
      disconnectedHarness.saveDialogCalls.at(-1), ["report.txt"],
      "the save dialog keeps its platform default",
    );

    await act(async () => { await sameHostSingle(file("report.txt", 12)); });
    assert.equal(sameHostHarness.transferCalls.length, 0);
    assert.deepEqual(sameHostHarness.saveDialogCalls.at(-1), ["report.txt"]);
  } finally {
    await act(async () => { disconnectedHarness.renderer.unmount(); });
    await act(async () => { sameHostHarness.renderer.unmount(); });
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
