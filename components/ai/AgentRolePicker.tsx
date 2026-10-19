import { Bot, Check, ChevronDown, ListChecks, MessageSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { AGENT_ROLES, type AgentRole } from '../../application/state/agentRole';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

/**
 * Composer chip that selects Catty's role. Mirrors `ComposerModelPicker`'s
 * trigger/popover styling so the two chips read as one control row.
 */
export interface AgentRoleOption {
  role: AgentRole;
  /** i18n key for the short label (`Ask` / `Agent` / `Plan`). */
  labelKey: string;
  /** i18n key for the one-line explanation under the label. */
  descriptionKey: string;
}

/** Menu order follows VS Code: ask (read-only) → agent (default) → plan. */
export const AGENT_ROLE_OPTIONS: readonly AgentRoleOption[] = AGENT_ROLES.map((role) => ({
  role,
  labelKey: `ai.role.${role}`,
  descriptionKey: `ai.role.${role}.description`,
}));

const ROLE_ICONS: Record<AgentRole, LucideIcon> = {
  ask: MessageSquare,
  agent: Bot,
  plan: ListChecks,
};

const ROLE_ICON_COLORS: Record<AgentRole, string> = {
  ask: 'text-sky-400/70',
  agent: 'text-emerald-400/70',
  plan: 'text-violet-400/70',
};

export interface AgentRolePickerProps {
  role: AgentRole;
  onSelect: (role: AgentRole) => void;
  /** Turn configuration is locked while a turn is running. */
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AgentRolePicker: React.FC<AgentRolePickerProps> = ({
  role,
  onSelect,
  disabled = false,
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const ActiveIcon = ROLE_ICONS[role];

  return (
    <Popover open={open} onOpenChange={(next) => {
      if (disabled && next) return;
      onOpenChange(next);
    }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-[10.5px] text-foreground/72 ${
                disabled ? 'opacity-60' : 'cursor-pointer hover:bg-muted/24 transition-colors'
              }`}
              aria-label={t('ai.role.label')}
              aria-expanded={open}
            >
              <ActiveIcon size={11} className={`${ROLE_ICON_COLORS[role]} shrink-0`} />
              <span className="truncate max-w-[64px]">{t(`ai.role.${role}`)}</span>
              {!disabled && <ChevronDown size={9} className="text-muted-foreground/50" />}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('ai.role.label')}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-[264px] max-w-[calc(100vw-16px)] p-1"
        role="listbox"
        aria-label={t('ai.role.label')}
      >
        {AGENT_ROLE_OPTIONS.map(({ role: optionRole, labelKey, descriptionKey }) => {
          const Icon = ROLE_ICONS[optionRole];
          const selected = optionRole === role;
          return (
            <button
              key={optionRole}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => {
                onOpenChange(false);
                if (!selected) onSelect(optionRole);
              }}
              className="w-full flex items-start gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer"
            >
              {selected
                ? <Check size={11} className="mt-0.5 text-primary shrink-0" />
                : <span className="mt-0.5 w-[11px] shrink-0" />}
              <Icon size={12} className={`mt-0.5 ${ROLE_ICON_COLORS[optionRole]} shrink-0`} />
              <span className="min-w-0 flex-1">
                <span className="block text-foreground/88">{t(labelKey)}</span>
                <span className="block truncate text-[10.5px] text-muted-foreground/50">
                  {t(descriptionKey)}
                </span>
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
};

export default React.memo(AgentRolePicker);
