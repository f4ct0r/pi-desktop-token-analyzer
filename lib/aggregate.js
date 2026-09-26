'use strict';

/**
 * Pure aggregation over `pi.usage.listTurns` fact rows.
 *
 * The host deliberately serves flat per-turn counters and no dashboard shape
 * (spec 07-plugins/03 §usage), so every number this plugin shows is computed
 * here. Nothing in this file touches `pi` or the DOM, which is what makes it
 * unit-testable outside the plugin host.
 *
 * A "turn" is one completed model call. Its counters are:
 *   input / output         — the two every provider reports
 *   cacheRead / cacheWrite — prompt-cache traffic, often the bulk of a long session
 *   reasoning              — thinking tokens; on the providers PI-Desktop records
 *                            this is a *subset* of `output`, not another bucket
 *
 * Because reasoning overlaps output, `total` never adds it on top. It is
 * reported as a breakdown column instead, so the headline number cannot
 * double-count a provider that folds thinking into output.
 *
 * CommonJS on purpose: the host loads `main.js` with `require`, so a required
 * sibling must not be an ES module.
 */

/** Fields summed for any bucket. `total` is derived per call, never summed. */
const COUNTERS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

function emptyCounters() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    turns: 0,
  };
}

/** A missing, negative, or non-numeric counter is a zero, never a NaN. */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Read one turn row defensively. The host guarantees the shape, but a
 * dashboard that renders `NaN` because one row lost a field is worse than one
 * that treats the missing counter as zero — the same rule the host itself
 * applies to a malformed `usage_json`.
 */
function readTurn(turn) {
  if (!turn || typeof turn !== 'object') return null;
  const endedAt = Number(turn.endedAt);
  if (!Number.isFinite(endedAt)) return null;
  const startedAt = Number(turn.startedAt);
  const projectId = turn.projectId === null || turn.projectId === undefined
    ? null
    : Number(turn.projectId);
  return {
    sessionId: typeof turn.sessionId === 'string' ? turn.sessionId : '',
    sessionTitle: typeof turn.sessionTitle === 'string' && turn.sessionTitle ? turn.sessionTitle : null,
    projectId: Number.isFinite(projectId) ? projectId : null,
    providerId: typeof turn.providerId === 'string' && turn.providerId ? turn.providerId : null,
    modelId: typeof turn.modelId === 'string' && turn.modelId ? turn.modelId : null,
    startedAt: Number.isFinite(startedAt) ? startedAt : endedAt,
    endedAt,
    input: toCount(turn.inputTokens),
    output: toCount(turn.outputTokens),
    cacheRead: toCount(turn.cacheReadTokens),
    cacheWrite: toCount(turn.cacheWriteTokens),
    reasoning: toCount(turn.reasoningTokens),
  };
}

/**
 * The headline number for a bucket.
 *
 * `includeCache` decides whether prompt-cache traffic counts. It defaults to
 * true because "how many tokens did I spend" means the whole bill, and a long
 * session's cache reads dwarf its fresh input. Turning it off leaves
 * input + output, the number a per-request price is quoted against.
 */
function totalOf(bucket, includeCache) {
  const base = bucket.input + bucket.output;
  return includeCache ? base + bucket.cacheRead + bucket.cacheWrite : base;
}

function addTurn(bucket, turn) {
  for (const key of COUNTERS) bucket[key] += turn[key];
  bucket.turns += 1;
  return bucket;
}

