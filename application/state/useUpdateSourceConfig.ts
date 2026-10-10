import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  ensureUpdateSourceHydrated,
  getUpdateSourceConfig,
  saveUpdateSourceConfig,
  subscribeUpdateSource,
  subscribeUpdateSourceChanges,
  type UpdateSourceConfig,
} from '../../infrastructure/services/updateService';

export interface UseUpdateSourceConfigResult {
  /** Effective source: env override → in-app configuration → shipped defaults. */
  config: UpdateSourceConfig;
  /** True once a feed URL is in effect. */
  configured: boolean;
  /** Effective feed base URL ('' when unconfigured). */
  updateServerUrl: string;
  /** Effective human-facing download page ('' when unconfigured). */
  releasesPageUrl: string;
  /** Persist a new source and apply it live (no restart). */
  save: (input: { updateServerUrl: string; releasesPageUrl: string }) => Promise<{ success: boolean; error?: string }>;
}

/**
 * React binding for the self-hosted update source (Settings > System >
 * Software Update). Components must go through this hook instead of importing
 * the service directly (layering rule), and the shared module store keeps every
 * consumer in sync.
 */
export function useUpdateSourceConfig(): UseUpdateSourceConfigResult {
  const config = useSyncExternalStore(
    subscribeUpdateSource,
    getUpdateSourceConfig,
    getUpdateSourceConfig,
  );

  useEffect(() => {
    void ensureUpdateSourceHydrated();
    // Follow saves made in another window (e.g. the Settings window).
    return subscribeUpdateSourceChanges();
  }, []);

  const save = useCallback(
    (input: { updateServerUrl: string; releasesPageUrl: string }) => saveUpdateSourceConfig(input),
    [],
  );

  return {
    config,
    configured: config.updateServerUrl !== null,
    updateServerUrl: config.updateServerUrl ?? '',
    releasesPageUrl: config.releasesPageUrl ?? '',
    save,
  };
}
