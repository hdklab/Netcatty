import { Eye, EyeOff, FolderTree } from "lucide-react";
import React from "react";
import type { Host } from "../../types";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { HostDetailsSection, HostDetailsSettingRow } from "./HostDetailsSection";

type FileProtocol = NonNullable<Host["sftpFileProtocol"]>;

interface HostFileTransferSectionProps {
  protocol: FileProtocol;
  onProtocolChange: (protocol: FileProtocol) => void;
  ftpPort?: number;
  ftpSecure?: boolean;
  ftpInsecure?: boolean;
  ftpUsername?: string;
  ftpPassword?: string;
  onUpdate: <K extends keyof Host>(key: K, value: Host[K]) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
  t: (key: string) => string;
  /** File-server-only hosts cannot disable file transfer. */
  required?: boolean;
}

const PROTOCOL_OPTIONS: Array<{ value: FileProtocol; labelKey: string }> = [
  { value: "none", labelKey: "hostDetails.fileTransfer.none" },
  { value: "auto", labelKey: "hostDetails.sftp.fileProtocol.auto" },
  { value: "sftp", labelKey: "hostDetails.sftp.fileProtocol.sftp" },
  { value: "scp", labelKey: "hostDetails.sftp.fileProtocol.scp" },
  { value: "ftp", labelKey: "hostDetails.sftp.fileProtocol.ftp" },
];

/**
 * Independent file-transfer configuration: it is configured separately from the
 * terminal protocol, so a telnet/serial/file-only host still has a working file
 * panel (SFTP / SCP / FTP, or disabled).
 */
export const HostFileTransferSection: React.FC<HostFileTransferSectionProps> = ({
  protocol,
  onProtocolChange,
  ftpEnabled,
  ftpPort,
  ftpSecure,
  ftpInsecure,
  ftpUsername,
  ftpPassword,
  onUpdate,
  showPassword,
  onTogglePassword,
  t,
  required,
}) => {
  const options = required
    ? PROTOCOL_OPTIONS.filter((option) => option.value !== "none")
    : PROTOCOL_OPTIONS;

  return (
    <HostDetailsSection
      icon={<FolderTree size={14} className="text-muted-foreground" />}
      title={t("hostDetails.fileTransfer.title")}
      hint={t("hostDetails.fileTransfer.desc")}
    >
      {protocol !== "ftp" && ftpEnabled && (
        <HostDetailsSettingRow label={t("hostDetails.ftp.on")}>
          <input
            type="checkbox"
            checked
            onChange={(event) => {
              if (!event.target.checked) onUpdate("ftpEnabled", false);
            }}
            className="h-4 w-4 rounded border-input"
            aria-label={t("hostDetails.ftp.on")}
          />
        </HostDetailsSettingRow>
      )}

      <HostDetailsSettingRow label={t("hostDetails.fileTransfer.protocol")}>
        <Select
          value={protocol}
          onValueChange={(next) => onProtocolChange(next as FileProtocol)}
        >
          <SelectTrigger
            className="h-8 w-36"
            aria-label={t("hostDetails.fileTransfer.protocol")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value} textValue={t(option.labelKey)}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </HostDetailsSettingRow>

      {protocol === "ftp" && (
        <>
          <HostDetailsSettingRow label={t("hostDetails.ftp.port")}>
            <Input
              type="number"
              value={ftpPort ?? ""}
              placeholder="21"
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                onUpdate(
                  "ftpPort",
                  event.target.value && Number.isFinite(parsed) && parsed > 0 && parsed <= 65535
                    ? parsed
                    : undefined,
                );
              }}
              className="h-8 w-20 text-center"
            />
          </HostDetailsSettingRow>
          <HostDetailsSettingRow label={t("hostDetails.ftp.secure")}>
            <input
              type="checkbox"
              checked={Boolean(ftpSecure)}
              onChange={(event) => onUpdate("ftpSecure", event.target.checked)}
              className="h-4 w-4 rounded border-input"
              aria-label={t("hostDetails.ftp.secure")}
            />
          </HostDetailsSettingRow>
          <HostDetailsSettingRow label={t("hostDetails.ftp.insecure")}>
            <input
              type="checkbox"
              checked={Boolean(ftpInsecure)}
              onChange={(event) => onUpdate("ftpInsecure", event.target.checked)}
              className="h-4 w-4 rounded border-input"
              aria-label={t("hostDetails.ftp.insecure")}
            />
          </HostDetailsSettingRow>
          <Input
            value={ftpUsername ?? ""}
            placeholder={t("hostDetails.ftp.username")}
            onChange={(event) => onUpdate("ftpUsername", event.target.value)}
            className="h-9"
            autoComplete="off"
          />
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              value={ftpPassword ?? ""}
              placeholder={t("hostDetails.ftp.password")}
              onChange={(event) => onUpdate("ftpPassword", event.target.value)}
              className="h-9 pr-10"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={onTogglePassword}
              aria-label={t("hostDetails.ftp.password")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("hostDetails.ftp.hint")}</p>
        </>
      )}
    </HostDetailsSection>
  );
};

export default HostFileTransferSection;
