'use strict';

/**
 * Token Analyzer view script.
 *
 * A plugin page has no `pi` object: it reaches the host only through
 * `window.pluginBridge` (spec 07-plugins/03 §6). The fixed channel list has no
 * `usage.*` entry, so this page asks the plugin process over the plugin's own
 * `token-usage.*` channels and receives finished aggregates. The raw per-turn
 * rows therefore never cross into the page.
 *
 * Two states share one column:
 *   compact  — a persistent strip with today / 7d / 30d / total
 *   expanded — the full dashboard above the same strip
 *
 * The mode is remembered in `localStorage`, which is per-plugin partitioned, so
 * the choice follows this plugin and nothing else.
 */

const MODE_KEY = 'dev.tokenanalyzer.mode';

/** How long after a turn ends before the strip re-reads. */
const TURN_REFRESH_DEBOUNCE_MS = 1_200;

const el = {
  body: document.body,
  dashboard: document.getElementById('dashboard'),
  compact: document.getElementById('compact'),
  compactScope: document.getElementById('compact-scope'),
  refresh: document.getElementById('refresh'),
  collapse: document.getElementById('collapse'),
  dashSub: document.getElementById('dash-sub'),
  statRow: document.getElementById('stat-row'),
  chart: document.getElementById('chart'),
  dailyNote: document.getElementById('daily-note'),
  modelsBody: document.getElementById('models-body'),
  modelsNote: document.getElementById('models-note'),
  projectsBody: document.getElementById('projects-body'),
  projectsNote: document.getElementById('projects-note'),
  sessionsBody: document.getElementById('sessions-body'),
  footnote: document.getElementById('footnote'),
  status: document.getElementById('status'),
  cToday: document.getElementById('c-today'),
  c7: document.getElementById('c-7'),
  c30: document.getElementById('c-30'),
  cTotal: document.getElementById('c-total'),
};

/** Latest snapshot, kept so a mode toggle redraws without a re-read. */
let snapshot = null;
let loadToken = 0;
let turnTimer = null;

// --- formatting ---------------------------------------------------------

const UNITS = [
  { limit: 1e9, suffix: 'B' },
  { limit: 1e6, suffix: 'M' },
  { limit: 1e3, suffix: 'K' },
];

/**
 * Compact token counts. A dashboard column is too narrow for grouped digits,
 * and the compact strip has room for four of them at most.
 */
function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  for (const { limit, suffix } of UNITS) {
    if (abs >= limit) {
      const scaled = n / limit;
      // One decimal below 10 keeps "1.2M" readable; above that the decimal is
      // noise on a column this narrow.
      return `${scaled >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${suffix}`;
    }
  }
  return String(Math.round(n));
}

function formatFull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';
}

function formatPercent(share) {
  const n = Number(share);
  if (!Number.isFinite(n) || n <= 0) return '0%';
  if (n < 0.001) return '<0.1%';
  return `${Math.round(n * 1000) / 10}%`;
}

