import { ChevronDown, FolderTree } from "lucide-react";
import React from "react";
import type { HostConnectionType } from "../../domain/serialHost";
import { HOST_CONNECTION_TYPES } from "../../domain/serialHost";
import { cn } from "../../lib/utils";
import { getProtocolVisualStyle } from "../protocolVisuals";
import { Button } from "../ui/button";
import { Dropdown, DropdownContent, DropdownTrigger } from "../ui/dropdown";

interface HostConnectionTypeSelectProps {
  value: HostConnectionType;
  onChange: (next: HostConnectionType) => void;
  t: (key: string) => string;
}

const protocolVisual = (type: HostConnectionType) => (
  type === "file"
    ? {
      icon: <FolderTree size={18} />,
      idle: "bg-sky-500/10 text-sky-500",
      selected: "bg-sky-500/20 text-sky-500",
    }
    : getProtocolVisualStyle(type)
);

/**
 * "How does this host connect?" dropdown at the top of the host editor. The
 * selection decides which configuration blocks the panel renders, so only the
 * chosen protocol's settings are visible.
 *
 * Uses the app's popover Dropdown rather than a Radix Select on purpose: the
 * change must only happen from an explicit item click, never from a control
 * initialising itself.
 */
export const HostConnectionTypeSelect: React.FC<HostConnectionTypeSelectProps> = ({
  value,
  onChange,
  t,
}) => {
  const selectedVisual = protocolVisual(value);

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full justify-between px-3 font-normal"
          aria-label={t("hostDetails.connectionType")}
          data-section="host-connection-type"
          data-connection-type={value}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5",
                selectedVisual.selected,
              )}
            >
              {selectedVisual.icon}
            </span>
            <span className="truncate text-sm">
              {t(`hostDetails.connectionType.${value}`)}
            </span>
          </span>
          <ChevronDown size={14} className="shrink-0 opacity-60" />
        </Button>
      </DropdownTrigger>
      <DropdownContent className="flex w-max min-w-[220px] flex-col" align="start" alignToParent>
        {HOST_CONNECTION_TYPES.map((type) => {
          const visual = protocolVisual(type);
          const selected = type === value;
          return (
            <Button
              key={type}
              type="button"
              variant="ghost"
              data-connection-type={type}
              className={cn("justify-start gap-2", selected && "bg-secondary/70")}
              onClick={() => {
                if (!selected) onChange(type);
              }}
            >
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5",
                  selected ? visual.selected : visual.idle,
                )}
              >
                {visual.icon}
              </span>
              <span className="truncate text-sm">{t(`hostDetails.connectionType.${type}`)}</span>
            </Button>
          );
        })}
      </DropdownContent>
    </Dropdown>
  );
};

export default HostConnectionTypeSelect;
