'use strict';

/**
 * Fetches usage facts from the host and turns them into dashboard data.
 *
 * `pi.usage.listTurns` is a keyset-paginated, read-only listing capped at 500
 * rows per page and a 365-day window (spec 07-plugins/03 §usage). This module
 * owns three concerns the pure aggregator must not:
 *
 *   1. paging through the window, under a hard row budget so a heavy install
 *      cannot spin the plugin process;
 *   2. a short TTL cache, because the compact bar re-reads on every finished
 *      turn and the host has no incremental "since" cursor;
 *   3. collapsing concurrent reads, so a burst of `session:turnEnded` events
 *      produces one scan rather than one per event.
 */

/** Host page cap. Anything higher is rejected with INVALID_PARAMS. */
const PAGE_LIMIT = 500;

/** Hard ceiling on rows pulled per snapshot. */
const MAX_ROWS = 20_000;

/** The host refuses a window wider than this. */
const MAX_WINDOW_MS = 365 * 24 * 3600 * 1000;

/** Default scan window when nothing narrower is asked for. */
const DEFAULT_WINDOW_DAYS = 90;

/** A finished turn changes the totals, so the cache is deliberately short. */
const CACHE_TTL_MS = 20_000;

function nowMs() {
  return Date.now();
}

function clampWindow(fromMs, toMs) {
  const to = Number.isFinite(toMs) ? toMs : nowMs();
  const span = MAX_WINDOW_MS;
  const from = Number.isFinite(fromMs) ? fromMs : to - DEFAULT_WINDOW_DAYS * 24 * 3600 * 1000;
  // The host rejects `toMs - fromMs > 365d` outright, so a too-wide window
  // has to be narrowed by moving the *start* forward, not by letting the call
  // fail. `Math.max` is what pulls an over-wide `from` up to `to - span`.
  return { fromMs: Math.max(0, Math.max(from, to - span)), toMs: to };
}

/**
 * Walk the keyset cursor to the end of the window.
 *
 * Returns the rows plus whether the budget cut the walk short, so the UI can
 * say "at least N" instead of quietly showing a partial total as if it were
 * complete.
 */
async function fetchTurns(input) {
  const { fromMs, toMs } = clampWindow(input.fromMs, input.toMs);
  const request = { fromMs, toMs, limit: PAGE_LIMIT };
  if (input.sessionId) request.sessionId = input.sessionId;
  if (Number.isFinite(input.projectId)) request.projectId = input.projectId;

  const turns = [];
  let cursor;
  let truncated = false;

  for (;;) {
    const page = await pi.usage.listTurns(cursor ? { ...request, cursor } : request);
    const rows = Array.isArray(page?.turns) ? page.turns : [];
    for (const row of rows) {
      if (turns.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
      turns.push(row);
    }
    if (truncated) break;
    cursor = typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
    // An empty page with a cursor would loop forever; the host does not emit
    // one, but a defensive break costs nothing.
    if (!cursor || rows.length === 0) break;
  }

  return { turns, truncated, fromMs, toMs };
}

/**
 * One cached snapshot of the aggregated dashboard.
 *
 * `inFlight` collapses concurrent callers onto one scan: the host has no
 * "give me rows since X" cursor, so a second concurrent reader would repeat
 * the whole walk for a result that is a few milliseconds older.
 */
function createUsageStore(options = {}) {
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : CACHE_TTL_MS;
  const fetchImpl = options.fetch || fetchTurns;
  let cache = null;
  let inFlight = null;
  let generation = 0;

  /** Drop the cache and refuse the in-flight read's result. */
  function invalidate() {
    cache = null;
    generation += 1;
  }

  async function read(request = {}) {
    const now = nowMs();
    // A request that narrows the window is a different question than the
    // cached full scan, so it bypasses the cache in both directions: a narrow
    // hit must never be served to a broad asker.
    const cacheable = !request.projectId && !request.sessionId && !request.force;
    if (cacheable && cache && now - cache.at < ttl) return cache.value;

    // Only a request with the same shape may join an in-flight scan. A
    // project-scoped ask must never be handed the unscoped numbers, so it
    // waits for the current scan to settle and then runs its own.
    if (inFlight && cacheable) return inFlight;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // The scan we were waiting on failed; this request runs its own.
      }
    }

    const startedAt = generation;
    inFlight = (async () => {
      const settings = await pi.plugin.getSettings();
      const includeCache = settings.includeCache !== false;
      const topModels = Number.isFinite(Number(settings.topModels))
        ? Math.max(1, Math.min(50, Math.floor(Number(settings.topModels))))
        : 8;
      const scope = settings.scope === 'project' ? 'project' : 'global';
      const { aggregate, dailyPeak } = require('./aggregate.js');

      const { turns, truncated, fromMs, toMs } = await fetchImpl({
        fromMs: request.fromMs,
        toMs: request.toMs,
        projectId: request.projectId,
        sessionId: request.sessionId,
      });

      // Two label lookups, resolved together: the model catalog and the
      // project directory. Both are single host calls whose results are
      // folded into the rows below.
      const [labels, projects] = await Promise.all([modelLabels(), projectLabels()])
      const data = aggregate(turns, {
        now: toMs,
        includeCache,
        dailyDays: 30,
        topModels,
        projectId: request.projectId,
        truncated,
      });

      return {
        ...data,
        models: applyModelLabels(data.models, labels),
        projects: applyProjectLabels(data.projects, projects),
        scope,
        peak: dailyPeak(data.daily),
        window: { fromMs, toMs },
        // The compact bar needs three numbers and nothing else; a payload this
        // small means the docked view can re-read on every turn end for free.
        compact: {
          total: data.total,
          today: data.windows.today.total,
          last7: data.windows.last7.total,
          last30: data.windows.last30.total,
        },
      };
    })();

    try {
      const value = await inFlight;
      // A read that started before an invalidate() must not repopulate the
      // cache with pre-invalidation data.
      if (cacheable && startedAt === generation) cache = { at: nowMs(), value };
      return value;
    } finally {
      inFlight = null;
    }
  }

  return { read, invalidate };
}