function formatDate(iso) {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatTime(ms) {
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// --- DOM helpers --------------------------------------------------------

function text(node, value) {
  if (node) node.textContent = value;
}

function cell(value, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = value;
  return td;
}

function emptyRow(tbody, columns, message) {
  const tr = document.createElement('tr');
  tr.className = 'empty-row';
  const td = document.createElement('td');
  td.colSpan = columns;
  td.textContent = message;
  tr.appendChild(td);
  tbody.replaceChildren(tr);
}

// --- tooltip -------------------------------------------------------------

/**
 * One floating tooltip for the whole page.
 *
 * A native `title` is too coarse for what this dashboard has to say: a daily
 * bar carries a breakdown, and an abbreviated `12.3M` has to be able to answer
 * "exactly how much". One shared node also keeps hover cheap — the content is
 * built once per anchor and reused while the pointer stays inside it.
 *
 * Fixed positioning means the coordinates are viewport-relative, so no scroll
 * or ancestor-offset math is needed; the clamp is what keeps it inside a narrow
 * docked panel.
 */
let tipNode = null;
let tipOwner = null;
let activeBar = null;

function tipElement() {
  if (tipNode) return tipNode;
  tipNode = document.createElement('div');
  tipNode.className = 'tip';
  tipNode.setAttribute('role', 'tooltip');
  tipNode.hidden = true;
  document.body.appendChild(tipNode);
  return tipNode;
}

/**
 * Build tooltip rows from `{head}` captions and `{k, v}` pairs. Text is
 * assigned, never interpolated into markup, so a model or session title can
 * never become HTML here.
 */
function fillTip(node, spec) {
  node.replaceChildren(
    ...spec.map((entry) => {
      const row = document.createElement('div');
      if (entry.head) {
        row.className = 'tip-h';
        row.textContent = entry.head;
        return row;
      }
      row.className = 'tip-r';
      const k = document.createElement('span');
      k.className = 'tip-k';
      k.textContent = entry.k;
      const v = document.createElement('span');
      v.className = 'tip-v';
      v.textContent = entry.v;
      row.append(k, v);
      return row;
    }),
  );
}

function placeTip(node, anchor) {
  const anchorBox = anchor.getBoundingClientRect();
  const tipBox = node.getBoundingClientRect();
  const margin = 6;
  const gap = 8;
  let left = anchorBox.left + anchorBox.width / 2 - tipBox.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tipBox.width - margin));
  // Above the anchor when there is room, below it when the anchor sits near the
  // top of the viewport, so the tooltip is never clipped away.
  let top = anchorBox.top - tipBox.height - gap;
  if (top < margin) top = anchorBox.bottom + gap;
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function showTip(anchor, spec) {
  if (!anchor || !spec) return;
  const node = tipElement();
  if (tipOwner !== anchor) {
    fillTip(node, spec);
    tipOwner = anchor;
  }
  node.hidden = false;
  placeTip(node, anchor);
}

function hideTip(anchor) {
  if (anchor && tipOwner !== anchor) return;
  if (tipNode) tipNode.hidden = true;
  tipOwner = null;
}

/** Attach tooltip rows to an element. */
function withTip(anchor, spec) {
  anchor.addEventListener('mouseenter', () => showTip(anchor, spec));
  anchor.addEventListener('mouseleave', () => hideTip(anchor));
  return anchor;
}

/** Highlight the bar under the pointer, and only ever one of them. */
function setActiveBar(bar) {
  if (activeBar === bar) return;
  if (activeBar) activeBar.classList.remove('is-active');
  activeBar = bar;
  if (bar) bar.classList.add('is-active');
}

/** What one day of the chart says: the total, then where it came from. */
function dayTipSpec(row) {
  const spec = [
    { head: row.date },
    { k: '总用量', v: `${formatFull(row.total)} tokens` },
    { k: '输入', v: formatFull(row.input) },
    { k: '输出', v: formatFull(row.output) },
    { k: '缓存', v: formatFull(row.cacheRead + row.cacheWrite) },
  ];
  // Reasoning overlaps output, so it stays a note and never a column.
  if (row.reasoning > 0) spec.push({ k: '其中推理', v: formatFull(row.reasoning) });
  spec.push({ k: '轮次', v: formatFull(row.turns) });
  return spec;
}

/**
 * A token cell: an abbreviated number with the exact one in the tooltip.
 *
 * A usage column only has room for `12.3M`; the exact figure is what anyone
 * comparing two providers actually wants, so it stays one hover away. The
 * `aria-label` carries the same text, since assistive tech would otherwise
 * read only the abbreviation.
 */
function tokenCell(value, label = '总用量', className = 'col-num') {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = formatTokens(value);
  const exact = `${formatFull(value)} tokens`;
  td.setAttribute('aria-label', `${label} ${exact}`);
  return withTip(td, [{ k: label, v: exact }]);
}

// --- DOM helpers --------------------------------------------------------
/** A share cell: a number plus a proportional bar, right-aligned together. */
function shareCell(share) {
  const td = document.createElement('td');
  td.className = 'col-num';
  const wrap = document.createElement('span');
  wrap.className = 'share';
  const bar = document.createElement('span');
  bar.className = 'share-bar';
  const fill = document.createElement('span');
  fill.className = 'share-fill';
  const pct = Math.max(0, Math.min(1, Number(share) || 0));
  fill.style.width = `${pct * 100}%`;
  bar.appendChild(fill);
  const label = document.createElement('span');
  label.textContent = formatPercent(share);
  wrap.append(bar, label);
  td.appendChild(wrap);
  return td;
}

function setStatus(message, isError) {
  if (!el.status) return;
  if (!message) {
    el.status.hidden = true;
    el.status.textContent = '';
    el.status.classList.remove('is-error');
    return;
  }
  el.status.hidden = false;
  el.status.textContent = message;
  el.status.classList.toggle('is-error', isError === true);
}

// --- rendering ----------------------------------------------------------

function renderCompact(data) {
  const compact = data.compact ?? {};
  text(el.cToday, formatTokens(compact.today));
  text(el.c7, formatTokens(compact.last7));
  text(el.c30, formatTokens(compact.last30));
  text(el.cTotal, formatTokens(data.total));
  const truncated = data.counts?.truncated === true;
  text(
    el.compactScope,
    truncated ? `${data.counts.turns}+ 轮次` : `${data.counts.turns} 轮次`,
  );
}

function renderStats(data) {
  const windows = data.windows ?? {};
  const tiles = [
    { key: '今日', value: windows.today?.total, row: windows.today },
    { key: '近 7 天', value: windows.last7?.total, row: windows.last7 },
    { key: '近 30 天', value: windows.last30?.total, row: windows.last30 },
    { key: '总计', value: data.total, row: { turns: data.counts?.turns } },
  ];
  const nodes = tiles.map((tile) => {
    const box = document.createElement('div');
    box.className = 'stat';
    const k = document.createElement('span');
    k.className = 'stat-k';
    k.textContent = tile.key;
    const v = document.createElement('span');
    v.className = 'stat-v';
    v.textContent = formatTokens(tile.value);
    const s = document.createElement('span');
    s.className = 'stat-sub';
    s.textContent = `${formatTokens(tile.row?.turns)} 轮次`;
    box.append(k, v, s);
    return box;
  });
  el.statRow.replaceChildren(...nodes);
}

function renderChart(data) {
  const daily = Array.isArray(data.daily) ? data.daily : [];
  const peak = Number(data.peak) || 0;
  if (daily.length === 0 || peak <= 0) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = '暂无数据';
    el.chart.replaceChildren(empty);
    text(el.dailyNote, '');
    setActiveBar(null);
    hideTip();
    return;
  }
  // The tooltip rows are built once per render, not once per mousemove.
  const specs = daily.map(dayTipSpec);
  const bars = daily.map((row, index) => {
    const bar = document.createElement('div');
    const total = Number(row.total) || 0;
    bar.className = total > 0 ? 'bar' : 'bar is-zero';
    bar.dataset.index = String(index);
    // The bar element spans the full column and only the inner fill carries
    // the value, so a 2%-tall day is as easy to hover as the peak. A floor of
    // 2% keeps a real-but-tiny day visible next to a huge one.
    const ratio = total > 0 ? Math.max(0.02, total / peak) : 0.02;
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.height = `${ratio * 100}%`;
    bar.appendChild(fill);
    return bar;
  });
  el.chart.replaceChildren(...bars);
  // One delegated listener pair for the whole chart: 30 pairs of listeners
  // would rebuild the same tooltip 30 times over a full sweep of the bars.
  el.chart.onmousemove = (event) => {
    const bar = event.target.closest?.('.bar');
    if (!bar) return;
    setActiveBar(bar);
    showTip(bar, specs[Number(bar.dataset.index)]);
  };
  el.chart.onmouseleave = () => {
    setActiveBar(null);
    hideTip();
  };
  const first = daily[0];
  const last = daily[daily.length - 1];
  text(el.dailyNote, `${formatDate(first.date)} – ${formatDate(last.date)} · 峰值 ${formatTokens(peak)}`);
}

