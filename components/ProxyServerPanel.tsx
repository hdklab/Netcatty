import { Check, Copy, Globe2, Server, ShieldAlert, ShieldCheck } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import {
  setLocalProxyServerEnabled,
  syncLocalProxyServerProfiles,
  updateLocalProxyServerConfig,
  useLocalProxyServer,
} from "../application/state/localProxyServerStore";
import {
  formatLocalProxyEndpoint,
  isLocalProxyOpenToNetwork,
  type LocalProxyServerError,
} from "../domain/localProxyServer";
import { isValidProxyPort } from "../domain/proxyProfiles";
import type { ProxyProfile } from "../types";
import { AsidePanel, AsidePanelContent, AsidePanelFooter } from "./ui/aside-panel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { toast } from "./ui/toast";

interface ProxyServerPanelProps {
  open: boolean;
  onClose: () => void;
  proxyProfiles: ProxyProfile[];
}

const DIRECT_UPSTREAM_VALUE = "__direct__";

/**
 * Configuration + live status for the local proxy server: one listener that
 * turns this PC into an SOCKS5 / HTTP proxy for other devices.
 */
export const ProxyServerPanel: React.FC<ProxyServerPanelProps> = ({ open, onClose, proxyProfiles }) => {
  const { t } = useI18n();
  const { config, status, busy, error } = useLocalProxyServer();
  const [portDraft, setPortDraft] = useState(String(config.port));
  const [usernameDraft, setUsernameDraft] = useState(config.username);
  const [passwordDraft, setPasswordDraft] = useState(config.password);
  const [copiedKind, setCopiedKind] = useState<string | null>(null);

  useEffect(() => {
    if (open) syncLocalProxyServerProfiles(proxyProfiles);
  }, [open, proxyProfiles]);

  useEffect(() => {
    setPortDraft(String(config.port));
    setUsernameDraft(config.username);
    setPasswordDraft(config.password);
  }, [config.password, config.port, config.username]);

  const upstreamProfiles = useMemo(
    () => proxyProfiles.filter((profile) => profile.config.type === "http" || profile.config.type === "socks5"),
    [proxyProfiles],
  );

  const errorMessage = (value: LocalProxyServerError | null): string | null => {
    switch (value) {
      case null:
        return null;
      case "invalid-port":
        return t("proxyServer.error.port");
      case "invalid-credentials":
        return t("proxyServer.error.credentials");
      case "port-in-use":
        return t("proxyServer.error.portInUse", { port: config.port });
      case "permission-denied":
        return t("proxyServer.error.permissionDenied", { port: config.port });
      case "missing-upstream":
        return t("proxyServer.error.missingUpstream");
      case "unsupported-upstream":
        return t("proxyServer.error.unsupportedUpstream");
      default:
        return t("proxyServer.error.listenFailed");
    }
  };

  // One block per address the PC is reachable on, so a device on 192.168.x and
  // one on 10.x both see an endpoint that works for them.
  const endpointHosts = useMemo(() => {
    if (config.scope !== "lan") return ["127.0.0.1"];
    const addresses = status.lanAddresses?.length ? status.lanAddresses : [];
    return addresses.length ? addresses : ["0.0.0.0"];
  }, [config.scope, status.lanAddresses]);
  const socksEndpoint = formatLocalProxyEndpoint(endpointHosts[0], config.port, "socks5");

  const handleToggle = async (next: boolean) => {
    const failure = await setLocalProxyServerEnabled(next);
    if (!next) {
      toast.success(t("proxyServer.toast.stopped"));
      return;
    }
    const message = errorMessage(failure);
    if (message) toast.error(message);
    else toast.success(t("proxyServer.toast.started", { endpoint: socksEndpoint }));
  };

  const commitPort = async () => {
    const port = Number(portDraft);
    if (!isValidProxyPort(port)) {
      toast.error(t("proxyServer.error.port"));
      setPortDraft(String(config.port));
      return;
    }
    if (port === config.port) return;
    await updateLocalProxyServerConfig({ port });
  };

  const commitCredentials = async () => {
    if (
      usernameDraft === config.username
      && passwordDraft === config.password
    ) {
      return;
    }
    await updateLocalProxyServerConfig({ username: usernameDraft, password: passwordDraft });
  };

  const copyEndpoint = async (value: string, kind: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKind(kind);
      setTimeout(() => setCopiedKind((current) => (current === kind ? null : current)), 1500);
      toast.success(t("proxyServer.copied"));
    } catch {
      toast.error(value);
    }
  };

  const openToNetwork = isLocalProxyOpenToNetwork(config);
  const activeError = errorMessage(error);

  return (
    <AsidePanel
      open={open}
      onClose={onClose}
      title={t("proxyServer.panel.title")}
      subtitle={t("proxyServer.panel.subtitle")}
      width="w-[400px]"
    >
      <AsidePanelContent>
        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Server size={14} className={status.running ? "text-primary" : "text-muted-foreground"} />
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("proxyServer.toggle.label")}</p>
                <p className="text-xs text-muted-foreground">{t("proxyServer.toggle.desc")}</p>
              </div>
            </div>
            <Switch
              aria-label={t("proxyServer.toggle.label")}
              checked={status.running}
              disabled={busy}
              onCheckedChange={(next) => void handleToggle(next)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={status.running ? "default" : "secondary"} className="text-xs">
              {status.running ? t("proxyServer.status.running") : t("proxyServer.status.stopped")}
            </Badge>
            {status.running && (
              <span className="text-xs text-muted-foreground">
                {t("proxyServer.stats.connections")}: {status.activeConnections} ·{" "}
                {t("proxyServer.stats.requests")}: {status.requests} ·{" "}
                {t("proxyServer.stats.failures")}: {status.failures}
              </span>
            )}
          </div>
          {activeError && (
            <p className="text-xs text-destructive">{activeError}</p>
          )}
        </Card>

        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="space-y-2">
            <Label htmlFor="proxy-server-port" className="text-xs text-muted-foreground">
              {t("proxyServer.field.port")}
            </Label>
            <Input
              id="proxy-server-port"
              type="number"
              min={1}
              max={65535}
              value={portDraft}
              onChange={(event) => setPortDraft(event.target.value)}
              onBlur={() => void commitPort()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitPort();
              }}
              className="h-10 w-28 text-center"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">{t("proxyServer.field.scope")}</Label>
            <Select
              value={config.scope}
              onValueChange={(value) => {
                void updateLocalProxyServerConfig({ scope: value === "lan" ? "lan" : "loopback" });
              }}
            >
              <SelectTrigger aria-label={t("proxyServer.field.scope")} className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="loopback">{t("proxyServer.scope.loopback")}</SelectItem>
                <SelectItem value="lan">{t("proxyServer.scope.lan")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">{t("proxyServer.field.upstream")}</Label>
            <Select
              value={config.upstreamProfileId || DIRECT_UPSTREAM_VALUE}
              onValueChange={(value) => {
                void updateLocalProxyServerConfig({
                  upstreamProfileId: value === DIRECT_UPSTREAM_VALUE ? null : value,
                });
              }}
            >
              <SelectTrigger aria-label={t("proxyServer.field.upstream")} className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DIRECT_UPSTREAM_VALUE}>{t("proxyServer.upstream.direct")}</SelectItem>
                {upstreamProfiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">{t("proxyServer.hint.both")}</p>
        </Card>

        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {config.authEnabled ? (
                <ShieldCheck size={14} className="text-primary" />
              ) : (
                <ShieldAlert size={14} className="text-muted-foreground" />
              )}
              <p className="text-xs font-semibold">{t("proxyServer.field.auth")}</p>
            </div>
            <Switch
              aria-label={t("proxyServer.field.auth")}
              checked={config.authEnabled}
              onCheckedChange={(next) => {
                void updateLocalProxyServerConfig({ authEnabled: next });
              }}
            />
          </div>
          {config.authEnabled && (
            <div className="space-y-2">
              <Input
                aria-label={t("proxyServer.field.username")}
                value={usernameDraft}
                onChange={(event) => setUsernameDraft(event.target.value)}
                onBlur={() => void commitCredentials()}
                placeholder={t("proxyServer.field.username")}
                className="h-10"
              />
              <Input
                aria-label={t("proxyServer.field.password")}
                type="password"
                value={passwordDraft}
                onChange={(event) => setPasswordDraft(event.target.value)}
                onBlur={() => void commitCredentials()}
                placeholder={t("proxyServer.field.password")}
                className="h-10"
              />
            </div>
          )}
          {openToNetwork && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
              {t("proxyServer.warning.openLan")}
            </p>
          )}
        </Card>

        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Globe2 size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("proxyServer.endpoint.title")}</p>
          </div>
          {endpointHosts.map((host) => (
            <div key={host} className="space-y-1.5">
              <p className="font-mono text-[11px] text-muted-foreground">{host}</p>
              {(["socks5", "http"] as const).map((protocol) => {
                const value = formatLocalProxyEndpoint(host, config.port, protocol);
                const copyKind = `${protocol}:${host}`;
                return (
                  <div key={copyKind} className="flex items-center gap-2 min-w-0">
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {protocol === "socks5" ? t("proxyServer.endpoint.socks5") : t("proxyServer.endpoint.http")}
                    </Badge>
                    <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
                    <Button
                      aria-label={t("proxyServer.copy")}
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => void copyEndpoint(value, copyKind)}
                    >
                      {copiedKind === copyKind ? <Check size={13} /> : <Copy size={13} />}
                    </Button>
                  </div>
                );
              })}
            </div>
          ))}
          {status.lastError && status.running && (
            <p className="text-xs text-muted-foreground break-words">{status.lastError}</p>
          )}
        </Card>
      </AsidePanelContent>
      <AsidePanelFooter>
        <Button className="w-full" variant="secondary" onClick={onClose}>
          {t("common.close")}
        </Button>
      </AsidePanelFooter>
    </AsidePanel>
  );
};

export default ProxyServerPanel;
