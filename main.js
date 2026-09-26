'use strict';

/**
 * Token Analyzer — plugin runtime entry.
 *
 * The host injects the global `pi` API; this module never imports it. Two
 * responsibilities:
 *
 *   1. commands, so the dashboard is reachable from the command palette;
 *   2. `onPanelInvoke`, the bridge the docked work-panel view calls for data.
 *      A view page has no `pi` of its own (spec 07-plugins/03 §6), and the
 *      host's fixed panel channel list does not include `usage.*`, so the view
 *      asks this process for usage and gets back finished aggregates. That
 *      keeps the raw per-turn rows inside the plugin process instead of
 *      shipping thousands of them to the page on every refresh.
 */

const { createUsageStore } = require('./lib/usage-store.js');

/** Process-lifetime singleton: the cache and the in-flight collapse live here. */
const store = createUsageStore();

/**
 * Named so `onUnload` can detach it: `pi.events.on` returns nothing, so the
 * only way off an event is `pi.events.off` with the same function reference.
 */
let onTurnEnded = null;

/** Turn-end debounce. One agent turn can finish several sub-turns in a row. */
const REFRESH_DEBOUNCE_MS = 1_500;
let refreshTimer = null;

function apiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Numeric project filter from a panel payload, or null for "everything". */
function readProjectId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.projectId === null || payload.projectId === undefined || payload.projectId === 'all') {
    return null;
  }
  const value = Number(payload.projectId);
  if (!Number.isFinite(value)) {
    throw apiError('INVALID_ARGUMENT', 'projectId must be a number, "all", or null');
  }
  return value;
}

async function onLoad() {
  await pi.commands.register({
    id: 'token-usage.open',
    title: 'Token Usage: Open Dashboard',
    keywords: ['token', 'usage', 'tokens', '用量', '统计', 'dashboard'],
    run: async () => {
      // A view is opened from the work panel's launcher; a command cannot
      // address one directly, so the panel is the reachable surface here and
      // the toast points at the docked tab.
      await pi.ui.showToast(
        'Token Usage: 在右侧面板的启动器中打开「Token 用量」',
        'info',
      );
    },
  });

  await pi.commands.register({
    id: 'token-usage.refresh',
    title: 'Token Usage: Refresh',
    keywords: ['token', 'usage', 'refresh', '刷新'],
    run: async () => {
      store.invalidate();
      const data = await store.read({ force: true });
      await pi.ui.showToast(`Token Usage: 已刷新，共 ${data.total} tokens`, 'info');
    },
  });

  // A finished turn is the only host signal that the numbers moved. The view
  // also receives this event for its own bar, but the cache lives here, so the
  // invalidation has to happen in this process too.
  onTurnEnded = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      store.invalidate();
    }, REFRESH_DEBOUNCE_MS);
  };
  pi.events.on('session:turnEnded', onTurnEnded);
}

async function onUnload() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (onTurnEnded) {
    pi.events.off('session:turnEnded', onTurnEnded);
    onTurnEnded = null;
  }
  store.invalidate();
  await pi.commands.unregister('token-usage.open');
  await pi.commands.unregister('token-usage.refresh');
}

/**
 * Panel/view -> main data bridge.
 *
 * The host forwards any channel it does not implement itself to this hook
 * (spec 07-plugins/03 §6), so `token-usage.*` needs no manifest declaration
 * beyond the `usage.read` grant that `pi.usage.listTurns` itself enforces.
 */
async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case 'token-usage.summary': {
      const data = await store.read({
        force: payload?.force === true,
        projectId: readProjectId(payload),
      });
      return data;
    }
    case 'token-usage.settings': {
      const settings = await pi.plugin.getSettings();
      if (payload && typeof payload === 'object' && Object.keys(payload).length > 0) {
        // `plugin.setSettings` is not reachable from a panel, so the view asks
        // this process to persist on its behalf.
        await pi.plugin.setSettings(payload);
        store.invalidate();
        return pi.plugin.getSettings();
      }
      return settings;
    }
    case 'token-usage.refresh': {
      store.invalidate();
      return store.read({ force: true });
    }
    default:
      throw apiError('UNSUPPORTED', `unknown channel: ${channel}`);
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
};
