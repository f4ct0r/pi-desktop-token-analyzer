'use strict';

/**
 * Tests for the pure aggregator.
 *
 * The host serves flat per-turn rows and no dashboard shape, so this is where
 * a wrong total would actually originate: window boundaries, the cache/reasoning
 * double-count, the daily series' density, and the share column's arithmetic.
 *
 * Run with: node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { aggregate, dailyPeak, dayKey, totalOf } = require('../lib/aggregate.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Local midnight `days` before the day containing `now`. */
function midnight(now, days = 0) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

function turn(overrides = {}) {
  return {
    turnId: overrides.turnId ?? `t-${Math.random()}`,
    sessionId: 's1',
    sessionTitle: 'Session',
    projectId: null,
    providerId: 'anthropic',
    modelId: 'claude',
    startedAt: 0,
    endedAt: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  };
}

test('total counts input, output, and cache by default', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [turn({ endedAt: now, inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 25 })],
    { now },
  );
  assert.equal(data.total, 1075);
  assert.equal(data.breakdown.reasoning, 0);
});

test('excluding cache leaves input + output only', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [turn({ endedAt: now, inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 25 })],
    { now, includeCache: false },
  );
  assert.equal(data.total, 150);
});

test('reasoning is never added on top of output', () => {
  // Reasoning is a subset of output on the providers PI-Desktop records, so a
  // total that included it would double-count every thinking turn.
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [turn({ endedAt: now, inputTokens: 10, outputTokens: 200, reasoningTokens: 150 })],
    { now },
  );
  assert.equal(data.total, 210);
  assert.equal(data.breakdown.reasoning, 150);
});

test('today counts only the current local day', () => {
  const today = midnight(Date.now(), 0) + 10 * HOUR;
  const yesterday = midnight(Date.now(), 1) + 10 * HOUR;
  const data = aggregate(
    [
      turn({ turnId: 'a', endedAt: today, inputTokens: 100, outputTokens: 0 }),
      turn({ turnId: 'b', endedAt: yesterday, inputTokens: 500, outputTokens: 0 }),
    ],
    { now: today },
  );
  assert.equal(data.windows.today.total, 100);
  assert.equal(data.windows.last7.total, 600);
  assert.equal(data.total, 600);
});

test('the 7-day window is seven local days including today', () => {
  const today = midnight(Date.now(), 0) + 10 * HOUR;
  // Day 6 back is inside a 7-day window; day 7 back is the first day outside.
  const inside = midnight(Date.now(), 6) + 10 * HOUR;
  const outside = midnight(Date.now(), 7) + 10 * HOUR;
  const data = aggregate(
    [
      turn({ turnId: 'a', endedAt: inside, inputTokens: 7 }),
      turn({ turnId: 'b', endedAt: outside, inputTokens: 999 }),
    ],
    { now: today },
  );
  assert.equal(data.windows.last7.total, 7);
  assert.equal(data.windows.last30.total, 1006);
});

test('the 30-day window is thirty local days including today', () => {
  const today = midnight(Date.now(), 0) + 10 * HOUR;
  const inside = midnight(Date.now(), 29) + 10 * HOUR;
  const outside = midnight(Date.now(), 30) + 10 * HOUR;
  const data = aggregate(
    [
      turn({ turnId: 'a', endedAt: inside, inputTokens: 5 }),
      turn({ turnId: 'b', endedAt: outside, inputTokens: 999 }),
    ],
    { now: today },
  );
  assert.equal(data.windows.last30.total, 5);
  // The grand total covers the whole scanned window, not just 30 days.
  assert.equal(data.total, 1004);
});

test('the daily series is dense and ends on today', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate([turn({ endedAt: now, inputTokens: 42 })], { now, dailyDays: 30 });
  assert.equal(data.daily.length, 30);
  assert.equal(data.daily.at(-1).date, dayKey(now));
  assert.equal(data.daily.at(-1).total, 42);
  assert.equal(data.daily.at(-2).total, 0);
  assert.equal(data.daily[0].total, 0);
});

test('dailyPeak scales the chart and tolerates an empty window', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [
      turn({ turnId: 'a', endedAt: now, inputTokens: 10 }),
      turn({ turnId: 'b', endedAt: now, inputTokens: 90 }),
    ],
    { now },
  );
  assert.equal(dailyPeak(data.daily), 100);
  assert.equal(dailyPeak([]), 0);
  assert.equal(dailyPeak(null), 0);
});

