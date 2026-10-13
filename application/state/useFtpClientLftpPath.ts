/**
 * Settings → 文件传输: path of the external `lftp` binary.
 *
 * Netcatty shells out to lftp for hosts that only speak FTP (telnet/serial
 * devices), and `lftp` is not bundled. Finding it on PATH works on Linux and
 * macOS, but a Windows install ships `lftp.exe` — a bare-name PATH scan never
 * matches it — so the settings UI lets the user point at the binary explicitly.
 *
 * The value is machine-specific, so it is deliberately NOT part of cloud sync;
 * it is pushed to the main process on load (the main process loses it on
 * restart) and on every change. `status` mirrors what the backend resolved, so
 * the UI can say "not found" instead of failing later mid-transfer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STORAGE_KEY_FTP_LFTP_PATH } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export type LftpStatus = {
  configuredPath: string;
  configuredUsable: boolean;
  envPath: string;
  resolvedPath: string | null;
  /** Where `resolvedPath` came from — `auto`/`path` mean no configuration needed. */
  source: 'settings' | 'env' | 'path' | 'auto' | 'none' | 'settings-invalid' | 'env-invalid';
  autoDetected: boolean;
  platform: string;
};

export type FtpClientLftpPathState = {
  lftpPath: string;
  setLftpPath: (value: string) => void;
  status: LftpStatus | null;
  isChecking: boolean;
  refreshStatus: () => Promise<LftpStatus | null>;
};

export const useFtpClientLftpPath = (): FtpClientLftpPathState => {
  const [lftpPath, setLftpPathValue] = useState(
    () => localStorageAdapter.readString(STORAGE_KEY_FTP_LFTP_PATH) ?? '',
  );
  const [status, setStatus] = useState<LftpStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const aliveRef = useRef(true);

  const refreshStatus = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.ftpGetLftpStatus) return null;
    setIsChecking(true);
    try {
      const next = await bridge.ftpGetLftpStatus();
      if (aliveRef.current && next) setStatus(next as LftpStatus);
      return (next as LftpStatus) ?? null;
    } finally {
      if (aliveRef.current) setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Push the stored value on mount and after every edit: the main process does
  // the resolution, and it starts each launch with nothing configured.
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.ftpSetLftpPath) return;
    let cancelled = false;
    void bridge.ftpSetLftpPath(lftpPath).then((result) => {
      if (!cancelled && aliveRef.current && result) setStatus(result as LftpStatus);
    });
    return () => {
      cancelled = true;
    };
  }, [lftpPath]);

  const setLftpPath = useCallback((value: string) => {
    const trimmed = value.trim();
    localStorageAdapter.writeString(STORAGE_KEY_FTP_LFTP_PATH, trimmed);
    setLftpPathValue(trimmed);
  }, []);

  return useMemo(
    () => ({ lftpPath, setLftpPath, status, isChecking, refreshStatus }),
    [lftpPath, setLftpPath, status, isChecking, refreshStatus],
  );
};
