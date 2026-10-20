import { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useRef, useState } from "react";

import { logger } from "../../../lib/logger";
import {
  buildZmodemDragDropFiles,
  buildZmodemDragDropUploadCommand,
  containsZmodemRzMissingMarker,
  createZmodemRzMissingToken,
  supportsZmodemDragDropSftpFallback,
  supportsZmodemTerminalDragDrop,
  type ZmodemDragDropFile,
} from "../../../lib/zmodemDragDrop";
import { extractDropEntries, type DropEntry } from "../../../lib/sftpFileUtils";
import { resolveFtpDropPlan, supportsFtpDragDrop } from "../../../lib/ftpDragDrop";
import type { Host, TerminalSession } from "../../../types";
import { resolveSftpReuseSourceSessionId } from "../../../application/state/terminalConnectionReuse";
import {
  resolveTerminalDropSftpHost,
  TerminalDropNeedsSudoError,
} from "../../../domain/sftpDropElevation";
import { toast } from "../../ui/toast";
import {
  extractRootPathsFromDropEntries,
  type TerminalProps,
} from "../terminalHelpers";
import { createUploadTaskCallbacks } from "../../../application/state/sftp/uploadTaskCallbacks";
import { sftpTransferCenterStore } from "../../../application/state/sftpTransferCenterStore";

/**
 * The transfer center is a popover in the top bar, so an upload started from a
 * terminal drop used to run with nothing but a badge appearing — the user never
 * saw progress. Folder drops already opened it; single-file (SFTP fallback) and
 * FTP drops now do too.
 */
export function openTerminalDropTransferCenter() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("netcatty:open-sftp-transfer-center"));
}

interface UseTerminalDragDropOptions {
  host: Host;
  /** Password already resolved through host auth (host or Keychain identity). */
  resolvedSudoPassword?: string;
  /** Login username already resolved through host auth (host or Keychain identity). */
  resolvedLoginUsername?: string;
  isLocalConnection: boolean;
  isNetworkDevice?: boolean;
  onOpenSftp?: TerminalProps["onOpenSftp"];
  resolveSftpInitialPath: (options?: {
    preferFreshBackend?: boolean;
    requireActiveShellCwd?: boolean;
  }) => Promise<string | undefined>;
  scrollToBottomAfterProgrammaticInput: (data: string) => void;
  sessionId: string;
  sessionRef: React.MutableRefObject<string | null>;
  status: TerminalSession["status"];
  // Widened for the drag-drop toasts: the app's i18n `t` accepts interpolation
  // variables, and the FTP upload names the directory it wrote into.
  t: (key: string, vars?: Record<string, string | number>) => string;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean; sensitive?: boolean }) => void;
    cancelZmodem?: (sessionId: string, options?: { interrupt?: boolean }) => void;
    onSessionData?: (sessionId: string, cb: (chunk: string) => void) => () => void;
    onZmodemEvent?: (
      sessionId: string,
      cb: (event: { type: string; transferType?: string }) => void,
    ) => () => void;
    startZmodemDragDropUpload?: (
      sessionId: string,
      files: ZmodemDragDropFile[],
      uploadCommand?: string,
    ) => Promise<{ success: boolean; error?: string }>;
    /** Upload dropped files over FTP/FTPS into the terminal's current directory. */
    ftpUpload?: (payload: {
      host: string;
      port?: number;
      user?: string;
      password?: string;
      secure?: boolean;
      insecure?: boolean;
      remoteDir?: string;
      uploadId?: string;
      files: Array<{ path?: string; name: string; remoteName?: string; data?: ArrayBuffer }>;
    }) => Promise<{ ok: boolean; code?: string; error?: string; totalBytes?: number; transferredBytes?: number }>;
    /** Byte progress for one FTP drop, correlated by its `uploadId`. */
    onFtpUploadProgress?: (cb: (progress: {
      uploadId: string;
      transferred: number;
      total: number;
      speed: number;
      fileName?: string;
    }) => void) => () => void;
    /** Stop an in-flight FTP drop (the partial remote file is removed). */
    ftpCancelUpload?: (uploadId: string) => Promise<{ ok: boolean; code?: string }>;
  };
  isSensitiveInput?: () => boolean;
  rzMissingFallbackTimeoutMs?: number;
  termRef: React.MutableRefObject<XTerm | null>;
}