test('per-model rows are ranked and their shares sum with the overflow row', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [
      turn({ turnId: 'a', endedAt: now, modelId: 'small', inputTokens: 10 }),
      turn({ turnId: 'b', endedAt: now, modelId: 'big', inputTokens: 60 }),
      turn({ turnId: 'c', endedAt: now, modelId: 'mid', inputTokens: 30 }),
    ],
    { now, topModels: 2 },
  );
  assert.deepEqual(data.models.map((row) => row.modelId), ['big', 'mid']);
  // The hidden third model is folded into one row so the column still totals.
  assert.equal(data.modelsRest.hiddenModels, 1);
  assert.equal(data.modelsRest.total, 10);
  const shareSum = data.models.reduce((sum, row) => sum + row.share, 0) + data.modelsRest.share;
  assert.ok(Math.abs(shareSum - 1) < 1e-9, `shares summed to ${shareSum}`);
  assert.equal(data.counts.models, 3);
});

test('a model with neither provider nor model still gets a bucket', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [turn({ turnId: 'a', endedAt: now, providerId: null, modelId: null, inputTokens: 5 })],
    { now },
  );
  assert.equal(data.models.length, 1);
  assert.equal(data.models[0].key, 'unknown');
});

test('a project filter keeps only that project and drops unbound rows', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [
      turn({ turnId: 'a', endedAt: now, projectId: 1, inputTokens: 10 }),
      turn({ turnId: 'b', endedAt: now, projectId: 2, inputTokens: 20 }),
      turn({ turnId: 'c', endedAt: now, projectId: null, inputTokens: 40 }),
    ],
    { now, projectId: 1 },
  );
  assert.equal(data.total, 10);
  assert.equal(data.projects.length, 1);
  assert.equal(data.projects[0].projectId, 1);
});

test('unbound sessions are grouped separately from real projects', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [
      turn({ turnId: 'a', endedAt: now, projectId: 1, inputTokens: 10 }),
      turn({ turnId: 'b', endedAt: now, projectId: null, inputTokens: 5 }),
    ],
    { now },
  );
  const ids = data.projects.map((row) => row.projectId);
  assert.deepEqual(ids, [1, null]);
});

test('malformed rows are skipped rather than producing NaN totals', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [
      turn({ turnId: 'a', endedAt: now, inputTokens: 10 }),
      null,
      'nonsense',
      { turnId: 'b' },
      turn({ turnId: 'c', endedAt: now, inputTokens: 'oops', outputTokens: null }),
    ],
    { now },
  );
  assert.equal(data.counts.turns, 2);
  assert.equal(data.total, 10);
  assert.ok(Number.isFinite(data.total));
});

test('negative counters are treated as zero', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [turn({ turnId: 'a', endedAt: now, inputTokens: -5, outputTokens: 7 })],
    { now },
  );
  assert.equal(data.total, 7);
});

test('an empty window aggregates to zeros without dividing by zero', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate([], { now });
  assert.equal(data.total, 0);
  assert.equal(data.daily.length, 30);
  assert.equal(data.models.length, 0);
  assert.equal(data.modelsRest, null);
  assert.equal(data.sessions.length, 0);
  for (const row of data.projects) assert.equal(row.share, 0);
});

test('non-array input is treated as no data', () => {
  const data = aggregate(null, { now: Date.now() });
  assert.equal(data.total, 0);
  assert.equal(data.counts.turns, 0);
});

test('sessions rank by total and carry a readable title', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [
      turn({ turnId: 'a', sessionId: 's-small', sessionTitle: 'Small', endedAt: now, inputTokens: 5 }),
      turn({ turnId: 'b', sessionId: 's-big', sessionTitle: 'Big', endedAt: now, inputTokens: 500 }),
      turn({ turnId: 'c', sessionId: 's-untitled', sessionTitle: null, endedAt: now, inputTokens: 1 }),
    ],
    { now, topModels: 2 },
  );
  assert.equal(data.sessions.length, 2);
  assert.equal(data.sessions[0].title, 'Big');
  assert.equal(data.counts.sessions, 3);
});

test('a session picks up a title from a later turn that has one', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate(
    [
      turn({ turnId: 'a', sessionId: 's', sessionTitle: null, endedAt: now, inputTokens: 1 }),
      turn({ turnId: 'b', sessionId: 's', sessionTitle: 'Named', endedAt: now, inputTokens: 1 }),
    ],
    { now },
  );
  assert.equal(data.sessions[0].title, 'Named');
});

test('truncation is reported so a partial scan is never shown as complete', () => {
  const now = midnight(Date.now(), 0) + 10 * HOUR;
  const data = aggregate([turn({ endedAt: now, inputTokens: 10 })], { now, truncated: true });
  assert.equal(data.counts.truncated, true);
  const whole = aggregate([turn({ endedAt: now, inputTokens: 10 })], { now });
  assert.equal(whole.counts.truncated, false);
});

test('totalOf is the single definition of a total', () => {
  const bucket = { input: 1, output: 2, cacheRead: 4, cacheWrite: 8, reasoning: 16 };
  assert.equal(totalOf(bucket, true), 15);
  assert.equal(totalOf(bucket, false), 3);
});