/** Local-time `YYYY-MM-DD`. Usage is bucketed by the user's day, not by UTC. */
function dayKey(epochMs) {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Local midnight of the day `days` before the day containing `nowMs`. */
function startOfDayBefore(nowMs, days) {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

/** `providerId/modelId`, with an explicit unknown bucket rather than a blank. */
function modelKeyOf(turn) {
  if (!turn.providerId && !turn.modelId) return 'unknown';
  return `${turn.providerId ?? 'unknown'}/${turn.modelId ?? 'unknown'}`;
}

/** Project rows keyed by the numeric id the host filters on. */
function projectBucket(map, turn) {
  const key = turn.projectId === null ? 'unbound' : String(turn.projectId);
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { projectId: turn.projectId, ...emptyCounters() };
    map.set(key, bucket);
  }
  addTurn(bucket, turn);
  return bucket;
}

/**
 * Aggregate raw host rows into everything the dashboard renders.
 *
 * @param {unknown[]} rawTurns rows straight from `pi.usage.listTurns`
 * @param {object} [options]
 * @param {number} [options.now] epoch ms treated as "now"; injected by tests
 * @param {boolean} [options.includeCache] count cacheRead + cacheWrite in `total`
 * @param {number} [options.dailyDays] length of the daily series, inclusive of today
 * @param {number} [options.topModels] cap on the per-model and per-session rows
 * @param {number|null} [options.projectId] restrict to one numeric project id
 * @param {boolean} [options.truncated] the fetch hit its row budget
 */
function aggregate(rawTurns, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const includeCache = options.includeCache !== false;
  const dailyDays = Math.max(1, Math.floor(options.dailyDays ?? 30));
  const topModels = Math.max(1, Math.floor(options.topModels ?? 8));
  const projectFilter = Number.isFinite(options.projectId) ? Number(options.projectId) : null;

  const turns = [];
  for (const raw of Array.isArray(rawTurns) ? rawTurns : []) {
    const turn = readTurn(raw);
    if (!turn) continue;
    // A `projectId: null` row belongs to a session bound to no project, so it
    // counts globally and in no single project's view. A project filter drops
    // it rather than silently folding an unrelated session into the number.
    if (projectFilter !== null && turn.projectId !== projectFilter) continue;
    turns.push(turn);
  }

  const overall = emptyCounters();
  const windows = { today: emptyCounters(), last7: emptyCounters(), last30: emptyCounters() };
  const todayStart = startOfDayBefore(now, 0);
  const last7Start = startOfDayBefore(now, 6);
  const last30Start = startOfDayBefore(now, 29);
  const dailyFrom = startOfDayBefore(now, dailyDays - 1);
  const byDay = new Map();
  const modelBuckets = new Map();
  const projectBuckets = new Map();
  const sessionBuckets = new Map();

  for (const turn of turns) {
    addTurn(overall, turn);
    if (turn.endedAt >= todayStart) addTurn(windows.today, turn);
    if (turn.endedAt >= last7Start) addTurn(windows.last7, turn);
    if (turn.endedAt >= last30Start) addTurn(windows.last30, turn);
    if (turn.endedAt >= dailyFrom) {
      const key = dayKey(turn.endedAt);
      let bucket = byDay.get(key);
      if (!bucket) {
        bucket = { date: key, ...emptyCounters() };
        byDay.set(key, bucket);
      }
      addTurn(bucket, turn);
    }

    const modelKey = modelKeyOf(turn);
    let modelBucket = modelBuckets.get(modelKey);
    if (!modelBucket) {
      modelBucket = {
        key: modelKey,
        providerId: turn.providerId,
        modelId: turn.modelId,
        ...emptyCounters(),
      };
      modelBuckets.set(modelKey, modelBucket);
    }
    addTurn(modelBucket, turn);

    projectBucket(projectBuckets, turn);

    if (turn.sessionId) {
      let sessionBucket = sessionBuckets.get(turn.sessionId);
      if (!sessionBucket) {
        sessionBucket = {
          sessionId: turn.sessionId,
          title: turn.sessionTitle,
          projectId: turn.projectId,
          lastEndedAt: 0,
          ...emptyCounters(),
        };
        sessionBuckets.set(turn.sessionId, sessionBucket);
      }
      addTurn(sessionBucket, turn);
      if (turn.sessionTitle && !sessionBucket.title) sessionBucket.title = turn.sessionTitle;
      if (turn.endedAt > sessionBucket.lastEndedAt) sessionBucket.lastEndedAt = turn.endedAt;
    }
  }

  // A dense series: a day with no turns is a real zero, not a gap the chart
  // would otherwise have to interpolate across.
  const daily = [];
  for (let offset = dailyDays - 1; offset >= 0; offset -= 1) {
    const key = dayKey(startOfDayBefore(now, offset));
    const bucket = byDay.get(key) ?? { date: key, ...emptyCounters() };
    daily.push({ ...bucket, total: totalOf(bucket, includeCache) });
  }

  const grandTotal = totalOf(overall, includeCache);
  const withShare = (row) => ({
    ...row,
    total: totalOf(row, includeCache),
    share: grandTotal > 0 ? totalOf(row, includeCache) / grandTotal : 0,
  });

  const allModels = [...modelBuckets.values()]
    .map(withShare)
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  const models = allModels.slice(0, topModels);

  // "Others" keeps the share column honest: the percentages have to add up to
  // 100% of the total, not 100% of the rows that happened to fit.
  const overflow = allModels.slice(topModels);
  const modelsRest = overflow.length
    ? withShare({
      ...overflow.reduce((acc, row) => {
        for (const key of COUNTERS) acc[key] += row[key];
        acc.turns += row.turns;
        return acc;
      }, emptyCounters()),
      key: `__rest__:${overflow.length}`,
      hiddenModels: overflow.length,
    })
    : null;

  return {
    generatedAt: now,
    includeCache,
    counts: {
      turns: overall.turns,
      sessions: sessionBuckets.size,
      models: allModels.length,
      truncated: options.truncated === true,
    },
    total: grandTotal,
    breakdown: {
      input: overall.input,
      output: overall.output,
      cacheRead: overall.cacheRead,
      cacheWrite: overall.cacheWrite,
      reasoning: overall.reasoning,
    },
    windows: {
      today: withShare({ ...windows.today }),
      last7: withShare({ ...windows.last7 }),
      last30: withShare({ ...windows.last30 }),
    },
    daily,
    models,
    modelsRest,
    projects: [...projectBuckets.values()]
      .map(withShare)
      .sort((a, b) => b.total - a.total),
    sessions: [...sessionBuckets.values()]
      .map((bucket) => ({ ...withShare(bucket), title: bucket.title || bucket.sessionId }))
      .sort((a, b) => b.total - a.total || b.lastEndedAt - a.lastEndedAt)
      .slice(0, topModels),
  };
}

/**
 * Peak of the daily series, used to scale the bar chart. Zero for an empty
 * window, so an unused install renders an empty grid rather than dividing by
 * zero.
 */
function dailyPeak(daily) {
  let peak = 0;
  for (const row of Array.isArray(daily) ? daily : []) {
    const total = Number(row && row.total);
    if (Number.isFinite(total) && total > peak) peak = total;
  }
  return peak;
}

module.exports = {
  COUNTERS,
  aggregate,
  dailyPeak,
  dayKey,
  modelKeyOf,
  startOfDayBefore,
  totalOf,
};