/**
 * Friendly names for `modelId`, from the host's ready model catalog.
 *
 * `usage.read` rows carry only raw ids, so `claude-sonnet-4-5` would be all the
 * per-model table could ever show. `pi.models.list` supplies the label and the
 * user's own alias. A model no longer in the catalog — a deauth'd provider, a
 * renamed binding — keeps its raw id, and a missing grant degrades the same
 * way rather than failing the whole snapshot.
 */
async function modelLabels() {
  if (typeof pi === 'undefined' || typeof pi.models?.list !== 'function') {
    return new Map();
  }
  let rows;
  try {
    rows = await pi.models.list();
  } catch {
    // `models.list` is optional: without it the table shows raw ids.
    return new Map();
  }
  const labels = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const providerId = typeof row.providerId === 'string' ? row.providerId : null;
    const modelId = typeof row.modelId === 'string' ? row.modelId : null;
    if (!providerId || !modelId) continue;
    // An alias is the user's own name for the model, so it wins over the
    // vendor's label.
    labels.set(`${providerId}/${modelId}`, {
      label: String(row.alias || row.label || modelId),
      providerName: typeof row.providerName === 'string' ? row.providerName : providerId,
    });
  }
  return labels;
}

/** Attach a display label to each model row, leaving the raw key intact. */
function applyModelLabels(models, labels) {
  if (!labels || labels.size === 0) return models;
  return models.map((row) => {
    const hit = labels.get(row.key);
    return hit ? { ...row, label: hit.label, providerName: hit.providerName } : row;
  });
}

/**
 * Friendly names for `projectId`, from the host's project directory.
 *
 * `usage.read` rows carry only the numeric `sessions.project_id`, so without
 * this the project table can only print `项目 #1`. `desktop.invoke` with the
 * read-risk `project/list` operation is the one plugin-reachable listing of
 * durable projects, and its `id` is exactly that numeric id — so the join is a
 * plain map, not a guess.
 *
 * Every failure mode degrades to the id the caller already had: a missing
 * grant, a host without the control plane, a project deleted since its last
 * session ran.
 */
async function projectLabels() {
  if (typeof pi === 'undefined' || typeof pi.desktop?.invoke !== 'function') {
    return new Map();
  }
  let result;
  try {
    result = await pi.desktop.invoke({ operation: 'project/list' });
  } catch {
    // `desktop.control` was refused, or this host exposes no control plane.
    return new Map();
  }
  const rows = Array.isArray(result?.projects) ? result.projects : [];
  const labels = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    // The id arrives as a number from the projects table and as a string from
    // the RACP projection of the same row, so both have to key the same map.
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const path = typeof row.path === 'string' ? row.path : null;
    // A project row always has a path, so the folder name is a better label
    // than nothing even when `name` is blank.
    const basename = path ? path.split(/[\\/]/).filter(Boolean).at(-1) || null : null;
    const label = name || basename;
    if (!label) continue;
    labels.set(id, { label, path });
  }
  return labels;
}

/** Attach a display label to each project row, leaving the raw id intact. */
function applyProjectLabels(projects, labels) {
  if (!labels || labels.size === 0) return projects;
  return projects.map((row) => {
    if (row.projectId === null || row.projectId === undefined) return row;
    const hit = labels.get(row.projectId);
    return hit ? { ...row, label: hit.label, projectPath: hit.path } : row;
  });
}


module.exports = {
  CACHE_TTL_MS,
  MAX_ROWS,
  MAX_WINDOW_MS,
  PAGE_LIMIT,
  applyModelLabels,
  applyProjectLabels,
  clampWindow,
  createUsageStore,
  fetchTurns,
  modelLabels,
  projectLabels,
};
