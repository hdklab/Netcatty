import { ChevronDown, ChevronUp, Eye, EyeOff, RefreshCw, Usb, X } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTerminalBackend } from "../../application/state/useTerminalBackend";
import type { SerialConfig, SerialFlowControl, SerialParity } from "../../domain/models";
import { isSerialPortPath, SERIAL_BAUD_RATES } from "../../domain/serialHost";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Combobox, type ComboboxOption } from "../ui/combobox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { HostDetailsSection, HostDetailsSettingRow } from "./HostDetailsSection";

interface SerialPort {
  path: string;
  manufacturer: string;
  serialNumber: string;
  vendorId: string;
  productId: string;
  pnpId: string;
  type?: "hardware" | "pseudo" | "custom";
}

const DATA_BITS: Array<5 | 6 | 7 | 8> = [5, 6, 7, 8];
const STOP_BITS: Array<1 | 1.5 | 2> = [1, 1.5, 2];
const PARITY_OPTIONS: SerialParity[] = ["none", "even", "odd", "mark", "space"];
const FLOW_CONTROL_OPTIONS: SerialFlowControl[] = ["none", "xon/xoff", "rts/cts"];

interface HostSerialConnectionSectionProps {
  value: SerialConfig;
  onChange: (patch: Partial<SerialConfig>) => void;
  t: (key: string) => string;
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  onPasswordClear: () => void;
  canClearPassword: boolean;
  charset: string;
  onCharsetChange: (value: string) => void;
  inheritedCharset?: string;
}

/**
 * Serial port settings for the unified host editor: device, line settings and
 * the console auto-login credentials. Extracted from the old standalone serial
 * dialogs so a serial host is configured in exactly one place.
 */