function renderModels(data) {
  const rows = Array.isArray(data.models) ? [...data.models] : [];
  if (data.modelsRest) rows.push(data.modelsRest);
  if (rows.length === 0) {
    emptyRow(el.modelsBody, 6, '暂无数据');
    text(el.modelsNote, '');
  }
  const body = rows.map((row) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.className = 'col-name';
    const label = document.createElement('span');
    label.className = 'row-name';
    // A resolved catalog label is friendlier than the raw id, so it wins; the
    // raw key stays in the tooltip so an unfamiliar name is still traceable.
    label.textContent = row.label || row.modelId || row.providerId || '未知模型';
    label.title = row.label ? `${row.label} (${row.key})` : row.key;
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    const isRest = typeof row.key === 'string' && row.key.startsWith('__rest__:');
    sub.textContent = isRest
      ? `其余 ${row.hiddenModels} 个模型`
      : `${row.providerName || row.providerId || '—'} · ${formatTokens(row.turns)} 轮次`;
    name.append(label, sub);
    tr.append(
      name,
      tokenCell(row.total, '总用量'),
      tokenCell(row.input, '输入'),
      tokenCell(row.output, '输出'),
      tokenCell(row.cacheRead + row.cacheWrite, '缓存'),
      shareCell(row.share),
    );
    return tr;
  });
  el.modelsBody.replaceChildren(...body);
  text(el.modelsNote, `共 ${data.counts?.models ?? rows.length} 个模型`);
}

