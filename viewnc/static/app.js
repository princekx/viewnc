/* ─────────────────────────────────────────────────────────────
   viewnc  ·  app.js
   Frontend logic: file loading, variable selection, Plotly rendering
   ───────────────────────────────────────────────────────────── */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const STATE = {
  cubes: [],          // metadata array from /api/metadata
  selectedIdx: null,  // currently selected cube index
  constraints: {},    // { coordName: value }
};

// Client-side coastline cache (fetched once per resolution)
const _coastlineCache = {};


// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function getPlotHeight() {
  const el = $('plotly-div');
  if (!el) return 520;
  const top = el.getBoundingClientRect().top;
  return Math.max(320, Math.floor(window.innerHeight - top - 18));
}

function setPlotMode(enabled) {
  $('cube-info').classList.toggle('hidden', enabled);
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

// ── Utility ──────────────────────────────────────────────────────────────────
function showLoading(msg = 'Loading…') {
  $('loading-msg').textContent = msg;
  $('loading-overlay').classList.remove('hidden');
}
function hideLoading() {
  $('loading-overlay').classList.add('hidden');
}
function showError(containerId, msg) {
  const el = $(containerId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 8000);
}
function setStatus(text, type = 'idle') {
  const b = $('status-badge');
  b.textContent = text;
  b.className = `badge badge-${type}`;
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ── File Loading ──────────────────────────────────────────────────────────────
async function loadFile() {
  const fp = $('filepath-input').value.trim();
  if (!fp) { showError('load-error', 'Please enter a file path.'); return; }

  showLoading('Loading file with iris…');
  setStatus('Loading…', 'loading');
  $('load-error').classList.add('hidden');

  try {
    const data = await apiFetch('/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filepath: fp }),
    });

    STATE.cubes = data.cubes;
    STATE.selectedIdx = null;
    STATE.constraints = {};

    renderVarList();
    renderCubeCards();
    $('welcome-screen').classList.add('hidden');
    $('cube-info').classList.remove('hidden');
    $('plot-area').classList.add('hidden');
    $('plot-btn').disabled = true;

    setStatus(`${data.cubes.length} cube(s) loaded`, 'ok');
  } catch (err) {
    showError('load-error', err.message);
    setStatus('Load error', 'err');
  } finally {
    hideLoading();
  }
}

// Allow Enter key in filepath input
$('filepath-input').addEventListener('keydown', e => { if (e.key === 'Enter') loadFile(); });

// ── Variable List ─────────────────────────────────────────────────────────────
function renderVarList() {
  const list = $('var-list');
  list.innerHTML = '';

  if (STATE.cubes.length === 0) {
    list.innerHTML = '<p class="empty-msg">No variables found</p>';
    return;
  }

  $('var-count').textContent = STATE.cubes.length;

  STATE.cubes.forEach((cube, listIdx) => {
    const item = document.createElement('div');
    item.className = 'var-item';
    item.id = `var-item-${cube.index}`;
    item.onclick = () => selectVar(cube.index);

    const shape = cube.shape.join(' × ');
    item.innerHTML = `
      <div class="var-name" title="${cube.name}">${cube.name || '(unnamed)'}</div>
      <span class="var-shape">${shape}</span>
      <span class="var-units" title="${cube.units}">${cube.units}</span>
    `;
    list.appendChild(item);
  });
}

function selectVar(idx) {
  STATE.selectedIdx = idx;
  STATE.constraints = {};

  // Update highlight
  document.querySelectorAll('.var-item').forEach(el => el.classList.remove('selected'));
  $(`var-item-${idx}`)?.classList.add('selected');

  // Find cube by its .index property (not list position)
  const cube = STATE.cubes.find(c => c.index === idx) ?? STATE.cubes[idx];
  buildDimSliders(cube);
  renderCubeShapeInfo(cube);
  $('plot-btn').disabled = false;

  // Auto-enable coastlines when the plot axes look geographic
  autoSetCoastline(cube);
}

/**
 * Enable the coastline toggle when the cube's spatial axes (last 2 dim_coords)
 * look like longitude and latitude.
 */
function autoSetCoastline(cube) {
  const toggle = $('coastline-toggle');
  if (!toggle) return;
  const dims = cube.dim_coords;
  // Spatial axes are always the last two dim_coords
  const xCoord = dims[dims.length - 1];
  const yCoord = dims[dims.length - 2];
  if (!xCoord || !yCoord) return;

  const lonRe = /lon|degree.*east|x/i;
  const latRe = /lat|degree.*north|y/i;
  const xSig = (xCoord.name || '') + ' ' + (xCoord.units || '') + ' ' + (xCoord.standard_name || '');
  const ySig = (yCoord.name || '') + ' ' + (yCoord.units || '') + ' ' + (yCoord.standard_name || '');

  const isGeo = lonRe.test(xSig) && latRe.test(ySig);
  toggle.checked = isGeo;
}

// ── Cube Info Cards ───────────────────────────────────────────────────────────
function renderCubeCards() {
  const cards = $('cube-cards');
  cards.innerHTML = '';

  STATE.cubes.forEach(cube => {
    const card = document.createElement('div');
    card.className = 'cube-card';
    card.onclick = () => { openModal(cube); };

    const shape = cube.shape.join(' × ');
    const coords = cube.dim_coords.map(c => c.name).join(', ') || 'no dim coords';

    card.innerHTML = `
      <div class="cube-card-name">${cube.name || '(unnamed)'}</div>
      <div class="cube-card-meta">
        <span class="cube-card-shape">${shape}</span>
        <span class="cube-card-units">${cube.units}</span>
      </div>
      <div class="cube-card-coords">📐 ${coords}</div>
    `;
    cards.appendChild(card);
  });
}

// ── Cube Shape Info ──────────────────────────────────────────────────────
function renderCubeShapeInfo(cube) {
  const panel = $('panel-cube-shape');
  if (!panel) return;
  const container = $('cube-shape-info');
  panel.style.display = '';

  const coordNames = cube.dim_coords.map(c => c.name);
  const dimTags = cube.shape.map((s, i) =>
    `<span class="dim-tag">${coordNames[i] || 'dim' + i}: <strong>${s}</strong></span>`
  ).join('');

  const ndim = cube.ndim;
  const hasExtra = ndim > 2;
  const plotAxes = coordNames.slice(-2).join(' \u00d7 ') || 'all dims';
  const spatialShape = cube.shape.slice(-2).join(' \u00d7 ');
  const collapsedAxes = hasExtra ? coordNames.slice(0, -2).join(', ') : null;

  container.innerHTML = `
    <div class="cube-shape-row">
      <span class="cube-shape-label">Shape</span>
      <span class="cube-shape-val mono">(${cube.shape.join(' \u00d7 ')})</span>
    </div>
    <div class="cube-shape-row">
      <span class="cube-shape-label">Dims</span>
      <div class="dim-tags">${dimTags}</div>
    </div>
    <div class="cube-shape-row">
      <span class="cube-shape-label">Plot axes</span>
      <span class="cube-shape-val" style="color:var(--accent-green)">${plotAxes} &nbsp;<span class="mono" style="font-size:0.65rem;color:var(--text-muted)">(${spatialShape})</span></span>
    </div>
    ${hasExtra ? `<div class="cube-shape-row">
      <span class="cube-shape-label">Collapse</span>
      <span class="cube-shape-val" style="color:var(--accent-orange)">${collapsedAxes}</span>
    </div>` : ''}
    <div id="selection-summary"></div>
  `;

  const badge = $('dims-plot-shape');
  if (badge) badge.textContent = cube.shape.join('\u00d7');
}

/**
 * Refresh the live "Current Selection" block inside the Cube Dimensions panel.
 * Called every time a dim slider or processor changes.
 */
function updateSelectionSummary(cube) {
  const el = $('selection-summary');
  if (!el) return;

  const constraints = STATE.constraints;
  const coordNames = cube.dim_coords.map(c => c.name);
  const spatialNames = new Set(coordNames.slice(-2));
  const extraCoords = cube.dim_coords.filter(c => !spatialNames.has(c.name));

  if (extraCoords.length === 0) {
    el.innerHTML = '';
    return;
  }

  // Header
  let html = `<div class="sel-summary-header">\u25b6 Current selection</div>`;

  extraCoords.forEach(coord => {
    const spec = constraints[coord.name];
    if (!spec) return;
    const [lo, hi] = spec.range ?? [0, 0];
    const proc = spec.processor || 'mean';
    const n = hi - lo + 1;

    // Read display values from the DOM (already formatted by fmtIdx)
    const loTxt = $(`rlo-${coord.name}`)?.textContent ?? lo;
    const hiTxt = $(`rhi-${coord.name}`)?.textContent ?? hi;

    const isSingle = lo === hi;
    const rangePart = isSingle
      ? `<span class="sel-val">${loTxt}</span>`
      : `<span class="sel-val">${loTxt}</span><span class="sel-arrow">\u2192</span><span class="sel-val">${hiTxt}</span><span class="sel-n">(${n})</span>`;

    const procBadge = isSingle
      ? '' // No processor shown for single-point
      : `<span class="sel-proc">${proc}</span>`;

    html += `
      <div class="sel-row">
        <span class="sel-name">${coord.name}</span>
        <span class="sel-range">${rangePart}</span>
        ${procBadge}
      </div>`;
  });

  // Show effective plot shape
  const spatialDims = cube.dim_coords.slice(-2);
  const sy = spatialDims[0]?.shape[0] ?? '?';
  const sx = spatialDims[1]?.shape[0] ?? '?';
  const plotAxes = spatialDims.map(c => c.name).join(' \u00d7 ');
  html += `
    <div class="sel-plot-shape">
      <span class="sel-name">Plot shape</span>
      <span class="mono" style="color:var(--accent)">${sy} \u00d7 ${sx}</span>
      <span style="color:var(--text-muted);font-size:0.62rem">(${plotAxes})</span>
    </div>`;

  el.innerHTML = html;
}

// ── Dimension Sliders ──────────────────────────────────────────────────────
const PROCESSORS = ['mean', 'min', 'max', 'std', 'sum', 'median', 'rms', 'variance'];

function buildDimSliders(cube) {
  const panel = $('panel-dims');
  const container = $('dim-sliders');
  container.innerHTML = '';
  STATE.constraints = {};

  const dims = cube.dim_coords;
  const ndim = cube.ndim;
  // Extra dims = all but last 2 (the spatial/plot axes)
  const extraDims = ndim > 2 ? dims.slice(0, ndim - 2) : [];

  if (extraDims.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';

  extraDims.forEach(coord => {
    const hasValues = Array.isArray(coord.values) && coord.values.length > 0;
    // Number of index steps along this dimension
    const npts = hasValues ? coord.values.length : (coord.size || coord.shape?.[0] || 1);
    const maxIdx = npts - 1;

    // Format an index → display string
    const fmtIdx = idx => {
      if (hasValues) {
        const v = coord.values[idx];
        return typeof v === 'number' ? v.toFixed(3) : String(v);
      }
      const v = coord.min + (maxIdx > 0 ? (idx / maxIdx) : 0) * (coord.max - coord.min);
      return v.toFixed(3);
    };

    // Get numeric value from index (for sending to backend)
    const idxToVal = idx => {
      if (hasValues) return coord.values[idx];
      return coord.min + (maxIdx > 0 ? (idx / maxIdx) : 0) * (coord.max - coord.min);
    };

    // Initialise constraint: single point at index 0, processor = mean
    STATE.constraints[coord.name] = { range: [0, 0], processor: 'mean', value: idxToVal(0) };

    const procOptions = PROCESSORS.map(p =>
      `<option value="${p}"${p === 'mean' ? ' selected' : ''}>${p}</option>`).join('');

    const group = document.createElement('div');
    group.className = 'dim-slider-group';
    group.innerHTML = `
      <div class="dim-slider-header">
        <span class="dim-slider-name">${coord.name}</span>
        <span class="dim-units-tag">${coord.units || ''}</span>
        <select class="dim-proc-select" id="proc-${coord.name}" title="Aggregation processor">
          ${procOptions}
        </select>
      </div>
      <div class="range-display">
        <span class="range-val-lo" id="rlo-${coord.name}">${fmtIdx(0)}</span>
        <span class="range-arrow">→</span>
        <span class="range-val-hi" id="rhi-${coord.name}">${fmtIdx(0)}</span>
        <span class="range-npts" id="rnpts-${coord.name}">(1 pt)</span>
      </div>
      <div class="dual-slider-wrap">
        <input type="range" class="slider slider-lo" id="slo-${coord.name}"
               min="0" max="${maxIdx}" step="1" value="0" />
        <input type="range" class="slider slider-hi" id="shi-${coord.name}"
               min="0" max="${maxIdx}" step="1" value="0" />
      </div>
      <div class="slider-extent">
        <span>${fmtIdx(0)}</span><span>${fmtIdx(maxIdx)}</span>
      </div>
    `;
    container.appendChild(group);

    const slo = $(`slo-${coord.name}`);
    const shi = $(`shi-${coord.name}`);
    const procSel = $(`proc-${coord.name}`);

    function syncRange(movedLo) {
      let lo = parseInt(slo.value);
      let hi = parseInt(shi.value);
      if (lo > hi) {
        if (movedLo) { slo.value = hi; lo = hi; }
        else { shi.value = lo; hi = lo; }
      }
      $(`rlo-${coord.name}`).textContent = fmtIdx(lo);
      $(`rhi-${coord.name}`).textContent = fmtIdx(hi);
      const n = hi - lo + 1;
      $(`rnpts-${coord.name}`).textContent = `(${n} pt${n > 1 ? 's' : ''})`;
      STATE.constraints[coord.name] = {
        range: [lo, hi],
        processor: procSel.value,
        value: idxToVal(lo),
      };
      // Refresh the live selection summary in the Cube Dimensions panel
      updateSelectionSummary(cube);
    }

    slo.addEventListener('input', () => syncRange(true));
    shi.addEventListener('input', () => syncRange(false));
    procSel.addEventListener('change', () => syncRange(true));
  });

  // Render initial summary with default selections
  updateSelectionSummary(cube);
}

// ── Plotting ──────────────────────────────────────────────────────────────────
async function plotData() {
  if (STATE.selectedIdx === null) return;

  const plotType = document.querySelector('input[name="plot-type"]:checked').value;
  const colormap = $('colormap-select').value;

  if (plotType === 'timeseries') {
    await plotTimeSeries(STATE.selectedIdx);
    return;
  }

  showLoading('Extracting slice…');
  try {
    const payload = {
      cube_index: STATE.selectedIdx,
      constraints: STATE.constraints,
    };
    const result = await apiFetch('/api/slice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    render2D(result.data, result.meta, plotType, colormap);
  } catch (err) {
    alert('Plot error: ' + err.message);
  } finally {
    hideLoading();
  }
}

// ── Coastlines ───────────────────────────────────────────────────────────────
async function fetchCoastlines(resolution) {
  if (_coastlineCache[resolution]) return _coastlineCache[resolution];
  const data = await apiFetch(`/api/coastlines?res=${encodeURIComponent(resolution)}`);
  _coastlineCache[resolution] = data;
  return data;
}

function coastlineTrace(data, color) {
  return {
    type: 'scatter',
    mode: 'lines',
    x: data.x,
    y: data.y,
    line: { color, width: 1 },
    showlegend: false,
    hoverinfo: 'none',
    name: 'Coastlines',
  };
}

async function render2D(data, meta, plotType, colormap) {
  const cube = STATE.cubes[STATE.selectedIdx];
  const titleText = `${cube.name}  [${cube.units}]`;

  // Build x / y axes – meta.x.values is always a list now (server guarantees it)
  const nx = (data[0] || []).length;
  const ny = data.length;
  const xVals = (meta.x.values && meta.x.values.length === nx)
    ? meta.x.values
    : linspace(meta.x.min ?? 0, meta.x.max ?? nx - 1, nx);
  const yVals = (meta.y && meta.y.values && meta.y.values.length === ny)
    ? meta.y.values
    : linspace((meta.y ? meta.y.min : 0) ?? 0, (meta.y ? meta.y.max : ny - 1) ?? ny - 1, ny);

  let traces;
  if (plotType === 'contour') {
    traces = [{
      type: 'contour',
      x: xVals,
      y: yVals,
      z: data,
      colorscale: colormap,
      colorbar: {
        title: { text: cube.units, side: 'right' },
        thickness: 16,
        lenmode: 'fraction',
        len: 1,
        y: 0.5,
        yanchor: 'middle',
      },
      contours: { coloring: 'heatmap', showlabels: true, labelfont: { size: 9 } },
      line: { smoothing: 0.85 },
      hovertemplate: `${meta.x.name}: %{x:.2f}<br>${(meta.y || { name: 'y' }).name}: %{y:.2f}<br>Value: %{z:.4g}<extra></extra>`,
    }];
  } else if (plotType === 'line') {
    traces = [{
      type: 'scatter',
      mode: 'lines+markers',
      x: xVals,
      y: data[Math.floor(data.length / 2)],
      line: { color: '#4f8ef7', width: 2 },
      marker: { size: 4, color: '#4f8ef7' },
      name: cube.name,
      hovertemplate: `${meta.x.name}: %{x:.2f}<br>Value: %{y:.4g}<extra></extra>`,
    }];
  } else {
    traces = [{
      type: 'heatmap',
      x: xVals,
      y: yVals,
      z: data,
      colorscale: colormap,
      colorbar: {
        title: { text: cube.units, side: 'right' },
        thickness: 16,
        lenmode: 'fraction',
        len: 1,
        y: 0.5,
        yanchor: 'middle',
      },
      hovertemplate: `${meta.x.name}: %{x:.2f}<br>${(meta.y || { name: 'y' }).name}: %{y:.2f}<br>Value: %{z:.4g}<extra></extra>`,
    }];
  }

  // ── Coastline overlay ────────────────────────────────────────────────────
  const showCoast = $('coastline-toggle').checked;
  if (showCoast && plotType !== 'line') {
    try {
      const res = $('coastline-res').value;
      const col = $('coastline-color').value;
      const clData = await fetchCoastlines(res);

      const xMin = Math.min(...xVals);
      const xMax = Math.max(...xVals);
      const yMin = Math.min(...yVals);
      const yMax = Math.max(...yVals);

      // Detect 0→360 convention: data x values are mostly positive and > 180
      const is0to360 = xMin >= -10 && xMax > 180;

      const cx = [], cy = [];
      for (let i = 0; i < clData.x.length; i++) {
        let x = clData.x[i];
        const y = clData.y[i];

        if (x === null || y === null) {
          // Segment break — always pass through
          cx.push(null); cy.push(null);
          continue;
        }

        // Longitude convention: shift negative coords into 0→360 range when needed
        if (is0to360 && x < 0) x += 360;

        if (x >= xMin && x <= xMax && y >= yMin && y <= yMax) {
          cx.push(x); cy.push(y);
        } else {
          // Pen-up when leaving the domain
          if (cx.length && cx[cx.length - 1] !== null) { cx.push(null); cy.push(null); }
        }
      }
      traces.push(coastlineTrace({ x: cx, y: cy }, col));
    } catch (e) {
      console.warn('Coastlines unavailable:', e.message);
    }
  }

  // ── Detect lat/lon axes for aspect-ratio locking & coastlines ─────────────
  const xIsLon = /lon|degree/i.test(meta.x.name + ' ' + (meta.x.units || ''));
  const yIsLat = meta.y && /lat|degree/i.test(meta.y.name + ' ' + (meta.y.units || ''));
  const lockAspect = xIsLon && yIsLat && plotType !== 'line';

  // Auto-enable coastlines if axes are geographic and user hasn't manually toggled off
  if (xIsLon && yIsLat && plotType !== 'line') {
    const toggle = $('coastline-toggle');
    if (toggle && !toggle.checked) toggle.checked = true;
  }

  const layout = {
    title: { text: titleText, font: { family: 'Inter', size: 14, color: '#e8ecf4' } },
    paper_bgcolor: '#181d2e',
    plot_bgcolor: '#111520',
    font: { family: 'Inter', color: '#8b93a8', size: 11 },
    xaxis: {
      title: { text: `${meta.x.name} (${meta.x.units})`, font: { color: '#8b93a8' } },
      gridcolor: 'rgba(255,255,255,0.05)',
      linecolor: 'rgba(255,255,255,0.1)',
      tickcolor: 'rgba(255,255,255,0.1)',
    },
    yaxis: {
      title: { text: meta.y ? `${meta.y.name} (${meta.y.units})` : 'Index', font: { color: '#8b93a8' } },
      gridcolor: 'rgba(255,255,255,0.05)',
      linecolor: 'rgba(255,255,255,0.1)',
      tickcolor: 'rgba(255,255,255,0.1)',
      // Lock to 1:1 degree ratio when both axes are geographic
      ...(lockAspect ? { scaleanchor: 'x', scaleratio: 1, constrain: 'domain' } : {}),
    },
    margin: { t: 50, b: 60, l: 70, r: 80 },
    autosize: true,
    height: getPlotHeight(),
  };

  const config = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d'],
    toImageButtonOptions: { format: 'png', filename: cube.name, scale: 2 },
  };

  $('plot-title-bar').textContent = `${cube.name}  —  shape: (${meta.shape.join(', ')})`;
  $('welcome-screen').classList.add('hidden');
  setPlotMode(true);
  $('plot-area').classList.remove('hidden');

  // Plotly needs a visible container on first render to size axes/colorbar correctly.
  await nextFrame();
  Plotly.newPlot('plotly-div', traces, layout, config);
  await nextFrame();
  Plotly.relayout('plotly-div', { height: getPlotHeight() });
  Plotly.Plots.resize('plotly-div');
}

async function plotTimeSeries(idx) {
  showLoading('Computing spatial mean…');
  try {
    const result = await apiFetch('/api/timeseries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cube_index: idx }),
    });

    const cube = STATE.cubes[idx];
    const traces = [{
      type: 'scatter',
      mode: 'lines+markers',
      x: result.time,
      y: result.values,
      line: { color: '#4f8ef7', width: 2 },
      marker: { size: 5, color: '#7c5cfc' },
      name: result.name,
    }];

    const layout = {
      title: { text: `${result.name} – spatial mean  [${result.units}]`, font: { family: 'Inter', size: 14, color: '#e8ecf4' } },
      paper_bgcolor: '#181d2e',
      plot_bgcolor: '#111520',
      font: { family: 'Inter', color: '#8b93a8', size: 11 },
      xaxis: { title: { text: 'Time', font: { color: '#8b93a8' } }, gridcolor: 'rgba(255,255,255,0.05)', tickangle: -35 },
      yaxis: { title: { text: result.units, font: { color: '#8b93a8' } }, gridcolor: 'rgba(255,255,255,0.05)' },
      margin: { t: 50, b: 100, l: 70, r: 30 },
      autosize: true,
      height: getPlotHeight(),
    };

    $('plot-title-bar').textContent = `${result.name} — time series`;
    setPlotMode(true);
    $('plot-area').classList.remove('hidden');
    $('welcome-screen').classList.add('hidden');

    await nextFrame();
    Plotly.newPlot('plotly-div', traces, layout, { responsive: true, displaylogo: false });
    await nextFrame();
    Plotly.relayout('plotly-div', { height: getPlotHeight() });
    Plotly.Plots.resize('plotly-div');
  } catch (err) {
    alert('Time series error: ' + err.message);
  } finally {
    hideLoading();
  }
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(cube) {
  $('modal-title').textContent = cube.name || '(unnamed)';

  const rows = (obj) => Object.entries(obj).map(([k, v]) =>
    `<tr><td>${k}</td><td>${v ?? '—'}</td></tr>`
  ).join('');

  const coordRows = (coords) => coords.map(c => {
    const valStr = c.values ? `[${c.values.slice(0, 5).map(v => typeof v === 'number' ? v.toFixed(3) : v).join(', ')}${c.values.length > 5 ? '…' : ''}]` : `${c.min?.toFixed(3)} → ${c.max?.toFixed(3)}`;
    return `<tr><td>${c.name}</td><td>${valStr}  <span style="color:#4f8ef7">${c.units}</span>  shape: (${c.shape.join(',')})</td></tr>`;
  }).join('');

  $('modal-body').innerHTML = `
    <p class="meta-section-title">Basic Info</p>
    <table class="meta-table">
      ${rows({ 'Standard name': cube.standard_name, 'Long name': cube.long_name, 'Var name': cube.var_name, 'Units': cube.units, 'Shape': cube.shape.join(' × '), 'Dtype': cube.dtype, 'Ndim': cube.ndim })}
    </table>

    ${cube.dim_coords.length ? `
    <p class="meta-section-title">Dimension Coordinates</p>
    <table class="meta-table">${coordRows(cube.dim_coords)}</table>` : ''}

    ${cube.aux_coords.length ? `
    <p class="meta-section-title">Auxiliary Coordinates</p>
    <table class="meta-table">${coordRows(cube.aux_coords)}</table>` : ''}

    ${Object.keys(cube.attributes).length ? `
    <p class="meta-section-title">Attributes</p>
    <table class="meta-table">${rows(cube.attributes)}</table>` : ''}
  `;

  $('var-modal').classList.remove('hidden');
}

function closeModal(e) {
  if (!e || e.target === $('var-modal')) {
    $('var-modal').classList.add('hidden');
  }
}

// ── Plot utilities ────────────────────────────────────────────────────────────
function closePlot() {
  $('plot-area').classList.add('hidden');
  setPlotMode(false);
}
function downloadPlot() { Plotly.downloadImage('plotly-div', { format: 'png', scale: 2, filename: 'viewnc_plot' }); }

window.addEventListener('resize', () => {
  if ($('plot-area').classList.contains('hidden')) return;
  try {
    Plotly.relayout('plotly-div', { height: getPlotHeight() });
  } catch (_) {
    // Ignore during rapid resize before plot initialization.
  }
});

function linspace(start, stop, num) {
  if (num <= 1) return [start];
  const step = (stop - start) / (num - 1);
  return Array.from({ length: num }, (_, i) => start + i * step);
}

// ── File Browser ──────────────────────────────────────────────────────────────

const BROWSER = {
  currentPath: null,
  selectedFile: null,
  allFiles: [],
  allDirs: [],
};

const EXT_ICONS = {
  '.nc': '🌐',
  '.pp': '📊',
  '.grb': '🌬️',
  '.grib': '🌬️',
  '.grib2': '🌬️',
  '.grb2': '🌬️',
};

function openBrowser() {
  $('browser-modal').classList.remove('hidden');
  $('browser-search').value = '';
  $('browser-select-btn').disabled = true;
  BROWSER.selectedFile = null;

  // Start at the current filepath's parent directory, or home
  const cur = $('filepath-input').value.trim();
  let startPath = null;
  if (cur) {
    const lastSlash = cur.lastIndexOf('/');
    startPath = lastSlash > 0 ? cur.substring(0, lastSlash) : '/';
  }
  browserNav(startPath);
}

function closeBrowser(e) {
  if (!e || e.target === $('browser-modal')) {
    $('browser-modal').classList.add('hidden');
  }
}

async function browserNav(path) {
  $('browser-status').textContent = 'Loading…';
  BROWSER.selectedFile = null;
  $('browser-select-btn').disabled = true;

  try {
    const url = path
      ? `/api/browse?path=${encodeURIComponent(path)}`
      : '/api/browse';
    const data = await apiFetch(url);

    BROWSER.currentPath = data.path;
    BROWSER.allDirs = data.dirs;
    BROWSER.allFiles = data.files;

    renderBreadcrumbs(data.parents);
    renderBrowserDirs(data.dirs);
    renderBrowserFiles(data.files);
    $('browser-path-display').textContent = data.path;
    $('browser-search').value = '';

    const nf = data.files.length;
    const nd = data.dirs.length;
    $('browser-status').textContent =
      `${nd} folder${nd !== 1 ? 's' : ''} · ${nf} data file${nf !== 1 ? 's' : ''}`;
  } catch (err) {
    $('browser-status').textContent = 'Error: ' + err.message;
  }
}

function renderBreadcrumbs(parents) {
  const el = $('browser-breadcrumbs');
  el.innerHTML = '';
  parents.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '/';
      el.appendChild(sep);
    }
    const crumb = document.createElement('span');
    crumb.className = 'crumb' + (i === parents.length - 1 ? ' active' : '');
    crumb.textContent = p.name || '/';
    if (i < parents.length - 1) crumb.onclick = () => browserNav(p.path);
    el.appendChild(crumb);
  });
}