// Keep this aligned with the main-process drag-drop start watchdog. Falling
// back sooner interrupts valid rz handshakes on slow shells and jump routes.
export const DEFAULT_RZ_MISSING_FALLBACK_TIMEOUT_MS = 15_000;

export class ActiveTerminalCwdUnavailableError extends Error {
  constructor() {
    super("Could not determine the active terminal directory");
    this.name = "ActiveTerminalCwdUnavailableError";
  }
}

export function resolveTerminalDropErrorMessage(
  error: unknown,
  t: UseTerminalDragDropOptions["t"],
): string {
  if (error instanceof ActiveTerminalCwdUnavailableError) {
    return t("terminal.dragDrop.destinationUnknown");
  }
  if (error instanceof TerminalDropNeedsSudoError) {
    return t("terminal.dragDrop.needsSudoElevation");
  }
  if (error instanceof Error && error.message === "No files to upload") {
    return t("terminal.dragDrop.noFiles");
  }
  return t("terminal.dragDrop.errorMessage");
}

async function openSftpForTerminalDrop({
  dropEntries,
  host,
  onOpenSftp,
  resolveSftpInitialPath,
  resolvedLoginUsername,
  resolvedSudoPassword,
  sessionId,
}: {
  dropEntries: DropEntry[];
  host: Host;
  onOpenSftp: NonNullable<UseTerminalDragDropOptions["onOpenSftp"]>;
  resolveSftpInitialPath: UseTerminalDragDropOptions["resolveSftpInitialPath"];
  resolvedLoginUsername?: string;
  resolvedSudoPassword?: string;
  sessionId: string;
}): Promise<void> {
  const initialPath = await resolveTerminalDropUploadInitialPath(resolveSftpInitialPath);
  const uploadHost = resolveTerminalDropSftpHost(host, initialPath, {
    password: resolvedSudoPassword ?? host.password,
    username: resolvedLoginUsername ?? host.username,
  });
  // Show the queued upload's progress row instead of relying on the badge.
  openTerminalDropTransferCenter();
  onOpenSftp(
    uploadHost,
    initialPath,
    dropEntries,
    sessionId,
    resolveSftpReuseSourceSessionId(host, sessionId),
  );
}

export async function resolveTerminalDropUploadInitialPath(
  resolveSftpInitialPath: UseTerminalDragDropOptions["resolveSftpInitialPath"],
): Promise<string | undefined> {
  const initialPath = await resolveSftpInitialPath({
    preferFreshBackend: true,
    requireActiveShellCwd: true,
  });
  if (!initialPath) {
    throw new ActiveTerminalCwdUnavailableError();
  }
  return initialPath;
}

function createRzMissingWatcher({
  sessionId,
  terminalBackend,
  token,
  timeoutMs = DEFAULT_RZ_MISSING_FALLBACK_TIMEOUT_MS,
}: {
  sessionId: string;
  terminalBackend: Pick<UseTerminalDragDropOptions["terminalBackend"], "onSessionData" | "onZmodemEvent">;
  token: string;
  timeoutMs?: number;
}): { promise: Promise<"missing" | "detected" | "timeout">; stop: () => void } {
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let buffer = "";
  let unsubscribeData: (() => void) | undefined;
  let unsubscribeZmodem: (() => void) | undefined;
  let settle: (result: "missing" | "detected" | "timeout") => void = () => {};

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    unsubscribeData?.();
    unsubscribeData = undefined;
    unsubscribeZmodem?.();
    unsubscribeZmodem = undefined;
  };

  const promise = new Promise<"missing" | "detected" | "timeout">((resolve) => {
    settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    unsubscribeData = terminalBackend.onSessionData?.(sessionId, (chunk) => {
      buffer = `${buffer}${chunk}`.slice(-512);
      if (containsZmodemRzMissingMarker(buffer, token)) {
        settle("missing");
      }
    });

    unsubscribeZmodem = terminalBackend.onZmodemEvent?.(sessionId, (event) => {
      if (event.type === "detect" && event.transferType === "upload") {
        settle("detected");
      }
    });

    timeout = setTimeout(() => settle("timeout"), timeoutMs);
  });

  return {
    promise,
    stop: () => settle("detected"),
  };
}