function renderProjects(data) {
  const rows = Array.isArray(data.projects) ? data.projects : [];
  if (rows.length === 0) {
    emptyRow(el.projectsBody, 4, '暂无数据');
    text(el.projectsNote, '');
    return;
  }
  const body = rows.map((row) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.className = 'col-name';
    const label = document.createElement('span');
    label.className = 'row-name';
    // The store resolves `projectId` to a project name when the
    // `project/list` grant is available; a deleted project keeps the id.
    label.textContent = row.projectId === null
      ? '未绑定项目'
      : row.label || `项目 #${row.projectId}`;
    if (row.projectPath) label.title = row.projectPath;
    name.append(label);
    tr.append(
      name,
      tokenCell(row.total, '总用量'),
      cell(formatFull(row.turns), 'col-num'),
      shareCell(row.share),
    );
    return tr;
  });
  el.projectsBody.replaceChildren(...body);
  text(el.projectsNote, `${rows.length} 个`);
}

function renderSessions(data) {
  const rows = Array.isArray(data.sessions) ? data.sessions : [];
  if (rows.length === 0) {
    emptyRow(el.sessionsBody, 3, '暂无数据');
    return;
  }
  const body = rows.map((row) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.className = 'col-name';
    const label = document.createElement('span');
    label.className = 'row-name';
    label.textContent = row.title;
    label.title = row.title;
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent = row.lastEndedAt ? `最近 ${formatTime(row.lastEndedAt)}` : '';
    name.append(label, sub);
    tr.append(name, tokenCell(row.total, '总用量'), cell(formatFull(row.turns), 'col-num'));
    return tr;
  });
  el.sessionsBody.replaceChildren(...body);
}

