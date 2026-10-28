import { Network } from "lucide-react";
import React, { useMemo } from "react";
import type { SerialFlowControl, SerialParity, TelnetSerialConfig } from "../../domain/models";
import {
  TELNET_SERIAL_BAUD_RATES,
  TELNET_SERIAL_DATA_BITS,
  TELNET_SERIAL_PARITIES,
  TELNET_SERIAL_STOP_BITS,
  TELNET_SERIAL_FLOW_CONTROLS,
  formatTelnetSerialConfig,
} from "../../domain/telnetSerial";
import { Combobox, type ComboboxOption } from "../ui/combobox";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { HostDetailsSettingRow } from "./HostDetailsSection";

interface HostTelnetSerialSectionProps {
  value: TelnetSerialConfig;
  onChange: (patch: Partial<TelnetSerialConfig>) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

/**
 * RFC 2217 block for a telnet host: the endpoint is a serial server (ser2net,
 * a router's console server, an industrial gateway) that owns the UART, so the
 * line settings are negotiated on connect instead of configured locally.
 * Mirrors the serial host section's controls so both editors look the same.
 */
export const HostTelnetSerialSection: React.FC<HostTelnetSerialSectionProps> = ({
  value,
  onChange,
  t,
}) => {
  const baudRateOptions: ComboboxOption[] = useMemo(
    () => TELNET_SERIAL_BAUD_RATES.map((rate) => ({ value: String(rate), label: String(rate) })),
    [],
  );
  const isCustomBaudRate = value.baudRate > 0
    && !TELNET_SERIAL_BAUD_RATES.includes(value.baudRate as typeof TELNET_SERIAL_BAUD_RATES[number]);

  return (
    <>
      <HostDetailsSettingRow
        label={t("hostDetails.telnet.serial.title")}
        hint={t("hostDetails.telnet.serial.hint")}
      >
        {/* The Switch forwards extra props to its hidden input, so the
            automation hook lives on a wrapper that covers the visible control. */}
        <span data-telnet-serial-toggle={value.enabled ? "on" : "off"} className="inline-flex">
          <Switch
            checked={value.enabled}
            onCheckedChange={(checked) => onChange({ enabled: checked })}
            aria-label={t("hostDetails.telnet.serial.title")}
          />
        </span>
      </HostDetailsSettingRow>

      {value.enabled && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="host-telnet-serial-baud" className="text-xs text-muted-foreground">
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
              <Label htmlFor="host-telnet-serial-data-bits" className="text-xs text-muted-foreground">
                {t("serial.field.dataBits")}
              </Label>
              <Select
                value={String(value.dataBits)}
                onValueChange={(next) => onChange({ dataBits: Number.parseInt(next, 10) as 5 | 6 | 7 | 8 })}
              >
                <SelectTrigger id="host-telnet-serial-data-bits" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TELNET_SERIAL_DATA_BITS.map((bits) => (
                    <SelectItem key={bits} value={String(bits)}>{bits}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-telnet-serial-stop-bits" className="text-xs text-muted-foreground">
                {t("serial.field.stopBits")}
              </Label>
              <Select
                value={String(value.stopBits)}
                onValueChange={(next) => onChange({ stopBits: Number.parseInt(next, 10) as 1 | 2 })}
              >
                <SelectTrigger id="host-telnet-serial-stop-bits" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TELNET_SERIAL_STOP_BITS.map((bits) => (
                    <SelectItem key={bits} value={String(bits)}>{bits}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-telnet-serial-parity" className="text-xs text-muted-foreground">
                {t("serial.field.parity")}
              </Label>
              <Select
                value={value.parity}
                onValueChange={(next) => onChange({ parity: next as SerialParity })}
              >
                <SelectTrigger id="host-telnet-serial-parity" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TELNET_SERIAL_PARITIES.map((option) => (
                    <SelectItem key={option} value={option} textValue={t(`serial.parity.${option}`)}>
                      {t(`serial.parity.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-telnet-serial-flow-control" className="text-xs text-muted-foreground">
                {t("serial.field.flowControl")}
              </Label>
              <Select
                value={value.flowControl}
                onValueChange={(next) => onChange({ flowControl: next as SerialFlowControl })}
              >
                <SelectTrigger id="host-telnet-serial-flow-control" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TELNET_SERIAL_FLOW_CONTROLS.map((option) => (
                    <SelectItem key={option} value={option} textValue={t(`serial.flowControl.${option}`)}>
                      {t(`serial.flowControl.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground" data-telnet-serial-preview>
            <Network size={12} className="mr-1 inline align-[-2px]" />
            {t("hostDetails.telnet.serial.preview", { config: formatTelnetSerialConfig(value) })}
          </p>
        </>
      )}
    </>
  );
};