export async function handleTerminalDropEntries({
  dropEntries,
  host,
  isLocalConnection,
  isNetworkDevice = false,
  onOpenSftp,
  resolveSftpInitialPath,
  resolvedLoginUsername,
  resolvedSudoPassword,
  scrollToBottomAfterProgrammaticInput,
  sessionId,
  sessionRef,
  terminalBackend,
  isSensitiveInput,
  rzMissingFallbackTimeoutMs,
  termRef,
  t,
}: Pick<
  UseTerminalDragDropOptions,
  | "host"
  | "resolvedLoginUsername"
  | "resolvedSudoPassword"
  | "isLocalConnection"
  | "isNetworkDevice"
  | "onOpenSftp"
  | "resolveSftpInitialPath"
  | "scrollToBottomAfterProgrammaticInput"
  | "sessionId"
  | "sessionRef"
  | "terminalBackend"
  | "isSensitiveInput"
  | "rzMissingFallbackTimeoutMs"
  | "termRef"
  | "t"
> & {
  dropEntries: DropEntry[];
}): Promise<void> {
  if (dropEntries.length === 0) {
    return;
  }

  if (isLocalConnection) {
    const paths = extractRootPathsFromDropEntries(dropEntries);

    if (paths.length > 0 && termRef.current && sessionRef.current) {
      const pathsText = paths.join(" ");
      terminalBackend.writeToSession(sessionRef.current, pathsText, {
        sensitive: isSensitiveInput?.() === true,
      });
      scrollToBottomAfterProgrammaticInput(pathsText);
      termRef.current.focus();
    }
    return;
  }

  /** ZMODEM (`rz`) upload, plus its SFTP fallback when the server lacks rz. */
  const uploadViaZmodem = async () => {
    const files = await buildZmodemDragDropFiles(dropEntries);
    if (files.length === 0) {
      throw new Error("No files to upload");
    }

    if (!terminalBackend.startZmodemDragDropUpload) {
      throw new Error("ZMODEM drag-drop upload is unavailable");
    }

    const shouldFallbackToSftpWhenRzMissing = Boolean(
      onOpenSftp
      && supportsZmodemDragDropSftpFallback(host)
      && terminalBackend.onSessionData
      && terminalBackend.cancelZmodem,
    );
    const rzMissingToken = shouldFallbackToSftpWhenRzMissing
      ? createZmodemRzMissingToken()
      : undefined;
    const rzMissingWatcher = rzMissingToken
      ? createRzMissingWatcher({
        sessionId,
        terminalBackend,
        token: rzMissingToken,
        timeoutMs: rzMissingFallbackTimeoutMs,
      })
      : undefined;
    const uploadCommand = rzMissingToken
      ? buildZmodemDragDropUploadCommand(rzMissingToken)
      : undefined;

    let result: { success: boolean; error?: string };
    try {
      result = await terminalBackend.startZmodemDragDropUpload(sessionId, files, uploadCommand);
    } catch (error) {
      rzMissingWatcher?.stop();
      throw error;
    }
    if (!result.success) {
      rzMissingWatcher?.stop();
      throw new Error(result.error || "ZMODEM upload failed");
    }

    const fallbackResult = rzMissingWatcher ? await rzMissingWatcher.promise : "detected";
    if (fallbackResult === "missing" || fallbackResult === "timeout") {
      terminalBackend.cancelZmodem?.(sessionId, { interrupt: fallbackResult === "timeout" });
      if (onOpenSftp) {
        await openSftpForTerminalDrop({
          dropEntries,
          host,
          onOpenSftp,
          resolveSftpInitialPath,
          resolvedLoginUsername,
          resolvedSudoPassword,
          sessionId,
        });
      }
    }
  };

  const requiresSftpForDirectoryDrop = dropEntries.some((entry) => (
    entry.isDirectory || /[\\/]/.test(entry.relativePath)
  ));

  if (
    requiresSftpForDirectoryDrop
    && onOpenSftp
    && supportsZmodemDragDropSftpFallback(host)
  ) {
    await openSftpForTerminalDrop({
      dropEntries,
      host,
      onOpenSftp,
      resolveSftpInitialPath,
      resolvedLoginUsername,
      resolvedSudoPassword,
      sessionId,
    });
  } else if (
    !requiresSftpForDirectoryDrop
    && supportsFtpDragDrop(host)
    && host.ftpEnabled
    && terminalBackend.ftpUpload
  ) {
    // FTP/FTPS with the built-in client: the file lands in the terminal's
    // tracked current directory, or in the FTP account's login directory when the
    // device never reports a cwd (telnet/serial shells have no OSC 7). Falls
    // through to ZMODEM only when the plan is not usable at all (no FTP on the
    // host, no host name) so the drop is never silently lost.
    const initialPath = await resolveSftpInitialPath({ requireActiveShellCwd: true }).catch(() => undefined);
    const plan = resolveFtpDropPlan({
      host,
      remoteDir: initialPath,
      credentials: { username: resolvedLoginUsername, password: resolvedSudoPassword ?? host.password },
    });
    if (plan.ok) {
      const ftpFiles = await buildZmodemDragDropFiles(dropEntries);
      if (ftpFiles.length === 0) {
        throw new Error("No files to upload");
      }
      // One determinate row for the whole drop: the main process streams
      // throttled byte counts back over IPC (correlated by uploadId), so the bar
      // moves instead of spinning. In-memory drops know their size up front; a
      // path-only drop gets its total with the first progress frame.
      const uploadId = crypto.randomUUID();
      // One owner per drop: its Cancel button stops this upload and nothing else.
      const callbacks = createUploadTaskCallbacks({
        ownerId: `terminal-drop:${sessionId}:${uploadId}`,
        connectionId: "ftp-drop",
        targetPath: plan.plan.remoteDir || "/",
        targetHostId: host.id,
        targetHostLabel: host.label,
        // There is no resume offset for an FTP put, so do not offer pause.
        resumable: false,
      });
      const taskId = crypto.randomUUID();
      const first = ftpFiles[0];
      const uploadLabel = ftpFiles.length > 1
        ? `${first.remoteName || first.name} +${ftpFiles.length - 1}`
        : (first.remoteName || first.name);
      const knownTotal = ftpFiles.reduce((sum, file) => sum + (file.data?.byteLength ?? 0), 0);
      callbacks.onTaskCreated?.({
        id: taskId,
        fileName: uploadLabel,
        displayName: uploadLabel,
        isDirectory: false,
        progressMode: "bytes",
        totalBytes: knownTotal,
        transferredBytes: 0,
        speed: 0,
        fileCount: ftpFiles.length,
        completedCount: 0,
      });
      let cancelled = false;
      const unregisterOwner = sftpTransferCenterStore.registerOwner(
        `terminal-drop:${sessionId}:${uploadId}`,
        {
          pause: () => {},
          resume: () => {},
          cancel: (id) => {
            if (id !== taskId || cancelled) return;
            cancelled = true;
            callbacks.onTaskCancelled?.(taskId);
            void terminalBackend.ftpCancelUpload?.(uploadId);
          },
          retry: () => {},
          prioritize: () => {},
          dismiss: (id) => sftpTransferCenterStore.dismiss(id),
        },
      );
      openTerminalDropTransferCenter();
      const unsubscribe = terminalBackend.onFtpUploadProgress?.((progress) => {
        if (!progress || progress.uploadId !== uploadId) return;
        const transferred = Math.max(0, Number(progress.transferred) || 0);
        const total = Math.max(0, Number(progress.total) || 0);
        callbacks.onTaskProgress?.(taskId, {
          transferred,
          total,
          speed: Math.max(0, Number(progress.speed) || 0),
          percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
          phase: "transferring",
        });
      }) ?? (() => {});
      let result: {
        ok: boolean;
        code?: string;
        error?: string;
        totalBytes?: number;
        transferredBytes?: number;
      };
      try {
        result = await terminalBackend.ftpUpload({
          ...plan.plan,
          uploadId,
          files: ftpFiles.map((file) => ({
            path: file.path,
            name: file.name,
            remoteName: file.remoteName,
            data: file.data,
          })),
        });
      } catch (error) {
        if (!cancelled) {
          callbacks.onTaskFailed?.(taskId, error instanceof Error ? error.message : String(error));
        }
        throw error;
      } finally {
        unsubscribe();
        unregisterOwner();
      }
      if (!result.ok) {
        // The row is already marked cancelled; do not turn it into a failure.
        if (cancelled || result.code === "ABORT_ERR") return;
        callbacks.onTaskFailed?.(taskId, result.error || "FTP upload failed");
        throw new Error(result.error || "FTP upload failed");
      }
      callbacks.onTaskCompleted?.(taskId, result.totalBytes ?? knownTotal);
      // Always say where the file landed: with no tracked cwd the upload goes to
      // the FTP login directory, which is rarely the shell's directory.
      toast.success(
        plan.plan.remoteDir
          ? t("terminal.dragDrop.ftpUploaded", { dir: plan.plan.remoteDir })
          : t("terminal.dragDrop.ftpUploadedLoginDir"),
        t("terminal.dragDrop.ftpUploadedTitle"),
      );
      return;
    }
    return await uploadViaZmodem();
  } else if (supportsZmodemTerminalDragDrop(host, isNetworkDevice)) {
    await uploadViaZmodem();

  } else if (onOpenSftp) {
    await openSftpForTerminalDrop({
      dropEntries,
      host,
      onOpenSftp,
      resolveSftpInitialPath,
      resolvedLoginUsername,
      resolvedSudoPassword,
      sessionId,
    });
  }
}

