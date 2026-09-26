'use strict';

/**
 * Tests for the fetch/cache layer.
 *
 * `pi` is a global the host injects, so these tests install a fake one around
 * each case rather than importing the module under a stub — that is also how
 * the module will be loaded in production, so the seam is exercised honestly.
 *
 * The behaviours worth pinning here are the ones a dashboard would silently get
 * wrong: paging past the first page, the cache never serving a scoped answer to
 * an unscoped ask, and an invalidate() not being undone by a read already in
 * flight.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const HOUR = 3600 * 1000;

/** Install a fake host `pi` for the duration of one test. */
async function withHost(implementation, run) {
  const previous = globalThis.pi;
  globalThis.pi = implementation;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete globalThis.pi;
    else globalThis.pi = previous;
  }
}

function row(id, overrides = {}) {
  return {
    turnId: id,
    sessionId: 's1',
    sessionTitle: 'S',
    projectId: null,
    providerId: 'anthropic',
    modelId: 'claude',
    startedAt: 0,
    endedAt: 0,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  };
}

/** Load the store fresh so module-level state never leaks between tests. */
function freshStore() {
  delete require.cache[require.resolve('../lib/usage-store.js')];
  return require('../lib/usage-store.js');
}

test('fetchTurns walks the keyset cursor to the end of the window', async () => {
  const { fetchTurns } = freshStore();
  const calls = [];
  const now = Date.now();

  await withHost(
    {
      usage: {
        listTurns: async (input) => {
          calls.push(input);
          // Two full pages, then an exhausted window.
          if (!input.cursor) return { turns: [row('a'), row('b')], nextCursor: 'c1' };
          if (input.cursor === 'c1') return { turns: [row('c')], nextCursor: null };
          return { turns: [], nextCursor: null };
        },
      },
    },
    async () => {
      const result = await fetchTurns({ toMs: now });
      assert.equal(result.turns.length, 3);
      assert.equal(result.truncated, false);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].limit, 500);
      assert.equal(calls[1].cursor, 'c1');
    },
  );
});

test('fetchTurns stops at the row budget and reports truncation', async () => {
  const { fetchTurns, MAX_ROWS } = freshStore();
  await withHost(
    {
      usage: {
        // A host that never stops handing out pages must not hang the plugin.
        listTurns: async () => ({
          turns: Array.from({ length: 500 }, (_, i) => row(`t${Math.random()}${i}`)),
          nextCursor: 'more',
        }),
      },
    },
    async () => {
      const result = await fetchTurns({ toMs: Date.now() });
      assert.equal(result.turns.length, MAX_ROWS);
      assert.equal(result.truncated, true);
    },
  );
});

test('fetchTurns clamps a window wider than the host allows', async () => {
  const { fetchTurns, MAX_WINDOW_MS } = freshStore();
  let seen = null;
  const now = Date.now();

  await withHost(
    {
      usage: {
        listTurns: async (input) => {
          seen = input;
          return { turns: [], nextCursor: null };
        },
      },
    },
    async () => {
      // Ten years back: the host would reject this with INVALID_PARAMS.
      await fetchTurns({ fromMs: now - 3650 * 24 * HOUR, toMs: now });
      assert.ok(seen.toMs - seen.fromMs <= MAX_WINDOW_MS);
      assert.equal(seen.toMs, now);
    },
  );
});

test('fetchTurns stops on an empty page rather than looping on a stale cursor', async () => {
  const { fetchTurns } = freshStore();
  let calls = 0;
  await withHost(
    {
      usage: {
        listTurns: async () => {
          calls += 1;
          return { turns: [], nextCursor: 'stuck' };
        },
      },
    },
    async () => {
      const result = await fetchTurns({ toMs: Date.now() });
      assert.equal(result.turns.length, 0);
      assert.equal(calls, 1);
    },
  );
});

test('the store collapses concurrent reads onto one scan', async () => {
  const { createUsageStore } = freshStore();
  let scans = 0;
  const fetchImpl = async () => {
    scans += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { turns: [row('a', { inputTokens: 10 })], truncated: false, fromMs: 0, toMs: Date.now() };
  };

  await withHost({ plugin: { getSettings: async () => ({}) } }, async () => {
    const store = createUsageStore({ fetch: fetchImpl, ttlMs: 10_000 });
    const [a, b, c] = await Promise.all([store.read(), store.read(), store.read()]);
    assert.equal(scans, 1);
    assert.equal(a.total, b.total);
    assert.equal(b.total, c.total);
  });
});