export const HostSerialConnectionSection: React.FC<HostSerialConnectionSectionProps> = ({
  value,
  onChange,
  t,
  username,
  onUsernameChange,
  password,
  onPasswordChange,
  onPasswordClear,
  canClearPassword,
  charset,
  onCharsetChange,
  inheritedCharset,
}) => {
  const terminalBackend = useTerminalBackend();
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [isLoadingPorts, setIsLoadingPorts] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Read through refs so listing ports does not depend on the current draft.
  const selectedPathRef = useRef(value.path);
  selectedPathRef.current = value.path;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const loadPorts = useCallback(async () => {
    setIsLoadingPorts(true);
    try {
      const result = await terminalBackend.listSerialPorts();
      setPorts(result);
      // Match the old connect dialog: preselect the first detected device so a
      // fresh serial host needs no extra click.
      if (!selectedPathRef.current && result.length > 0) {
        onChangeRef.current({ path: result[0].path });
      }
    } catch (err) {
      console.error("[Serial] Failed to list ports:", err);
    } finally {
      setIsLoadingPorts(false);
    }
  }, [terminalBackend]);

  useEffect(() => {
    void loadPorts();
  }, [loadPorts]);

  const portOptions: ComboboxOption[] = useMemo(
    () => ports.map((port) => ({
      value: port.path,
      label: port.path,
      sublabel: port.manufacturer || undefined,
    })),
    [ports],
  );

  const baudRateOptions: ComboboxOption[] = useMemo(
    () => SERIAL_BAUD_RATES.map((rate) => ({ value: String(rate), label: String(rate) })),
    [],
  );

  const pathInvalid = Boolean(value.path) && !isSerialPortPath(value.path);
  const isCustomBaudRate = value.baudRate > 0 && !SERIAL_BAUD_RATES.includes(value.baudRate as typeof SERIAL_BAUD_RATES[number]);

  return (
    <>
      <HostDetailsSection
        icon={<Usb size={14} className="text-muted-foreground" />}
        title={t("serial.field.port")}
        action={(
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadPorts()}
            disabled={isLoadingPorts}
            className="h-6 px-2 text-xs"
          >
            <RefreshCw size={12} className={cn("mr-1", isLoadingPorts && "animate-spin")} />
            {t("common.refresh")}
          </Button>
        )}
      >
        <Combobox
          options={portOptions}
          value={value.path}
          onValueChange={(next) => onChange({ path: next })}
          placeholder={t("serial.field.selectPort")}
          emptyText={t("serial.noPorts")}
          allowCreate
          createText={t("common.use")}
          icon={<Usb size={14} className="text-muted-foreground" />}
        />
        {pathInvalid && (
          <p className="text-xs text-destructive">{t("serial.field.customPortPlaceholder")}</p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="host-serial-baud-rate" className="text-xs text-muted-foreground">
            {t("serial.field.baudRate")}
          </Label>
          <Combobox
            options={baudRateOptions}
            value={String(value.baudRate)}
            onValueChange={(next) => {
              const parsed = Number.parseInt(next, 10);
              if (!Number.isNaN(parsed) && parsed > 0) onChange({ baudRate: parsed });
            }}
            placeholder={t("serial.field.baudRatePlaceholder")}
            emptyText={t("serial.field.baudRateEmpty")}
            allowCreate
            createText={t("common.use")}
          />
          {isCustomBaudRate && (
            <p className="text-xs text-muted-foreground">{t("serial.field.customBaudRate")}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="host-serial-data-bits" className="text-xs text-muted-foreground">
              {t("serial.field.dataBits")}
            </Label>
            <Select
              value={String(value.dataBits ?? 8)}
              onValueChange={(next) => onChange({ dataBits: Number.parseInt(next, 10) as 5 | 6 | 7 | 8 })}
            >
              <SelectTrigger id="host-serial-data-bits" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATA_BITS.map((bits) => (
                  <SelectItem key={bits} value={String(bits)}>{bits}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="host-serial-stop-bits" className="text-xs text-muted-foreground">
              {t("serial.field.stopBits")}
            </Label>
            <Select
              value={String(value.stopBits ?? 1)}
              onValueChange={(next) => onChange({ stopBits: Number.parseFloat(next) as 1 | 1.5 | 2 })}
            >
              <SelectTrigger id="host-serial-stop-bits" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STOP_BITS.map((bits) => (
                  <SelectItem key={bits} value={String(bits)}>{bits}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {value.stopBits === 1.5 && (
              <p className="text-xs text-yellow-500">{t("serial.field.stopBits15Warning")}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="host-serial-parity" className="text-xs text-muted-foreground">
              {t("serial.field.parity")}
            </Label>
            <Select
              value={value.parity ?? "none"}
              onValueChange={(next) => onChange({ parity: next as SerialParity })}
            >
              <SelectTrigger id="host-serial-parity" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PARITY_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option} textValue={t(`serial.parity.${option}`)}>
                    {t(`serial.parity.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="host-serial-flow-control" className="text-xs text-muted-foreground">
              {t("serial.field.flowControl")}
            </Label>
            <Select
              value={value.flowControl ?? "none"}
              onValueChange={(next) => onChange({ flowControl: next as SerialFlowControl })}
            >
              <SelectTrigger id="host-serial-flow-control" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FLOW_CONTROL_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option} textValue={t(`serial.flowControl.${option}`)}>
                    {t(`serial.flowControl.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="host-serial-charset" className="text-xs text-muted-foreground">
            {t("serial.field.charset")}
          </Label>
          <Input
            id="host-serial-charset"
            placeholder={inheritedCharset || t("hostDetails.charset.placeholder")}
            value={charset}
            onChange={(event) => onCharsetChange(event.target.value)}
            className="h-9"
          />
        </div>
      </HostDetailsSection>

      <HostDetailsSection
        icon={<Usb size={14} className="text-muted-foreground" />}
        title={t("serial.field.username")}
        hint={t("serial.field.autoLoginDesc")}
      >
        <Input
          placeholder={t("serial.field.username")}
          value={username}
          onChange={(event) => onUsernameChange(event.target.value)}
          autoComplete="off"
          className="h-9"
        />
        <div className="relative">
          <Input
            placeholder={t("serial.field.password")}
            value={password}
            type={showPassword ? "text" : "password"}
            onChange={(event) => onPasswordChange(event.target.value)}
            autoComplete="off"
            className="h-9 pr-16"
          />
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            {canClearPassword && (
              <button
                type="button"
                onClick={onPasswordClear}
                title={t("serial.field.clearPassword")}
                aria-label={t("serial.field.clearPassword")}
                className="p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowPassword((previous) => !previous)}
              aria-label={t("serial.field.password")}
              className="p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
      </HostDetailsSection>

      <HostDetailsSection
        icon={<Usb size={14} className="text-muted-foreground" />}
        title={t("common.advanced")}
      >
        <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="h-8 w-full justify-between px-0 hover:bg-transparent">
              <span className="text-xs text-muted-foreground">{t("serial.field.backspaceBehavior")}</span>
              {showAdvanced
                ? <ChevronUp size={14} className="text-muted-foreground" />
                : <ChevronDown size={14} className="text-muted-foreground" />}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-1">
            <div className="space-y-1.5">
              <Select
                value={value.backspaceBehavior === "ctrl-h" ? "ctrl-h" : "default"}
                onValueChange={(next) => onChange({ backspaceBehavior: next === "ctrl-h" ? "ctrl-h" : "default" })}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t("serial.backspace.default")}</SelectItem>
                  <SelectItem value="ctrl-h">{t("serial.backspace.ctrlH")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("serial.field.backspaceBehaviorDesc")}</p>
            </div>

            <SerialToggleRow
              label={t("serial.field.byteOrientedBackspace")}
              hint={t("serial.field.byteOrientedBackspaceDesc")}
              checked={value.byteOrientedBackspace === true}
              onChange={(checked) => onChange({ byteOrientedBackspace: checked })}
            />
            <SerialToggleRow
              label={t("serial.field.localEcho")}
              hint={t("serial.field.localEchoDesc")}
              checked={value.localEcho === true}
              onChange={(checked) => onChange({ localEcho: checked })}
            />
            <SerialToggleRow
              label={t("serial.field.lineMode")}
              hint={t("serial.field.lineModeDesc")}
              checked={value.lineMode === true}
              onChange={(checked) => onChange({ lineMode: checked })}
            />
          </CollapsibleContent>
        </Collapsible>
      </HostDetailsSection>
    </>
  );
};

const SerialToggleRow: React.FC<{
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ label, hint, checked, onChange }) => (
  <HostDetailsSettingRow label={label} hint={hint}>
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className="h-4 w-4 rounded border-input"
      aria-label={label}
    />
  </HostDetailsSettingRow>
);

export default HostSerialConnectionSection;
