import type { SftpPane } from "../../application/state/sftp/types";
import { joinPath } from "../../application/state/sftp/utils";
import { isNavigableDirectory } from "./utils";

export type SftpPaneSide = "left" | "right";

export interface CrossPaneDownloadTarget {
  /** Pane the download is delivered into. */
  side: SftpPaneSide;
  /** Folder inside that pane: the one it shows, or the single folder selected in it. */
  directory: string;
}

export const oppositePaneSide = (side: SftpPaneSide): SftpPaneSide =>
  side === "left" ? "right" : "left";

/**
 * Destination folder for a download started in `sourceSide`.
 *
 * Downloading means "deliver it into the other pane": the entry lands in the
 * folder that pane is showing, and a single selected folder there wins because
 * it is an explicit destination choice. That pane may be the local machine or a
 * second remote host, so both layouts follow one rule instead of the native
 * pickers.
 *
 * Returns null when there is nothing to deliver into — the opposite pane is not
 * connected, is busy reconnecting, or is the very same connection (copying onto
 * itself is not a download). Callers then keep the native save / directory
 * pickers.
 */
export const resolveCrossPaneDownloadTarget = (
  sourceSide: SftpPaneSide,
  leftPane: SftpPane | null | undefined,
  rightPane: SftpPane | null | undefined,
): CrossPaneDownloadTarget | null => {
  const side = oppositePaneSide(sourceSide);
  const pane = side === "left" ? leftPane : rightPane;
  const connection = pane?.connection;
  if (!pane || !connection) return null;
  if (connection.status !== "connected" || pane.reconnecting) return null;

  const sourcePane = sourceSide === "left" ? leftPane : rightPane;
  if (sourcePane?.connection && sourcePane.connection.id === connection.id) return null;

  const baseDirectory = connection.currentPath;
  if (typeof baseDirectory !== "string" || baseDirectory.length === 0) return null;

  const selectedNames = pane.selectedFiles;
  if (selectedNames && selectedNames.size === 1) {
    const [selectedName] = Array.from(selectedNames);
    if (selectedName && selectedName !== "..") {
      const selectedEntry = pane.files?.find((entry) => entry.name === selectedName);
      if (selectedEntry && isNavigableDirectory(selectedEntry)) {
        return { side, directory: joinPath(baseDirectory, selectedName) };
      }
    }
  }

  return { side, directory: baseDirectory };
};