test('a project-scoped read never joins an unscoped in-flight scan', async () => {
  const { createUsageStore } = freshStore();
  const seen = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchImpl = async (request) => {
    seen.push(request.projectId ?? null);
    if (seen.length === 1) await gate;
    const turns = request.projectId === 7
      ? [row('a', { projectId: 7, inputTokens: 10 })]
      : [row('a', { projectId: 7, inputTokens: 10 }), row('b', { projectId: 8, inputTokens: 999 })];
    return { turns, truncated: false, fromMs: 0, toMs: Date.now() };
  };

  await withHost({ plugin: { getSettings: async () => ({}) } }, async () => {
    const store = createUsageStore({ fetch: fetchImpl, ttlMs: 10_000 });
    const broad = store.read();
    const scoped = store.read({ projectId: 7 });
    release();
    const [broadData, scopedData] = await Promise.all([broad, scoped]);
    // The scoped answer must not inherit the unscoped total.
    // The scoped answer must not inherit the unscoped total. Each row also
    // carries the default outputTokens: 1, so the unscoped sum is
    // (10 + 1) + (999 + 1) = 1011.
    assert.equal(broadData.total, 1011);
    assert.equal(scopedData.total, 11);
  });
});

test('a fresh read within the TTL is served from cache', async () => {
  const { createUsageStore } = freshStore();
  let scans = 0;
  const fetchImpl = async () => {
    scans += 1;
    return { turns: [row('a', { inputTokens: 4 })], truncated: false, fromMs: 0, toMs: Date.now() };
  };

  await withHost({ plugin: { getSettings: async () => ({}) } }, async () => {
    const store = createUsageStore({ fetch: fetchImpl, ttlMs: 10_000 });
    await store.read();
    await store.read();
    assert.equal(scans, 1);
    store.invalidate();
    await store.read();
    assert.equal(scans, 2);
  });
});

test('a read already in flight cannot repopulate the cache after invalidate', async () => {
  const { createUsageStore } = freshStore();
  let scans = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchImpl = async () => {
    scans += 1;
    if (scans === 1) await gate;
    return { turns: [row('a', { inputTokens: scans })], truncated: false, fromMs: 0, toMs: Date.now() };
  };

  await withHost({ plugin: { getSettings: async () => ({}) } }, async () => {
    const store = createUsageStore({ fetch: fetchImpl, ttlMs: 10_000 });
    const stale = store.read();
    store.invalidate();
    release();
    await stale;
    // The next read must go back to the host rather than reuse the snapshot
    // that was already stale when it was requested.
    const fresh = await store.read();
    assert.equal(scans, 2);
    // The second scan stamps inputTokens: 2, plus the row default of 1 output.
    assert.equal(fresh.total, 3);
  });
});

test('settings drive the includeCache and topModels options', async () => {
  const { createUsageStore } = freshStore();
  const fetchImpl = async () => ({
    turns: [row('a', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 })],
    truncated: false,
    fromMs: 0,
    toMs: Date.now(),
  });

  await withHost(
    {
      plugin: {
        getSettings: async () => ({ includeCache: false, topModels: 3, scope: 'project' }),
      },
    },
    async () => {
      const store = createUsageStore({ fetch: fetchImpl, ttlMs: 0 });
      const data = await store.read();
      assert.equal(data.total, 15);
      assert.equal(data.scope, 'project');
    },
  );
});

test('a non-numeric topModels setting falls back to the default', async () => {
  const { createUsageStore } = freshStore();
  const fetchImpl = async () => ({
    turns: Array.from({ length: 12 }, (_, i) => row(`t${i}`, { modelId: `m${i}`, inputTokens: 1 })),
    truncated: false,
    fromMs: 0,
    toMs: Date.now(),
  });

  await withHost(
    { plugin: { getSettings: async () => ({ topModels: 'lots' }) } },
    async () => {
      const store = createUsageStore({ fetch: fetchImpl, ttlMs: 0 });
      const data = await store.read();
      // 12 distinct models, default cap of 8, plus one folded overflow row.
      assert.equal(data.models.length, 8);
      assert.equal(data.modelsRest.hiddenModels, 4);
    },
  );
});