export function useTerminalDragDrop({
  host,
  resolvedLoginUsername,
  resolvedSudoPassword,
  isLocalConnection,
  isNetworkDevice = false,
  onOpenSftp,
  resolveSftpInitialPath,
  scrollToBottomAfterProgrammaticInput,
  sessionId,
  sessionRef,
  status,
  t,
  terminalBackend,
  isSensitiveInput,
  rzMissingFallbackTimeoutMs,
  termRef,
}: UseTerminalDragDropOptions) {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDraggingOver(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) {
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);

    if (!e.dataTransfer.types.includes("Files")) {
      return;
    }

    if (status !== "connected") {
      toast.error(t("terminal.dragDrop.notConnected"), t("terminal.dragDrop.errorTitle"));
      return;
    }

    try {
      const dropEntries = await extractDropEntries(e.dataTransfer);
      await handleTerminalDropEntries({
        dropEntries,
        host,
        resolvedLoginUsername,
        resolvedSudoPassword,
        isLocalConnection,
        isNetworkDevice,
        onOpenSftp,
        resolveSftpInitialPath,
        scrollToBottomAfterProgrammaticInput,
        sessionId,
        sessionRef,
        terminalBackend,
        isSensitiveInput,
        rzMissingFallbackTimeoutMs,
        termRef,
        t,
      });
    } catch (error) {
      logger.error("Failed to handle file drop", error);
      const message = resolveTerminalDropErrorMessage(error, t);
      toast.error(message, t("terminal.dragDrop.errorTitle"));
    }
  };

  return {
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    isDraggingOver,
  };
}