function renderFootnote(data) {
  const parts = [];
  parts.push(
    data.includeCache
      ? '总用量 = 输入 + 输出 + 缓存读 + 缓存写'
      : '总用量 = 输入 + 输出（不含缓存）',
  );
  // Reasoning is a subset of output on the providers PI-Desktop records, so it
  // is shown as a note and never added into the total.
  if (data.breakdown?.reasoning > 0) {
    parts.push(`其中推理 token ${formatFull(data.breakdown.reasoning)}（已包含在输出中）`);
  }
  if (data.counts?.truncated) {
    parts.push('数据量超过单次读取上限，当前为部分统计');
  }
  text(el.footnote, parts.join(' · '));
}

function render(data) {
  snapshot = data;
  renderCompact(data);
  text(el.dashSub, `${formatFull(data.total)} tokens · ${data.counts.turns} 轮次 · ${data.counts.sessions} 个会话`);
  renderStats(data);
  renderChart(data);
  renderModels(data);
  renderProjects(data);
  renderSessions(data);
  renderFootnote(data);
}

// --- mode ----------------------------------------------------------------

function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'expanded' ? 'expanded' : 'compact';
  } catch {
    return 'compact';
  }
}

function applyMode(mode) {
  const expanded = mode === 'expanded';
  el.body.dataset.mode = expanded ? 'expanded' : 'compact';
  el.dashboard.hidden = !expanded;
  el.compact.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  try {
    localStorage.setItem(MODE_KEY, expanded ? 'expanded' : 'compact');
  } catch {
    // A partitioned session with storage disabled still works; it just forgets.
  }
  // The strip is a button whose label is its content, so the accessible name
  // has to say what the click will do rather than repeat the numbers.
  el.compact.setAttribute(
    'aria-label',
    expanded ? '收起 Token 用量 dashboard' : '展开 Token 用量 dashboard',
  );
}

function toggleMode() {
  applyMode(el.body.dataset.mode === 'expanded' ? 'compact' : 'expanded');
}

// --- data ----------------------------------------------------------------

function bridge() {
  const api = window.pluginBridge;
  if (!api || typeof api.invoke !== 'function') {
    throw new Error('pluginBridge unavailable');
  }
  return api;
}

async function load(options = {}) {
  const token = ++loadToken;
  try {
    const data = await bridge().invoke('token-usage.summary', {
      force: options.force === true,
    });
    // A slow read that lost the race must not overwrite a newer snapshot.
    if (token !== loadToken) return;
    if (!data || typeof data !== 'object') throw new Error('empty summary');
    setStatus('');
    render(data);
  } catch (error) {
    if (token !== loadToken) return;
    const code = error?.code ? ` (${error.code})` : '';
    setStatus(`无法读取用量数据${code}`, true);
  }
}

async function applyAppearance(appearance) {
  const base = appearance && typeof appearance.base === 'string' ? appearance.base : 'dark';
  document.documentElement.dataset.base = base === 'light' ? 'light' : 'dark';
}

// --- wiring --------------------------------------------------------------

el.compact.addEventListener('click', toggleMode);
el.collapse.addEventListener('click', () => applyMode('compact'));
el.refresh.addEventListener('click', () => void load({ force: true }));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el.body.dataset.mode === 'expanded') {
    applyMode('compact');
  }
});

const bridgeApi = window.pluginBridge;
if (bridgeApi && typeof bridgeApi.on === 'function') {
  // A finished turn is the only host signal that the totals moved. Fire-and-
  // forget, so a refresh that races a tab switch costs nothing.
  bridgeApi.on('session:turnEnded', () => {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      turnTimer = null;
      void load({ force: true });
    }, TURN_REFRESH_DEBOUNCE_MS);
  });
  if (typeof bridgeApi.invoke === 'function') {
    void bridgeApi
      .invoke('app.getAppearance')
      .then(applyAppearance)
      .catch(() => {
        document.documentElement.dataset.base = 'dark';
      });
  }
  bridgeApi.on('appearance:changed', applyAppearance);
}

applyMode(readMode());
void load();