test('the compact projection carries exactly the four strip numbers', async () => {
  const { createUsageStore } = freshStore();
  const now = Date.now();
  const fetchImpl = async () => ({
    turns: [row('a', { endedAt: now, inputTokens: 100, outputTokens: 20 })],
    truncated: false,
    fromMs: 0,
    toMs: now,
  });

  await withHost({ plugin: { getSettings: async () => ({}) } }, async () => {
    const store = createUsageStore({ fetch: fetchImpl, ttlMs: 0 });
    const data = await store.read();
    assert.deepEqual(Object.keys(data.compact).sort(), ['last30', 'last7', 'today', 'total']);
    assert.equal(data.compact.total, 120);
    assert.equal(data.compact.today, 120);
  });
});

test('model labels resolve from the catalog and prefer a user alias', async () => {
  const { modelLabels, applyModelLabels } = freshStore();
  const labels = await withHost(
    {
      models: {
        list: async () => [
          { providerId: 'anthropic', providerName: 'Anthropic', modelId: 'sonnet', label: 'Claude Sonnet' },
          { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt', label: 'GPT-5', alias: '我的 GPT' },
          null,
          { providerId: 'broken' },
        ],
      },
    },
    () => modelLabels(),
  );

  assert.equal(labels.get('anthropic/sonnet').label, 'Claude Sonnet');
  assert.equal(labels.get('anthropic/sonnet').providerName, 'Anthropic');
  // The user's own alias wins over the vendor's label.
  assert.equal(labels.get('openai/gpt').label, '我的 GPT');
  // A row missing an id is skipped, not turned into a bogus key.
  assert.equal(labels.size, 2);

  const rows = applyModelLabels(
    [{ key: 'anthropic/sonnet', modelId: 'sonnet' }, { key: 'gone/model', modelId: 'model' }],
    labels,
  );
  assert.equal(rows[0].label, 'Claude Sonnet');
  // A model the catalog no longer knows keeps its raw id and gains no label.
  assert.equal(rows[1].label, undefined);
});

test('a missing or denied models.list degrades to raw ids', async () => {
  const { modelLabels, applyModelLabels } = freshStore();
  const rows = [{ key: 'anthropic/sonnet', modelId: 'sonnet' }];

  // No `models` namespace at all.
  const noApi = await withHost({}, () => modelLabels());
  assert.equal(noApi.size, 0);
  assert.equal(applyModelLabels(rows, noApi)[0].label, undefined);

  // The call exists but the grant was refused.
  const denied = await withHost(
    {
      models: {
        list: async () => {
          throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
        },
      },
    },
    () => modelLabels(),
  );
  assert.equal(denied.size, 0);
  assert.equal(applyModelLabels(rows, denied)[0].label, undefined);
});

test('the store folds catalog labels into the model rows it returns', async () => {
  const { createUsageStore } = freshStore();
  const fetchImpl = async () => ({
    turns: [row('a', { providerId: 'anthropic', modelId: 'sonnet', inputTokens: 10 })],
    truncated: false,
    fromMs: 0,
    toMs: Date.now(),
  });

  await withHost(
    {
      plugin: { getSettings: async () => ({}) },
      models: {
        list: async () => [
          { providerId: 'anthropic', providerName: 'Anthropic', modelId: 'sonnet', label: 'Claude Sonnet 4.5' },
        ],
      },
    },
    async () => {
      const store = createUsageStore({ fetch: fetchImpl, ttlMs: 0 });
      const data = await store.read();
      assert.equal(data.models[0].label, 'Claude Sonnet 4.5');
      assert.equal(data.models[0].providerName, 'Anthropic');
      // The raw key is still there, so the tooltip can stay traceable.
      assert.equal(data.models[0].key, 'anthropic/sonnet');
    },
  );
});

test('project labels resolve from the project directory, keyed by numeric id', async () => {
  const { projectLabels, applyProjectLabels } = freshStore();
  const labels = await withHost(
    {
      desktop: {
        invoke: async (input) => {
          assert.equal(input.operation, 'project/list');
          return {
            projects: [
              { id: 1, name: 'pi-desktop', path: '/Users/f4ct0r/Programs/git/PI-Desktop' },
              // A blank name still has a folder to be called by.
              { id: 2, name: '  ', path: '/Users/f4ct0r/Programs/git/pi-desktop-token-analyzer' },
              // RACP projects the same rows with a string id and no path.
              { id: '3', label: undefined, name: 'ARL', path: '/Users/f4ct0r/Programs/git/ARL' },
              null,
              { name: 'no id' },
            ],
          };
        },
      },
    },
    () => projectLabels(),
  );

  assert.equal(labels.size, 3);
  assert.equal(labels.get(1).label, 'pi-desktop');
  assert.equal(labels.get(1).path, '/Users/f4ct0r/Programs/git/PI-Desktop');
  assert.equal(labels.get(2).label, 'pi-desktop-token-analyzer');
  // A string id from the RACP shape keys the same map as a numeric one.
  assert.equal(labels.get(3).label, 'ARL');

  const rows = applyProjectLabels(
    [
      { projectId: 1, total: 10 },
      { projectId: 9, total: 5 },
      { projectId: null, total: 1 },
    ],
    labels,
  );
  assert.equal(rows[0].label, 'pi-desktop');
  // A project deleted since its last session keeps its id and gains no label.
  assert.equal(rows[1].label, undefined);
  // The unbound bucket is never decorated.
  assert.equal(rows[2].label, undefined);
  // The raw id survives so the row stays traceable to the fact rows.
  assert.equal(rows[0].projectId, 1);
});

test('a missing or denied project/list degrades to numeric ids', async () => {
  const { projectLabels, applyProjectLabels } = freshStore();
  const rows = [{ projectId: 1, total: 10 }];

  // No `desktop` namespace at all.
  const noApi = await withHost({}, () => projectLabels());
  assert.equal(noApi.size, 0);
  assert.equal(applyProjectLabels(rows, noApi)[0].label, undefined);

  // The call exists but the `desktop.control` grant was refused.
  const denied = await withHost(
    {
      desktop: {
        invoke: async () => {
          throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
        },
      },
    },
    () => projectLabels(),
  );
  assert.equal(denied.size, 0);
  assert.equal(applyProjectLabels(rows, denied)[0].label, undefined);

  // A host whose answer is not the documented shape yields no labels either.
  const odd = await withHost({ desktop: { invoke: async () => ({}) } }, () => projectLabels());
  assert.equal(odd.size, 0);
});

test('the store folds project names into the project rows it returns', async () => {
  const { createUsageStore } = freshStore();
  const fetchImpl = async () => ({
    turns: [row('a', { projectId: 1, inputTokens: 10 })],
    truncated: false,
    fromMs: 0,
    toMs: Date.now(),
  });

  await withHost(
    {
      plugin: { getSettings: async () => ({}) },
      desktop: {
        invoke: async () => ({ projects: [{ id: 1, name: 'PI-Desktop', path: '/git/PI-Desktop' }] }),
      },
    },
    async () => {
      const store = createUsageStore({ fetch: fetchImpl, ttlMs: 0 });
      const data = await store.read();
      assert.equal(data.projects.length, 1);
      assert.equal(data.projects[0].label, 'PI-Desktop');
      assert.equal(data.projects[0].projectPath, '/git/PI-Desktop');
      assert.equal(data.projects[0].projectId, 1);
    },
  );
});

test('a store read still succeeds when the project directory is unavailable', async () => {
  const { createUsageStore } = freshStore();
  const fetchImpl = async () => ({
    turns: [row('a', { projectId: 1, inputTokens: 10, outputTokens: 10 })],
    truncated: false,
    fromMs: 0,
    toMs: Date.now(),
  });

  await withHost(
    {
      plugin: { getSettings: async () => ({}) },
      desktop: {
        invoke: async () => {
          throw new Error('host api not available: desktop.listOperations');
        },
      },
    },
    async () => {
      const store = createUsageStore({ fetch: fetchImpl, ttlMs: 0 });
      const data = await store.read();
      // Numbers survive; only the name is missing.
      assert.equal(data.total, 20);
      assert.equal(data.projects[0].label, undefined);
    },
  );
});