function renderBrowserDirs(dirs) {
  const el = $('browser-dirs');
  el.innerHTML = '';

  // "Up one level" entry
  if (BROWSER.currentPath && BROWSER.currentPath !== '/') {
    const up = document.createElement('div');
    up.className = 'browser-dir-item';
    up.innerHTML = '<span class="dir-icon">⬆</span><span class="dir-name">..</span>';
    up.onclick = () => {
      const last = BROWSER.currentPath.lastIndexOf('/');
      browserNav(last > 0 ? BROWSER.currentPath.substring(0, last) : '/');
    };
    el.appendChild(up);
  }

  if (dirs.length === 0 && BROWSER.currentPath === '/') {
    el.innerHTML += '<div style="padding:10px 12px;font-size:0.72rem;color:var(--text-muted)">No sub-folders</div>';
    return;
  }

  dirs.forEach(d => {
    const item = document.createElement('div');
    item.className = 'browser-dir-item';
    item.innerHTML = `<span class="dir-icon">📁</span><span class="dir-name" title="${d.name}">${d.name}</span>`;
    item.onclick = () => browserNav(d.path);
    el.appendChild(item);
  });
}

function renderBrowserFiles(files) {
  const el = $('browser-files');
  el.innerHTML = '';

  if (files.length === 0) {
    el.innerHTML = `
      <div class="browser-empty">
        <div class="browser-empty-icon">📭</div>
        <div>No supported data files here</div>
        <div style="font-size:0.65rem;margin-top:4px;color:var(--text-muted)">.nc · .pp · .grb · .grib2</div>
      </div>`;
    return;
  }

  files.forEach(f => {
    const ext = f.name.includes('.')
      ? f.name.substring(f.name.lastIndexOf('.')).toLowerCase()
      : '';
    const icon = EXT_ICONS[ext] || '📄';
    const size = fmtSize(f.size);
    const date = new Date(f.mtime * 1000).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
    });

    const item = document.createElement('div');
    item.className = 'browser-file-item';
    item.dataset.path = f.path;
    item.innerHTML = `
      <span class="file-icon">${icon}</span>
      <div class="file-info">
        <div class="file-name" title="${f.name}">${f.name}</div>
        <div class="file-meta">
          <span class="file-ext">${ext.replace('.', '')}</span>
          <span class="file-size">${size}</span>
          <span class="file-date">${date}</span>
        </div>
      </div>
    `;

    item.onclick = () => browserSelectItem(item, f.path);
    item.ondblclick = () => { browserSelectItem(item, f.path); browserSelectFile(); };
    el.appendChild(item);
  });
}

function browserSelectItem(itemEl, path) {
  document.querySelectorAll('.browser-file-item').forEach(el => el.classList.remove('selected'));
  itemEl.classList.add('selected');
  BROWSER.selectedFile = path;
  $('browser-select-btn').disabled = false;
  $('browser-status').textContent = `Selected: ${path.split('/').pop()}`;
}

function filterBrowserFiles() {
  const q = $('browser-search').value.trim().toLowerCase();
  const filtered = q
    ? BROWSER.allFiles.filter(f => f.name.toLowerCase().includes(q))
    : BROWSER.allFiles;
  renderBrowserFiles(filtered);
  BROWSER.selectedFile = null;
  $('browser-select-btn').disabled = true;
}

function browserSelectFile() {
  if (!BROWSER.selectedFile) return;
  $('filepath-input').value = BROWSER.selectedFile;
  $('browser-modal').classList.add('hidden');
  loadFile();   // auto-load immediately
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}
