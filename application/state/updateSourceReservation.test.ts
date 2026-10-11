import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyUpdateSourceConfig,
  buildReleaseMetadataUrl,
  checkForUpdates,
  checkForUpdatesAgainst,
  getReleasesPageUrl,
  getUpdateSourceConfig,
  isUpdateSourceConfigured,
  subscribeUpdateSource,
} from '../../infrastructure/services/updateService';

/**
 * The cloud (GitHub) update source is cancelled: the only remaining source is
 * the self-hosted server, configured in Settings > System (persisted by the
 * main process) and mirrored into this module store. These tests pin the store
 * behaviour plus the reserved metadata contract.
 */

/** Release metadata in the shape the reserved latest.json must serve. */
const SELF_HOSTED_METADATA = {
  tag_name: 'v9.9.9',
  name: 'Netcatty v9.9.9',
  body: 'notes',
  html_url: 'http://update.local/netcatty/',
  published_at: '2026-01-01T00:00:00Z',
  assets: [],
};

async function withStubbedFetch(
  responder: () => Promise<Response> | Response,
  fn: (calls: string[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return responder();
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

/** Run `fn` against a temporary source and restore the previous one. */
async function withUpdateSource(
  next: Parameters<typeof applyUpdateSourceConfig>[0],
  fn: () => Promise<void>,
): Promise<void> {
  const previous = getUpdateSourceConfig();
  applyUpdateSourceConfig(next);
  try {
    await fn();
  } finally {
    applyUpdateSourceConfig(previous);
  }
}

test('the update source starts from the shipped factory defaults', () => {
  const config = getUpdateSourceConfig();
  assert.equal(isUpdateSourceConfigured(), config.updateServerUrl !== null);
  assert.equal(getReleasesPageUrl(), config.releasesPageUrl ?? '');
});

test('applying a source notifies subscribers and gates the checks', async () => {
  let notifications = 0;
  const unsubscribe = subscribeUpdateSource(() => {
    notifications += 1;
  });

  try {
    await withUpdateSource({ updateServerUrl: 'http://update.local/netcatty', releasesPageUrl: '' }, async () => {
      assert.equal(getUpdateSourceConfig().updateServerUrl, 'http://update.local/netcatty');
      assert.equal(isUpdateSourceConfigured(), true);
      assert.equal(getReleasesPageUrl(), '');
      assert.ok(notifications >= 1, 'subscribers must be notified');
    });

    await withUpdateSource({ updateServerUrl: null, releasesPageUrl: 'http://update.local/netcatty/download' }, async () => {
      assert.equal(isUpdateSourceConfigured(), false);
      assert.equal(getReleasesPageUrl(), 'http://update.local/netcatty/download');
    });
  } finally {
    unsubscribe();
  }
});

test('the reserved manifest path is <updateServerUrl>/latest.json', () => {
  assert.equal(
    buildReleaseMetadataUrl('http://update.local/netcatty/'),
    'http://update.local/netcatty/latest.json',
  );
});

test('checkForUpdates only contacts a configured self-hosted source', async () => {
  await withStubbedFetch(() => okResponse(SELF_HOSTED_METADATA), async (calls) => {
    // Unconfigured: the cancelled cloud source stays completely offline.
    await withUpdateSource({ updateServerUrl: null }, async () => {
      const result = await checkForUpdates('1.0.0');
      assert.deepEqual(calls, []);
      assert.equal(result.hasUpdate, false);
      assert.equal(result.latestRelease, null);
      assert.equal(result.error, undefined);
    });

    // Configured: the metadata file served by the self-hosted source is used.
    await withUpdateSource({ updateServerUrl: 'http://update.local/netcatty' }, async () => {
      const result = await checkForUpdates('1.0.0');
      assert.deepEqual(calls, ['http://update.local/netcatty/latest.json']);
      assert.equal(result.hasUpdate, true);
      assert.equal(result.latestRelease?.version, '9.9.9');
    });
  });
});

test('a configured self-hosted source drives the version comparison', async () => {
  const baseUrl = 'http://update.local/netcatty';
  await withStubbedFetch(() => okResponse(SELF_HOSTED_METADATA), async (calls) => {
    const newer = await checkForUpdatesAgainst(baseUrl, '1.0.0');
    assert.deepEqual(calls, [`${baseUrl}/latest.json`]);
    assert.equal(newer.hasUpdate, true);
    assert.equal(newer.latestRelease?.version, '9.9.9');

    const current = await checkForUpdatesAgainst(baseUrl, '10.0.0');
    assert.equal(current.hasUpdate, false);
    assert.equal(current.latestRelease?.version, '9.9.9');
  });
});

test('an unreachable self-hosted source reports an error instead of throwing', async () => {
  await withStubbedFetch(
    () => {
      throw new Error('connect ECONNREFUSED');
    },
    async () => {
      const result = await checkForUpdatesAgainst('http://update.local/netcatty', '1.0.0');
      assert.equal(result.hasUpdate, false);
      assert.equal(result.latestRelease, null);
      assert.match(result.error ?? '', /ECONNREFUSED/);
    },
  );
});

/**
 * Install (or clear) a fake `window.netcatty` for one test body so the bridge
 * path of the manifest reader can be exercised in Node.
 */
async function withBridge(
  bridge: { fetchUpdateMetadata?: (input: { baseUrl?: string }) => Promise<unknown> } | null,
  fn: () => Promise<void>,
): Promise<void> {
  const scope = globalThis as unknown as { window?: unknown };
  const previous = scope.window;
  scope.window = bridge ? { netcatty: bridge } : undefined;
  try {
    await fn();
  } finally {
    scope.window = previous;
  }
}

/**
 * Feed hosts commonly answer without Access-Control-Allow-Origin (the factory
 * GitHub release-asset URL does not), so the renderer's own fetch is blocked
 * even though the manifest is reachable. Main does the request instead.
 */
test('the release manifest is read through the main process bridge when available', async () => {
  const requests: Array<{ baseUrl?: string }> = [];

  await withStubbedFetch(
    () => {
      throw new Error('the renderer must not fetch the manifest itself');
    },
    async (rendererFetches) => {
      await withBridge(
        {
          fetchUpdateMetadata: async (input) => {
            requests.push(input);
            return { ok: true, status: 200, data: SELF_HOSTED_METADATA };
          },
        },
        async () => {
          const result = await checkForUpdatesAgainst('http://update.local/netcatty', '1.0.0');

          assert.deepEqual(requests, [{ baseUrl: 'http://update.local/netcatty' }]);
          assert.deepEqual(rendererFetches, [], 'no CORS-prone renderer fetch');
          assert.equal(result.hasUpdate, true);
          assert.equal(result.latestRelease?.version, '9.9.9');
          assert.equal(result.latestRelease?.name, 'Netcatty v9.9.9');
        },
      );
    },
  );
});

test('a bridge failure is reported as an update-check error', async () => {
  await withBridge(
    { fetchUpdateMetadata: async () => ({ ok: false, status: 404, error: 'Update server returned 404' }) },
    async () => {
      const result = await checkForUpdatesAgainst('http://update.local/netcatty', '1.0.0');
      assert.equal(result.hasUpdate, false);
      assert.equal(result.latestRelease, null);
      assert.match(result.error ?? '', /404/);
    },
  );
});

test('falls back to the renderer fetch when the bridge exposes no metadata reader', async () => {
  await withStubbedFetch(() => okResponse(SELF_HOSTED_METADATA), async (calls) => {
    await withBridge({}, async () => {
      const result = await checkForUpdatesAgainst('http://update.local/netcatty', '1.0.0');
      assert.deepEqual(calls, ['http://update.local/netcatty/latest.json']);
      assert.equal(result.hasUpdate, true);
    });
  });
});
