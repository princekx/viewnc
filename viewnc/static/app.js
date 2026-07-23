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

// ── Bokeh-inspired palette definitions ────────────────────────────────────────
// Each entry is an array of hex stops (first → last = low → high value).
// Sourced from bokeh.palettes / cmocean / ColorBrewer; expressed as compact
// representative stops so Plotly can interpolate the full gradient.
const BOKEH_PALETTES = {
  // ── Perceptually-uniform (Matplotlib / Bokeh)
  'Viridis': ['#440154', '#472d7b', '#3b528b', '#27808e', '#1fa187', '#5dc963', '#fde725'],
  'Magma': ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fecf92', '#fcfdbf'],
  'Inferno': ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#f8f92e', '#fcffa4'],
  'Plasma': ['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'],
  'Cividis': ['#00204c', '#213d6b', '#555b6d', '#7b7e73', '#a3a679', '#d3cb7d', '#ffea46'],
  'Turbo': ['#23171b', '#4a6be3', '#26bbce', '#5af484', '#fddd3e', '#f34214', '#900c00'],

  // ── Diverging (ColorBrewer / Bokeh)
  'RdBu': ['#67001f', '#b2182b', '#d6604d', '#f4a582', '#fddbc7', '#f7f7f7', '#d1e5f0', '#92c5de', '#4393c3', '#2166ac', '#053061'],
  'RdBu_r': ['#053061', '#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b', '#67001f'],
  'PRGn': ['#40004b', '#762a83', '#9970ab', '#c2a5cf', '#e7d4e8', '#f7f7f7', '#d9f0d3', '#a6dba0', '#5aae61', '#1b7837', '#00441b'],
  'PiYG': ['#8e0152', '#c51b7d', '#de77ae', '#f1b6da', '#fde0ef', '#f7f7f7', '#e6f5d0', '#b8e186', '#7fbc41', '#4d9221', '#276419'],
  'BrBG': ['#543005', '#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#f5f5f5', '#c7eae5', '#80cdc1', '#35978f', '#01665e', '#003c30'],
  'PuOr': ['#7f3b08', '#b35806', '#e08214', '#fdb863', '#fee0b6', '#f7f7f7', '#d8daeb', '#b2abd2', '#8073ac', '#542788', '#2d004b'],
  'Spectral': ['#9e0142', '#d53e4f', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#e6f598', '#abdda4', '#66c2a5', '#3288bd', '#5e4fa2'],
  'RdYlBu': ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee090', '#ffffbf', '#e0f3f8', '#abd9e9', '#74add1', '#4575b4', '#313695'],
  'RdYlGn': ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850', '#006837'],
  'RdGy': ['#67001f', '#b2182b', '#d6604d', '#f4a582', '#fddbc7', '#ffffff', '#e0e0e0', '#bababa', '#878787', '#4d4d4d', '#1a1a1a'],
  'Balance': ['#1c1c5a', '#4455a8', '#7fa6d9', '#c8dff2', '#f9f9f9', '#f7c399', '#e07e3d', '#9c3a10', '#4a0c04'],
  'Delta': ['#073f6e', '#2176b5', '#72b8d8', '#c8e8f4', '#f5f5f0', '#c3e6be', '#72ba88', '#248d50', '#003d20'],
  'Curl': ['#151d44', '#2e5190', '#5896c2', '#b0d5e8', '#f0f0e8', '#d9bc88', '#b87230', '#7a3500', '#2d0f00'],

  // ── Sequential multi-hue
  'YlOrRd': ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026'],
  'YlGnBu': ['#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#0c2c84'],
  'YlGn': ['#ffffe5', '#f7fcb9', '#d9f0a3', '#addd8e', '#78c679', '#41ab5d', '#238443', '#005a32'],
  'OrRd': ['#fff7ec', '#fee8c8', '#fdd49e', '#fdbb84', '#fc8d59', '#ef6548', '#d7301f', '#7f0000'],
  'PuBuGn': ['#fff7fb', '#ece2f0', '#d0d1e6', '#a6bddb', '#67a9cf', '#3690c0', '#02818a', '#016450', '#014636'],
  'RdPu': ['#fff7f3', '#fde0dd', '#fcc5c0', '#fa9fb5', '#f768a1', '#dd3497', '#ae017e', '#7a0177', '#49006a'],
  'BuGn': ['#f7fcfd', '#e5f5f9', '#ccece6', '#99d8c9', '#66c2a4', '#41ae76', '#238b45', '#006d2c', '#00441b'],
  'Sunset': ['#364B9A', '#4A7BB7', '#6EA6CD', '#98CAE1', '#C2E4EF', '#EAECCC', '#FEDA8B', '#FDB366', '#F67E4B', '#DD3D2D', '#A50026'],
  'Sunrise': ['#e8642b', '#fb9e41', '#fec46d', '#fff5ba', '#bde1a4', '#77c87a', '#3ea160', '#117a50'],

  // ── Sequential single-hue (ColorBrewer)
  'Blues': ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#084594'],
  'Greens': ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#005a32'],
  'Oranges': ['#fff5eb', '#fee6ce', '#fdd0a2', '#fdae6b', '#fd8d3c', '#f16913', '#d94801', '#8c2d04'],
  'Purples': ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#4a1486'],
  'Reds': ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#67000d'],
  'Greys': ['#ffffff', '#f0f0f0', '#d9d9d9', '#bdbdbd', '#969696', '#737373', '#525252', '#252525'],
  'BuPu': ['#f7fcfd', '#e0ecf4', '#bfd3e6', '#9ebcda', '#8c96c6', '#8c6bb1', '#88419d', '#6e016b'],
  'GnBu': ['#f7fcf0', '#e0f3db', '#ccebc5', '#a8ddb5', '#7bccc4', '#4eb3d3', '#2b8cbe', '#08589e'],
  'PuRd': ['#f7f4f9', '#e7e1ef', '#d4b9da', '#c994c7', '#df65b0', '#e7298a', '#ce1256', '#91003f'],
  'PuBu': ['#fff7fb', '#ece7f2', '#d0d1e6', '#a6bddb', '#74a9cf', '#3690c0', '#0570b0', '#034e7b'],

  // ── Oceanographic / Earth science (cmocean-inspired)
  'Thermal': ['#042333', '#2c3d85', '#4065b1', '#5290c0', '#62b7be', '#6edc8e', '#d2e03b', '#fce11c'],
  'Haline': ['#2a186c', '#1e4a9e', '#1b7dbf', '#25a4b8', '#50c98d', '#a3d86a', '#e7e34b', '#fde74c'],
  'Solar': ['#331405', '#7a2615', '#b53a1b', '#df6b21', '#f5a23c', '#f9d76d', '#fcf2b5'],
  'Ice': ['#04082c', '#112880', '#3267b0', '#5a9cd5', '#90cae1', '#c6e4f1', '#f0f8ff'],
  'Deep': ['#fdfecc', '#c5e078', '#73bf5e', '#33a47c', '#216778', '#1c3a64', '#0b1547'],
  'Dense': ['#e6f1f8', '#a8d0e8', '#5ea4ca', '#2878a9', '#14507f', '#0b2850', '#050e29'],
  'Algae': ['#d7f9d0', '#a2d595', '#6ab187', '#3d8c7b', '#246860', '#14474a', '#072430'],
  'Matter': ['#fdecef', '#f7bfb0', '#ed9173', '#d6623e', '#b03d2c', '#7a221d', '#3b0d10'],
  'Turbid': ['#e9f0e0', '#c3cba8', '#9ba771', '#7a8245', '#5b5d27', '#3b3a15', '#1c1a06'],
  'Speed': ['#fdfdce', '#d8e497', '#a8d168', '#71bb4a', '#41a037', '#1f7d2a', '#065a20'],
  'Amp': ['#f2f2f2', '#dac9c2', '#c19f90', '#a3735e', '#804833', '#5a2611', '#310c02'],
  'Phase': ['#a8780a', '#4e9c17', '#028c73', '#1e62a6', '#5b339b', '#9d2070', '#c91b38', '#a8780a'],
  'Oxy': ['#64006b', '#9c298e', '#c75499', '#d9909b', '#d6c3a4', '#b2cf9a', '#72b87d', '#2b8a5b', '#045330'],
  'Topo': ['#273061', '#3a85c0', '#72c0d4', '#c7ead3', '#f0f5e2', '#d7c792', '#a87937', '#704e1e', '#512d12'],

  // ── Qualitative / categorical
  'Category10': ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
  'Category20': ['#1f77b4', '#aec7e8', '#ff7f0e', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896', '#9467bd', '#c5b0d5', '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7', '#bcbd22', '#dbdb8d', '#17becf', '#9edae5'],
  'Bokeh': ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'],
  'Accent': ['#7fc97f', '#beaed4', '#fdc086', '#ffff99', '#386cb0', '#f0027f', '#bf5b17', '#666666'],
  'Paired': ['#a6cee3', '#1f78b4', '#b2df8a', '#33a02c', '#fb9a99', '#e31a1c', '#fdbf6f', '#ff7f00', '#cab2d6', '#6a3d9a', '#ffff99', '#b15928'],
  'Set1': ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#999999'],
  'Set2': ['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3'],
  'Dark2': ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d', '#666666'],
};

/**
 * Convert a named Bokeh palette to a Plotly colorscale array.
 * Falls back to using the string directly (for native Plotly names).
 */
function bokehToPlotly(name) {
  const stops = BOKEH_PALETTES[name];
  if (!stops) return name; // native Plotly colorscale name
  return stops.map((hex, i) => [i / (stops.length - 1), hex]);
}
// ── Custom Colormap Picker ────────────────────────────────────────────────────

const CM_GROUPS = [
  { label: 'Perceptually Uniform', palettes: ['Viridis', 'Magma', 'Inferno', 'Plasma', 'Cividis', 'Turbo'] },
  { label: 'Diverging', palettes: ['RdBu_r', 'RdBu', 'Balance', 'Delta', 'Curl', 'Spectral', 'RdYlBu', 'RdYlGn', 'PRGn', 'PiYG', 'BrBG', 'PuOr', 'RdGy'] },
  { label: 'Sequential (multi-hue)', palettes: ['Sunset', 'Sunrise', 'YlGnBu', 'YlOrRd', 'YlGn', 'OrRd', 'PuBuGn', 'RdPu', 'BuGn'] },
  { label: 'Sequential (single-hue)', palettes: ['Blues', 'Greens', 'Oranges', 'Purples', 'Reds', 'Greys', 'BuPu', 'GnBu', 'PuRd', 'PuBu'] },
  { label: 'Oceanographic / Earth', palettes: ['Thermal', 'Haline', 'Solar', 'Ice', 'Deep', 'Dense', 'Algae', 'Matter', 'Turbid', 'Speed', 'Amp', 'Phase', 'Oxy', 'Topo'] },
  { label: 'Qualitative', palettes: ['Bokeh', 'Category10', 'Category20', 'Accent', 'Paired', 'Set1', 'Set2', 'Dark2'] },
];

const CM_DISPLAY_NAMES = {
  RdBu_r: 'RdBu (blue–white–red)',
  RdBu: 'RdBu reversed',
  Balance: 'Balance (div, blue–white–red)',
  Delta: 'Delta (div, blue–white–green)',
  Curl: 'Curl (div, teal–white–brown)',
  Thermal: 'Thermal (ocean temp)',
  Haline: 'Haline (ocean salinity)',
  Ice: 'Ice (cryo)',
  Deep: 'Deep (ocean depth)',
  Dense: 'Dense (high-density water)',
  Algae: 'Algae (chlorophyll)',
  Matter: 'Matter (suspended matter)',
  Turbid: 'Turbid (water turbidity)',
  Speed: 'Speed (current speed)',
  Amp: 'Amp (amplitude)',
  Phase: 'Phase (cyclic/circular)',
  Oxy: 'Oxy (dissolved oxygen)',
  Topo: 'Topo (elevation/depth)',
  Solar: 'Solar (radiation)',
  Category20: 'Category20 (qualitative)',
  Dark2: 'Dark2 (qualitative)',
};

/**
 * Convert a named Bokeh palette to a Plotly colorscale array.
 * Falls back to using the string directly (for native Plotly names).
 */
function bokehToPlotly(name) {
  const stops = BOKEH_PALETTES[name];
  if (!stops) return name; // native Plotly colorscale name
  return stops.map((hex, i) => [i / (stops.length - 1), hex]);
}
// ── Custom Colormap Picker ────────────────────────────────────────────────────

function _buildColormapDropdown() {
  const dropdown = document.getElementById('colormap-dropdown');
  if (!dropdown) return;

  CM_GROUPS.forEach(group => {
    const label = document.createElement('div');
    label.className = 'cm-optgroup-label';
    label.textContent = `── ${group.label} ──`;
    dropdown.appendChild(label);

    group.palettes.forEach(name => {
      const stops = BOKEH_PALETTES[name];
      const gradient = stops ? `linear-gradient(to right, ${stops.join(', ')})` : '#ccc';
      const displayName = CM_DISPLAY_NAMES[name] || name;

      const row = document.createElement('div');
      row.className = 'cm-option' + (name === 'Viridis' ? ' selected' : '');
      row.dataset.value = name;
      row.innerHTML = `
        <span class="cm-swatch" style="background:${gradient}"></span>
        <span class="cm-name">${displayName}</span>
      `;
      row.addEventListener('click', () => selectColormap(name));
      dropdown.appendChild(row);
    });
  });

  _updateColormapTrigger('Viridis');
}

function _updateColormapTrigger(name) {
  const stops = BOKEH_PALETTES[name];
  const gradient = stops ? `linear-gradient(to right, ${stops.join(', ')})` : '#ccc';
  const swatch = document.getElementById('colormap-trigger-swatch');
  const label = document.getElementById('colormap-trigger-name');
  if (swatch) swatch.style.background = gradient;
  if (label) label.textContent = CM_DISPLAY_NAMES[name] || name;
}

function selectColormap(name) {
  const input = document.getElementById('colormap-select');
  if (input) input.value = name;

  _updateColormapTrigger(name);

  document.querySelectorAll('.cm-option').forEach(el => {
    if (el.dataset.value === name) el.classList.add('selected');
    else el.classList.remove('selected');
  });

  closeColormapDropdown();

  // Trigger re-plot if a plot is active
  if (STATE.selectedIdx !== null && !$('plot-area').classList.contains('hidden')) {
    plotData();
  }
}

function toggleColormapDropdown(e) {
  if (e) e.stopPropagation();
  const trigger = document.getElementById('colormap-trigger');
  const dropdown = document.getElementById('colormap-dropdown');
  const isOpen = dropdown.classList.contains('open');

  if (isOpen) {
    closeColormapDropdown();
  } else {
    trigger.classList.add('open');
    dropdown.classList.add('open');
    const sel = dropdown.querySelector('.cm-option.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
}

function closeColormapDropdown() {
  document.getElementById('colormap-trigger')?.classList.remove('open');
  document.getElementById('colormap-dropdown')?.classList.remove('open');
}

document.addEventListener('click', e => {
  const wrapper = document.getElementById('colormap-custom-select');
  if (wrapper && !wrapper.contains(e.target)) {
    closeColormapDropdown();
  }
});

document.addEventListener('DOMContentLoaded', _buildColormapDropdown);


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

// ── Panel collapse/expand ────────────────────────────────────────────────────
function togglePanel(id) {
  const panel = $(id);
  if (panel) panel.classList.toggle('collapsed');
}

function expandPanel(id) {
  const panel = $(id);
  if (panel) panel.classList.remove('collapsed');
}

function collapsePanel(id) {
  const panel = $(id);
  if (panel) panel.classList.add('collapsed');
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

    // Auto-expand Variables panel so the user can see what loaded
    expandPanel('panel-vars');

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

// ── Auto-load pre-loaded file (supplied via CLI) ──────────────────────────────
// If the server already has a file in _state (from the --filepath CLI arg),
// /api/metadata returns it immediately.  We check on page load and populate
// the UI without requiring the user to manually click "Load".
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const data = await apiFetch('/api/metadata');
    if (data && data.cubes && data.cubes.length > 0) {
      if (data.filepath) {
        $('filepath-input').value = data.filepath;
      }
      STATE.cubes = data.cubes;
      STATE.selectedIdx = null;
      STATE.constraints = {};
      renderVarList();
      renderCubeCards();
      $('welcome-screen').classList.add('hidden');
      $('cube-info').classList.remove('hidden');
      $('plot-area').classList.add('hidden');
      $('plot-btn').disabled = true;
      expandPanel('panel-vars');
      setStatus(`${data.cubes.length} cube(s) loaded`, 'ok');
    }
  } catch (_) {
    // No file pre-loaded – stay on welcome screen (expected without a CLI arg)
  }
});

function updateOptionsBarVisibility() {
  const plotType = $('plot-type-select').value;
  const is2D = plotType === 'heatmap' || plotType === 'contour';
  const isContour = plotType === 'contour';

  // Toggle visibility of colormap, symmetric, marginals, coastlines group
  $('colormap-inline-row').classList.toggle('hidden', !is2D);
  $('symmetric-label').classList.toggle('hidden', !is2D);
  $('marginal-label').classList.toggle('hidden', !is2D);
  $('coastline-inline-row').classList.toggle('hidden', !is2D);

  // Coastlines color selector is only visible when coastlines are enabled
  const showCoast = is2D && $('coastline-res').value !== 'none';
  $('coastline-color').classList.toggle('hidden', !showCoast);

  // Contour options display
  $('contour-inline-opts').classList.toggle('hidden', !isContour);
  $('contour-sep').style.display = isContour ? 'inline-block' : 'none';
}

function initPlotOptionsListeners() {
  const triggerReplot = () => {
    if (STATE.selectedIdx !== null && !$('plot-area').classList.contains('hidden') && !$('plotly-div').classList.contains('hidden')) {
      plotData();
    }
  };

  $('plot-type-select').addEventListener('change', () => {
    updateOptionsBarVisibility();
    triggerReplot();
  });

  $('coastline-res').addEventListener('change', () => {
    updateOptionsBarVisibility();
    triggerReplot();
  });

  // Toggles and select changes that trigger immediate replot
  ['symmetric-toggle', 'marginal-toggle', 'coastline-color', 'contour-filled'].forEach(id => {
    $(id).addEventListener('change', triggerReplot);
  });

  // Numeric inputs trigger replot on change (blur or enter key)
  ['contour-levels', 'contour-min', 'contour-max'].forEach(id => {
    $(id).addEventListener('change', triggerReplot);
  });
}

// Initialize on script load
updateOptionsBarVisibility();
initPlotOptionsListeners();



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

  // Show plot area card and option bar, but hide plot toolbar and plotly container
  $('plot-area').classList.remove('hidden');
  document.querySelector('.plot-toolbar').classList.add('hidden');
  $('plotly-div').classList.add('hidden');
  $('welcome-screen').classList.add('hidden');

  $('plot-btn').disabled = false;

  // Auto-configure plot type and coastlines based on the last 2 dimensions
  autoConfigurePlot(cube);
}

/**
 * Automatically set the default plot type and coastline settings whenever
 * a variable is selected.  The plot always defaults to the last 2 dimensions
 * of the cube (generic behaviour):
 *
 *   ndim >= 2  → heatmap  (2-D view of dim[-2] × dim[-1])
 *   ndim == 1  → line     (1-D profile along the single dimension)
 *
 * Coastlines are enabled at 50 m resolution when the last 2 dim_coords
 * look like latitude × longitude (geographic axes), otherwise set to none.
 */
function autoConfigurePlot(cube) {
  const dims = cube.dim_coords;
  const ndim = cube.ndim;

  // ── Default plot type: always based on last 2 dims ────────────────────────
  const plotSel = $('plot-type-select');
  if (plotSel) {
    plotSel.value = ndim >= 2 ? 'heatmap' : 'line';
  }

  // ── Coastlines: enable when last 2 dims are geographic ────────────────────
  const resSel = $('coastline-res');
  if (resSel && ndim >= 2) {
    const xCoord = dims[dims.length - 1];
    const yCoord = dims[dims.length - 2];

    if (xCoord && yCoord) {
      const lonRe = /lon|degree.*east/i;
      const latRe = /lat|degree.*north/i;
      const xSig = (xCoord.name || '') + ' ' + (xCoord.units || '') + ' ' + (xCoord.standard_name || '');
      const ySig = (yCoord.name || '') + ' ' + (yCoord.units || '') + ' ' + (yCoord.standard_name || '');
      const isGeo = lonRe.test(xSig) && latRe.test(ySig);
      resSel.value = isGeo ? '50m' : 'none';
    } else {
      resSel.value = 'none';
    }
  } else if (resSel) {
    resSel.value = 'none';
  }

  updateOptionsBarVisibility();
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
        <div class="slider-row slider-lo-row">
          <span class="slider-row-label">Start</span>
          <input type="range" class="slider slider-lo" id="slo-${coord.name}"
                 min="0" max="${maxIdx}" step="1" value="0" />
        </div>
        <div class="slider-row">
          <span class="slider-row-label">End</span>
          <input type="range" class="slider slider-hi" id="shi-${coord.name}"
                 min="0" max="${maxIdx}" step="1" value="0" />
        </div>
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

      if (movedLo) {
        // Start slider moved: end always follows so the selection stays a
        // single point.  The user can then drag the end slider rightward
        // independently to widen the range.
        hi = lo;
        shi.value = hi;
      } else {
        // End slider moved independently: only prevent it going below start.
        if (hi < lo) {
          hi = lo;
          shi.value = hi;
        }
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

  const plotType = $('plot-type-select').value;
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
    hoverinfo: 'skip',   // 'skip' passes hover events through to the underlying data trace
    name: 'Coastlines',
  };
}

async function render2D(data, meta, plotType, colormap) {
  const cube = STATE.cubes.find(c => c.index === STATE.selectedIdx) ?? STATE.cubes[STATE.selectedIdx];
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

  const margin = { t: 50, b: 60, l: 72, r: 80 };
  const plotH = getPlotHeight();
  const plotAreaH = plotH - margin.t - margin.b;
  // Colorbar initial sizing: fraction of paper height occupied by the axis area.
  // After render we do a correction pass for scaleanchor-constrained plots.
  const cbLen = plotAreaH / plotH;
  const cbY = (margin.b + plotAreaH / 2) / plotH;

  // ── Symmetric colorbar ────────────────────────────────────────────────────
  // When the toggle is on, zmin = -zmax = -max(|vmin|, |vmax|) so that the
  // zero-crossing always maps to the mid-point of the colorscale.
  const symmetric = $('symmetric-toggle')?.checked ?? false;
  let symZmin, symZmax;
  if (symmetric) {
    const absMax = Math.max(Math.abs(meta.vmin ?? 0), Math.abs(meta.vmax ?? 1));
    symZmin = -absMax;
    symZmax = absMax;
  }

  // ── Marginal profiles ─────────────────────────────────────────────────
  // Compute row/column means from the raw 2-D data matrix (client-side, no API call)
  const showMarginals = ($('marginal-toggle')?.checked ?? false)
    && (plotType === 'heatmap' || plotType === 'contour');

  // Zonal mean: average over all longitudes for each latitude row
  const zonalMean = data.map(row => {
    const v = row.filter(x => x !== null && isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });

  // Meridional mean: average over all latitudes for each longitude column
  const meridionalMean = xVals.map((_, j) => {
    const v = data.map(r => r[j]).filter(x => x !== null && isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });

  let traces;
  if (plotType === 'contour') {
    const ncontours = parseInt($('contour-levels')?.value ?? '10', 10);
    const filled = $('contour-filled')?.checked ?? true;
    const minValStr = $('contour-min')?.value.trim() ?? '';
    const maxValStr = $('contour-max')?.value.trim() ?? '';
    const minVal = minValStr !== '' && !isNaN(parseFloat(minValStr)) ? parseFloat(minValStr) : null;
    const maxVal = maxValStr !== '' && !isNaN(parseFloat(maxValStr)) ? parseFloat(maxValStr) : null;

    let autocontour = true;
    let contourOpts = {
      coloring: filled ? 'heatmap' : 'lines',
      showlabels: true,
      labelfont: { size: 9, color: '#0f172a' },
    };
    let zmin = undefined;
    let zmax = undefined;

    if (symmetric) {
      // Symmetric overrides manual min/max and resets contour levels
      zmin = symZmin;
      zmax = symZmax;
      autocontour = false;
      contourOpts.start = symZmin;
      contourOpts.end = symZmax;
      contourOpts.size = (symZmax - symZmin) / ncontours;
    } else if (minVal !== null && maxVal !== null) {
      if (minVal < maxVal) {
        autocontour = false;
        contourOpts.start = minVal;
        contourOpts.end = maxVal;
        contourOpts.size = (maxVal - minVal) / ncontours;
        zmin = minVal;
        zmax = maxVal;
      }
    } else if (minVal !== null) {
      zmin = minVal;
    } else if (maxVal !== null) {
      zmax = maxVal;
    }

    traces = [{
      type: 'contour',
      x: xVals,
      y: yVals,
      z: data,
      autocontour: autocontour,
      ncontours: autocontour ? ncontours : undefined,
      zmin: zmin,
      zmax: zmax,
      colorscale: bokehToPlotly(colormap),
      colorbar: {
        title: { text: cube.units, side: 'right', font: { color: '#475569', size: 11 } },
        tickfont: { color: '#475569', size: 10 },
        thickness: 14,
        lenmode: 'fraction',
        len: cbLen,
        y: cbY,
        yanchor: 'middle',
        ypad: 0,
        bgcolor: 'rgba(255,255,255,0.8)',
        bordercolor: 'rgba(30,40,80,0.12)',
        borderwidth: 1,
      },
      contours: contourOpts,
      line: { smoothing: 0.85 },
      hovertemplate: `${meta.x.name}: %{x:.2f}<br>${(meta.y || { name: 'y' }).name}: %{y:.2f}<br>Value: %{z:.4g}<extra></extra>`,
    }];
  } else if (plotType === 'line') {
    const yData = data[Math.floor(data.length / 2)];
    traces = [
      // Filled area underneath the line
      {
        type: 'scatter',
        mode: 'none',
        x: xVals,
        y: yData,
        fill: 'tozeroy',
        fillcolor: 'rgba(37,99,235,0.10)',
        showlegend: false,
        hoverinfo: 'skip',
        name: '',
      },
      // The line itself
      {
        type: 'scatter',
        mode: 'lines+markers',
        x: xVals,
        y: yData,
        line: { color: '#2563eb', width: 2.5, shape: 'spline', smoothing: 0.6 },
        marker: { size: 5, color: '#ffffff', line: { color: '#2563eb', width: 2 } },
        name: cube.name,
        hovertemplate: `${meta.x.name}: %{x:.2f}<br>Value: %{y:.4g}<extra></extra>`,
      },
    ];
  } else {
    traces = [{
      type: 'heatmap',
      x: xVals,
      y: yVals,
      z: data,
      zmin: symmetric ? symZmin : undefined,
      zmax: symmetric ? symZmax : undefined,
      colorscale: bokehToPlotly(colormap),
      colorbar: {
        title: { text: cube.units, side: 'right', font: { color: '#475569', size: 11 } },
        tickfont: { color: '#475569', size: 10 },
        thickness: 14,
        lenmode: 'fraction',
        len: cbLen,
        y: cbY,
        yanchor: 'middle',
        ypad: 0,
        bgcolor: 'rgba(255,255,255,0.8)',
        bordercolor: 'rgba(30,40,80,0.12)',
        borderwidth: 1,
      },
      hovertemplate: `${meta.x.name}: %{x:.2f}<br>${(meta.y || { name: 'y' }).name}: %{y:.2f}<br>Value: %{z:.4g}<extra></extra>`,
    }];
  }

  // ── Coastline overlay ────────────────────────────────────────────────────
  const showCoast = $('coastline-res').value !== 'none';
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



  const layout = {
    title: {
      text: titleText,
      font: { family: 'Inter', size: 14, color: '#0f172a', weight: 600 },
      x: 0.04,
    },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#f8faff',
    font: { family: 'Inter', color: '#475569', size: 11 },
    xaxis: {
      title: { text: `${meta.x.name} (${meta.x.units})`, font: { color: '#475569', size: 11 } },
      gridcolor: 'rgba(30,40,80,0.07)',
      linecolor: 'rgba(30,40,80,0.15)',
      tickcolor: 'rgba(30,40,80,0.15)',
      tickfont: { color: '#475569' },
      zerolinecolor: 'rgba(30,40,80,0.20)',
      zerolinewidth: 1,
    },
    yaxis: {
      title: { text: meta.y ? `${meta.y.name} (${meta.y.units})` : 'Index', font: { color: '#475569', size: 11 } },
      gridcolor: 'rgba(30,40,80,0.07)',
      linecolor: 'rgba(30,40,80,0.15)',
      tickcolor: 'rgba(30,40,80,0.15)',
      tickfont: { color: '#475569' },
      zerolinecolor: 'rgba(30,40,80,0.20)',
      zerolinewidth: 1,
      // Lock to 1:1 degree ratio when both axes are geographic
      ...(lockAspect ? { scaleanchor: 'x', scaleratio: 1, constrain: 'domain' } : {}),
    },
    margin: margin,
    autosize: true,
    height: getPlotHeight(),
  };

  // ── Marginal profile subplot layout injection ────────────────────────
  if (showMarginals) {
    // Domain grid:
    //  Main heatmap:   x [0, 0.73]  y [0.23, 1.0]
    //  Right panel:    x [0.76, 1.0] y [0.23, 1.0]   ← zonal mean
    //  Bottom panel:   x [0, 0.73]  y [0, 0.20]      ← meridional mean
    const MX_END = 0.73, SX_START = 0.76;
    const MY_START = 0.23, SY_END = 0.20;
    const units = meta.units || '';
    const axStyle = {
      gridcolor: 'rgba(30,40,80,0.07)', linecolor: 'rgba(30,40,80,0.15)',
      tickfont: { color: '#475569', size: 9 }
    };

    // Compute data-dependent ranges for marginal plots to avoid forcing min to 0
    const getRange = (arr) => {
      const valid = arr.filter(v => v !== null && isFinite(v));
      if (!valid.length) return [0, 1];
      const min = Math.min(...valid);
      const max = Math.max(...valid);
      const span = max - min;
      if (span === 0) return [min - 1, max + 1];
      return [min - 0.05 * span, max + 0.05 * span];
    };
    const zonalRange = getRange(zonalMean);
    const meridionalRange = getRange(meridionalMean);

    layout.xaxis.domain = [0, MX_END];
    layout.yaxis.domain = [MY_START, 1.0];
    // Disable scaleanchor — incompatible with explicit domain layout
    delete layout.yaxis.scaleanchor;
    delete layout.yaxis.scaleratio;
    delete layout.yaxis.constrain;

    // Right panel (zonal mean: value on x, latitude on y, shares y with main)
    layout.xaxis2 = {
      ...axStyle, domain: [SX_START, 1.0],
      title: { text: `Zonal mean ${units}`, font: { color: '#475569', size: 9 } },
      zeroline: true, zerolinecolor: 'rgba(30,40,80,0.15)', zerolinewidth: 1,
      range: zonalRange
    };
    layout.yaxis2 = {
      domain: [MY_START, 1.0], matches: 'y',
      showticklabels: false, showgrid: false, anchor: 'x2'
    };

    // Bottom panel (meridional mean: longitude on x, value on y, shares x with main)
    layout.xaxis3 = {
      domain: [0, MX_END], matches: 'x',
      showticklabels: false, showgrid: false, anchor: 'y3'
    };
    layout.yaxis3 = {
      ...axStyle, domain: [0, SY_END],
      title: { text: `Meridional mean ${units}`, font: { color: '#475569', size: 9 } },
      zeroline: true, zerolinecolor: 'rgba(30,40,80,0.15)', zerolinewidth: 1,
      range: meridionalRange
    };

    // Reposition colorbar to fit between main plot and right panel
    traces.forEach(t => {
      if (t.colorbar) {
        t.colorbar.x = MX_END + 0.005;
        t.colorbar.xpad = 2;
        // Reset len/y — domain layout changes internal pixel geometry
        t.colorbar.lenmode = 'fraction';
        t.colorbar.len = 1.0 - MY_START;  // rough estimate; correction runs below
        t.colorbar.y = (MY_START + 1.0) / 2;
      }
    });

    layout.margin = { t: 50, b: 50, l: 72, r: 12 };

    // Zonal mean trace (right panel)
    traces.push({
      type: 'scatter', mode: 'lines',
      x: zonalMean, y: yVals,
      xaxis: 'x2', yaxis: 'y2',
      line: { color: '#2563eb', width: 1.8, shape: 'linear' },
      fill: 'tozerox', fillcolor: 'rgba(37,99,235,0.08)',
      showlegend: false,
      hovertemplate: `${(meta.y || { name: 'y' }).name}: %{y:.2f}<br>Zonal ̅: %{x:.4g} ${units}<extra>Zonal mean</extra>`,
      name: 'Zonal mean',
    });

    // Meridional mean trace (bottom panel)
    traces.push({
      type: 'scatter', mode: 'lines',
      x: xVals, y: meridionalMean,
      xaxis: 'x3', yaxis: 'y3',
      line: { color: '#dc2626', width: 1.8, shape: 'linear' },
      fill: 'tozeroy', fillcolor: 'rgba(220,38,38,0.08)',
      showlegend: false,
      hovertemplate: `${meta.x.name}: %{x:.2f}<br>Merid. ̅: %{y:.4g} ${units}<extra>Meridional mean</extra>`,
      name: 'Meridional mean',
    });
  }

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
  document.querySelector('.plot-toolbar').classList.remove('hidden');
  $('plotly-div').classList.remove('hidden');
  clearLocSeries();  // Reset floating window on each new plot
  $('stats-bar').classList.add('hidden');  // hide stale stats until fresh data arrives

  // Plotly needs a visible container on first render to size axes/colorbar correctly.
  await nextFrame();
  Plotly.newPlot('plotly-div', traces, layout, config);
  await nextFrame();
  Plotly.relayout('plotly-div', { height: getPlotHeight() });
  Plotly.Plots.resize('plotly-div');

  // Fetch and show statistics non-blocking (only for 2D plot types)
  if (plotType === 'heatmap' || plotType === 'contour') {
    fetchAndRenderStats();
  }

  // ── Post-render colorbar correction ────────────────────────────────────────
  // Skipped when marginal panels are on (domain layout changes internal geometry).
  // When scaleanchor is active (geographic plots), Plotly compresses the axis
  // area to maintain aspect ratio.  Read the actual rendered axis pixel height
  // and restyle the colorbar so it matches exactly.
  if (!showMarginals) await nextFrame();
  try {
    if (!showMarginals) {
      const gd = $('plotly-div');
      const fl = gd._fullLayout;
      const actualAxisH = fl?.yaxis?._length;   // rendered axis height in px
      const totalH = fl?.height;                 // total figure height in px
      const axisOffset = fl?.yaxis?._offset;     // px from bottom of paper to axis bottom
      if (actualAxisH && totalH && axisOffset != null) {
        const corrLen = actualAxisH / totalH;
        const corrY = (axisOffset + actualAxisH / 2) / totalH;
        const styleUpdate = {};
        const traceIndices = [];
        traces.forEach((t, i) => {
          if (t.colorbar) {
            styleUpdate[`colorbar.len`] = corrLen;
            styleUpdate[`colorbar.y`] = corrY;
            traceIndices.push(i);
          }
        });
        if (traceIndices.length) {
          Plotly.restyle('plotly-div', styleUpdate, traceIndices);
        }
      }
    }
  } catch (_) { /* best-effort */ }


  // ── Click-to-series listener (only for 2D plot types) ──────────────────
  if (plotType === 'heatmap' || plotType === 'contour') {
    const plotDiv = $('plotly-div');
    plotDiv.classList.add('click-enabled');
    // Remove any previously bound listener to avoid stacking
    plotDiv.removeAllListeners?.('plotly_click');
    plotDiv.on('plotly_click', (eventData) => {
      const pt = eventData.points?.[0];
      if (!pt) return;
      // Ignore coastline / marker scatter trace clicks
      if (pt.data?.type === 'scatter') return;
      showAxisPicker(pt.x, pt.y, meta, xVals, yVals);
    });
  } else {
    $('plotly-div').classList.remove('click-enabled');
  }
}

// ── Axis Picker Modal ────────────────────────────────────────────────────────

// Pending click state (set when picker is open)
let _pendingClick = null;

/**
 * Show the axis-picker modal when the user clicks on the map.
 * If no extra dims exist (ndim ≤ 2), skip directly to renderLocSeries.
 */
function showAxisPicker(xClick, yClick, meta, xVals, yVals) {
  const cube = STATE.cubes.find(c => c.index === STATE.selectedIdx) ?? STATE.cubes[STATE.selectedIdx];
  if (!cube) return;

  const ndim = cube.ndim;
  const extraDims = ndim > 2 ? cube.dim_coords.slice(0, ndim - 2) : [];

  // Icons for all axis types
  const axisIcon = name => {
    if (/time/i.test(name)) return '🕒';
    if (/pressure|plev/i.test(name)) return '🌡️';
    if (/level|height|depth|altitude/i.test(name)) return '📏';
    if (/ensemble|member/i.test(name)) return '🎲';
    if (/lat/i.test(name)) return '↕️';
    if (/lon/i.test(name)) return '↔️';
    return '📐';
  };

  // Full list: extra dims first, then lat, then lon — always at least 2 spatial axes
  const allAxes = [
    ...extraDims.map(c => ({
      name: c.name, units: c.units,
      npts: c.values?.length ?? c.size ?? (c.shape?.[0] ?? '?'),
      spatial: false,
    })),
    ...(meta.y ? [{ name: meta.y.name, units: meta.y.units, npts: yVals.length, spatial: true }] : []),
    { name: meta.x.name, units: meta.x.units, npts: xVals.length, spatial: true },
  ];

  _pendingClick = { xClick, yClick, meta, xVals, yVals };

  const opts = $('axis-picker-options');
  opts.innerHTML = '';

  allAxes.forEach((ax, i) => {
    const btn = document.createElement('button');
    btn.className = 'axis-picker-btn';
    if (ax.spatial) btn.classList.add('axis-picker-btn-spatial');
    btn.style.animationDelay = `${i * 0.04}s`;
    const unitsStr = ax.units ? `${ax.units} · ` : '';
    const hint = ax.spatial
      ? (ax.name === meta.x.name
        ? 'longitude profile at clicked φ'
        : 'latitude profile at clicked λ')
      : `${ax.npts} points`;
    btn.innerHTML = `
      <span class="axis-picker-btn-icon">${axisIcon(ax.name)}</span>
      <span class="axis-picker-btn-body">
        <span class="axis-picker-btn-name">${ax.name}</span>
        <span class="axis-picker-btn-meta">${unitsStr}${hint}</span>
      </span>
      <span class="axis-picker-btn-arrow">›</span>
    `;
    btn.addEventListener('click', () => confirmAxisPicker(ax.name));
    opts.appendChild(btn);
  });

  const xU = meta.x.units ? ` ${meta.x.units}` : '';
  const yU = meta.y?.units ? ` ${meta.y.units}` : '';
  $('axis-picker-coords').textContent =
    `📍 (${xClick.toFixed(2)}${xU},  ${yClick.toFixed(2)}${yU})`;

  $('axis-picker-modal').classList.remove('hidden');
}

function confirmAxisPicker(axisName) {
  const pending = _pendingClick;   // save before closeAxisPicker nulls it
  closeAxisPicker();
  if (!pending) return;
  const { xClick, yClick, meta, xVals, yVals } = pending;
  renderLocSeries(xClick, yClick, meta, xVals, yVals, axisName);
}

function closeAxisPicker() {
  $('axis-picker-modal').classList.add('hidden');
  _pendingClick = null;
}

// Allow Escape to close the picker
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAxisPicker();
});

// ── Location Series Floating Window ──────────────────────────────────────────

// Vivid, distinct colors for successive series (cycles after 10)
const LOC_COLORS = [
  '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#6366f1',
];

// ── Per-axis floating window registry ────────────────────────────────────────
// _axisWins: Map<axisName, { winEl, plotDivId, traces, initialized,
//                            axisName, axisUnits, units, isVertProfile, colorIdx }>
const _axisWins = new Map();
let _winCount = 0;  // used for cascaded positioning

/** Create a new draggable/resizable window DOM element for the given axis. */
function _createAxisWindow(axisKey) {
  const idx = _winCount++;
  const winId = `loc-win-${idx}`;
  const plotId = `loc-plot-${idx}`;
  const offset = idx * 30;

  // Portrait for vertical-profile axes (pressure/level/height/depth),
  // landscape for everything else (time, ensemble, …)
  const _isVertAxis = n => /pressure|level|plev|height|altitude|depth/i.test(n || '');
  const isVert = _isVertAxis(axisKey);
  const W = isVert ? 340 : 520;   // window width  (px)
  const H = isVert ? 520 : 320;   // window height (px)

  const win = document.createElement('div');
  win.className = 'loc-win';
  win.id = winId;
  win.style.cssText =
    `right:${32 + offset}px;bottom:${40 + offset}px;width:${W}px;height:${H}px;`;

  win.innerHTML = `
    <div class="loc-win-header" id="${winId}-handle">
      <span class="loc-win-icon">📍</span>
      <span class="loc-win-title" id="${winId}-title">Location Series — ${axisKey}</span>
      <div class="loc-win-actions">
        <button class="btn btn-ghost btn-sm" onclick="exportAxisCSV('${axisKey}')" title="Download as CSV">⬇ CSV</button>
        <button class="btn btn-ghost btn-sm" onclick="downloadAxisPNG('${axisKey}')" title="Download as PNG">⬇ PNG</button>
        <button class="btn btn-ghost btn-sm" onclick="exportAxisNetCDF('${axisKey}')" title="Download as NetCDF">⬇ NC</button>
        <button class="btn btn-ghost btn-sm" onclick="clearAxisWin('${axisKey}')" title="Clear series">⊘ Clear</button>
        <button class="btn btn-ghost btn-sm" onclick="closeAxisWin('${axisKey}')" title="Close">✕</button>
      </div>
    </div>
    <div class="loc-win-chart" id="${plotId}"></div>
    <div class="loc-win-resize" id="${winId}-resize" title="Drag to resize"></div>
  `;

  $('loc-wins-container').appendChild(win);
  _attachDragResize(winId, plotId);
  return {
    winEl: win, plotDivId: plotId,
    traces: [], initialized: false,
    axisName: null, axisUnits: null, units: null,
    isVertProfile: false, colorIdx: 0
  };
}

/** Attach drag and corner-resize handlers to a dynamically created window. */
function _attachDragResize(winId, plotId) {
  const handle = document.getElementById(`${winId}-handle`);
  const grip = document.getElementById(`${winId}-resize`);
  if (!handle) return;

  let dragging = false, startX, startY, origLeft, origTop;
  handle.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;
    dragging = true;
    const win = document.getElementById(winId);
    const rect = win.getBoundingClientRect();
    win.style.right = 'auto'; win.style.bottom = 'auto';
    win.style.left = rect.left + 'px'; win.style.top = rect.top + 'px';
    origLeft = rect.left; origTop = rect.top;
    startX = e.clientX; startY = e.clientY;
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const win = document.getElementById(winId);
    if (!win) { dragging = false; return; }
    win.style.left = Math.max(0, origLeft + (e.clientX - startX)) + 'px';
    win.style.top = Math.max(0, origTop + (e.clientY - startY)) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });

  if (grip) {
    let resizing = false, rsx, rsy, rw, rh;
    grip.addEventListener('mousedown', e => {
      resizing = true;
      const win = document.getElementById(winId);
      rsx = e.clientX; rsy = e.clientY;
      rw = win.offsetWidth; rh = win.offsetHeight;
      e.preventDefault(); document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!resizing) return;
      const win = document.getElementById(winId);
      if (!win) { resizing = false; return; }
      win.style.width = Math.max(320, rw + (e.clientX - rsx)) + 'px';
      win.style.height = Math.max(280, rh + (e.clientY - rsy)) + 'px';
      try { Plotly.Plots.resize(plotId); } catch (_) { }
    });
    document.addEventListener('mouseup', () => { resizing = false; document.body.style.userSelect = ''; });
  }
}

async function renderLocSeries(xClick, yClick, meta, xVals, yVals, seriesAxisOverride) {
  // seriesAxisOverride is required from the picker (null only for ndim<=2 cubes)
  const cube = STATE.cubes.find(c => c.index === STATE.selectedIdx) ?? STATE.cubes[STATE.selectedIdx];
  if (!cube) return;

  const snapX = xVals.reduce((a, b) => Math.abs(b - xClick) < Math.abs(a - xClick) ? b : a, xVals[0]);
  const snapY = yVals.reduce((a, b) => Math.abs(b - yClick) < Math.abs(a - yClick) ? b : a, yVals[0]);

  const xU = meta.x.units ? ` ${meta.x.units}` : '';
  const yU = meta.y?.units ? ` ${meta.y.units}` : '';
  const seriesAxis = seriesAxisOverride ?? $('click-axis-select')?.value ?? null;

  // Key for this window — one window per chosen axis
  const winKey = seriesAxis || '__default__';

  // Get or create the per-axis window
  if (!_axisWins.has(winKey)) {
    _axisWins.set(winKey, _createAxisWindow(winKey === '__default__' ? 'series' : winKey));
  }
  const win = _axisWins.get(winKey);
  const titleEl = document.getElementById(`${win.winEl.id}-title`);
  if (titleEl) titleEl.textContent = `${cube.name}  ·  fetching…`;

  let result;
  // Show inline loading in the window title — keeps the main plot interactive
  if (titleEl) titleEl.textContent = `${cube.name}  ·  loading (${snapX.toFixed(2)}${xU}, ${snapY.toFixed(2)}${yU})…`;
  try {
    result = await apiFetch('/api/location_series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cube_index: STATE.selectedIdx,
        x_val: snapX, y_val: snapY,
        constraints: STATE.constraints,
        series_axis: seriesAxis,
      }),
    });
  } catch (err) {
    if (titleEl) titleEl.textContent = `${cube.name}  ·  error: ${err.message}`;
    return;
  }

  // Store axis metadata on first fetch for this window
  if (win.traces.length === 0) {
    win.axisName = result.axis_name ?? 'index';
    win.axisUnits = result.axis_units ?? '';
    win.units = result.units ?? '';
    const _isPressureLike = n => /pressure|level|plev|height|altitude|depth/i.test(n || '');
    win.isVertProfile = _isPressureLike(win.axisName) && typeof result.axis_values[0] === 'number';
  }

  const { axisName, axisUnits: aUnits, units, isVertProfile } = win;
  const axisUnits = aUnits ? ` (${aUnits})` : '';
  const color = LOC_COLORS[win.colorIdx % LOC_COLORS.length];
  win.colorIdx++;

  const label = `(${result.x_val.toFixed(2)}${xU}, ${result.y_val.toFixed(2)}${yU})`;


  // Spline requires numeric coordinates — fall back to linear for string axes
  // (e.g. formatted date strings on the time axis).
  const axisIsNumeric = result.axis_values.length > 0
    && typeof result.axis_values[0] === 'number';
  const lineShape = axisIsNumeric ? 'spline' : 'linear';

  const newTrace = isVertProfile ? {
    type: 'scatter', mode: 'lines+markers',
    x: result.values, y: result.axis_values, name: label,
    line: { color, width: 2, shape: lineShape, smoothing: 0.5 },
    marker: { size: 4, color: '#fff', line: { color, width: 1.5 } },
    hovertemplate: `<b>${label}</b><br>${axisName}: %{y}<br>Value: %{x:.4g} ${units}<extra></extra>`,
  } : {
    type: 'scatter', mode: 'lines+markers',
    x: result.axis_values, y: result.values, name: label,
    line: { color, width: 2, shape: lineShape, smoothing: 0.5 },
    marker: { size: 4, color: '#fff', line: { color, width: 1.5 } },
    hovertemplate: `<b>${label}</b><br>${axisName}: %{x}<br>Value: %{y:.4g} ${units}<extra></extra>`,
  };

  if (!win.initialized) {
    Plotly.newPlot(win.plotDivId, [newTrace],
      _locWinLayout(axisName, axisUnits, units, isVertProfile), {
      responsive: true, displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
    });
    win.initialized = true;
  } else {
    Plotly.addTraces(win.plotDivId, newTrace);
  }

  _addClickMarker(snapX, snapY, color);
  win.traces.push({ x_val: snapX, y_val: snapY, color, label });

  const n = win.traces.length;
  if (titleEl) titleEl.textContent =
    `${cube.name}  ·  ${axisName}  ·  ${n} location${n > 1 ? 's' : ''}  [click to add]`;
}

function _locWinLayout(axisName, axisUnits, units, isVertProfile = false) {
  // For vertical profiles: series axis (pressure/level) goes on y; value on x.
  // Pressure increases downward, so invert the y-axis.
  const xTitle = isVertProfile ? units : `${axisName}${axisUnits}`;
  const yTitle = isVertProfile ? `${axisName}${axisUnits}` : units;
  return {
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#f8faff',
    font: { family: 'Inter', color: '#475569', size: 11 },
    legend: {
      font: { size: 10, color: '#475569' },
      bgcolor: 'rgba(255,255,255,0.85)',
      bordercolor: 'rgba(30,40,80,0.12)',
      borderwidth: 1,
      x: 0, xanchor: 'left',
      y: 1, yanchor: 'bottom',
      orientation: 'h',
    },
    xaxis: {
      title: { text: xTitle, font: { color: '#475569', size: 11 } },
      gridcolor: 'rgba(30,40,80,0.07)',
      linecolor: 'rgba(30,40,80,0.15)',
      tickfont: { color: '#475569', size: 10 },
      tickangle: isVertProfile ? 0 : -30,
    },
    yaxis: {
      title: { text: yTitle, font: { color: '#475569', size: 11 } },
      gridcolor: 'rgba(30,40,80,0.07)',
      linecolor: 'rgba(30,40,80,0.15)',
      tickfont: { color: '#475569', size: 10 },
      // Invert y so high pressure (surface) is at the bottom
      autorange: isVertProfile ? 'reversed' : true,
    },
    margin: { t: 40, b: isVertProfile ? 40 : 65, l: 60, r: 14 },
    autosize: true,
    // Explicit height drives the Plotly canvas to match the window orientation
    height: isVertProfile ? 440 : 260,
    showlegend: true,
  };
}

function _addClickMarker(x, y, color) {
  try {
    Plotly.addTraces('plotly-div', {
      type: 'scatter',
      mode: 'markers',
      x: [x], y: [y],
      marker: { size: 9, color, symbol: 'cross-thin-open', line: { color, width: 2.5 } },
      showlegend: false,
      hoverinfo: 'skip',   // pass hover through to the heatmap beneath
      name: '',
    });
  } catch (_) { }
}

/** Close and destroy one axis window. */
function closeAxisWin(axisKey) {
  const win = _axisWins.get(axisKey);
  if (!win) return;
  try { Plotly.purge(win.plotDivId); } catch (_) { }
  win.winEl.remove();
  _axisWins.delete(axisKey);
}

/** Clear traces from one axis window (keeps window open). */
function clearAxisWin(axisKey) {
  const win = _axisWins.get(axisKey);
  if (!win) return;
  win.traces = []; win.initialized = false; win.colorIdx = 0;
  win.axisName = null; win.axisUnits = null; win.units = null;
  try { Plotly.purge(win.plotDivId); } catch (_) { }
  const titleEl = document.getElementById(`${win.winEl.id}-title`);
  if (titleEl) titleEl.textContent = `Location Series — ${axisKey}`;
  _removeAllClickMarkers();
}

/** Clear ALL axis windows and click markers on the map. */
function clearLocSeries() {
  for (const key of [..._axisWins.keys()]) closeAxisWin(key);
  _winCount = 0;
  _removeAllClickMarkers();
}

function _removeAllClickMarkers() {
  try {
    const gd = $('plotly-div');
    if (!gd || !gd.data) return;
    const idx = gd.data
      .map((t, i) => (t.mode === 'markers' && t.showlegend === false && t.name === '') ? i : -1)
      .filter(i => i >= 0).reverse();
    idx.forEach(i => Plotly.deleteTraces('plotly-div', i));
  } catch (_) { }
}

// Legacy aliases kept so any existing call sites still work
function closeLocSeries() { clearLocSeries(); }

// Drag & resize is now attached per-window in _attachDragResize() above.

async function plotTimeSeries(idx) {
  showLoading('Computing spatial mean…');
  try {
    const result = await apiFetch('/api/timeseries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cube_index: idx }),
    });

    const cube = STATE.cubes[idx];
    const traces = [
      // Shaded fill under the line
      {
        type: 'scatter',
        mode: 'none',
        x: result.time,
        y: result.values,
        fill: 'tozeroy',
        fillcolor: 'rgba(37,99,235,0.08)',
        showlegend: false,
        hoverinfo: 'none',
        name: '',
      },
      // Main line
      {
        type: 'scatter',
        mode: 'lines+markers',
        x: result.time,
        y: result.values,
        line: { color: '#2563eb', width: 2.5, shape: 'spline', smoothing: 0.6 },
        marker: { size: 5, color: '#ffffff', line: { color: '#2563eb', width: 2 } },
        name: result.name,
      },
    ];

    const layout = {
      title: {
        text: `${result.name} – spatial mean  [${result.units}]`,
        font: { family: 'Inter', size: 14, color: '#0f172a', weight: 600 },
        x: 0.04,
      },
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#f8faff',
      font: { family: 'Inter', color: '#475569', size: 11 },
      xaxis: {
        title: { text: 'Time', font: { color: '#475569', size: 11 } },
        gridcolor: 'rgba(30,40,80,0.07)',
        linecolor: 'rgba(30,40,80,0.15)',
        tickcolor: 'rgba(30,40,80,0.15)',
        tickfont: { color: '#475569' },
        tickangle: -35,
        zerolinecolor: 'rgba(30,40,80,0.20)',
      },
      yaxis: {
        title: { text: result.units, font: { color: '#475569', size: 11 } },
        gridcolor: 'rgba(30,40,80,0.07)',
        linecolor: 'rgba(30,40,80,0.15)',
        tickcolor: 'rgba(30,40,80,0.15)',
        tickfont: { color: '#475569' },
        zerolinecolor: 'rgba(30,40,80,0.20)',
        rangemode: 'tozero',
      },
      margin: { t: 50, b: 100, l: 72, r: 30 },
      autosize: true,
      height: getPlotHeight(),
      showlegend: false,
    };

    $('plot-title-bar').textContent = `${result.name} — time series`;
    setPlotMode(true);
    $('plot-area').classList.remove('hidden');
    document.querySelector('.plot-toolbar').classList.remove('hidden');
    $('plotly-div').classList.remove('hidden');
    $('welcome-screen').classList.add('hidden');

    await nextFrame();
    Plotly.newPlot('plotly-div', traces, layout, { responsive: true, displaylogo: false });
    await nextFrame();
    Plotly.relayout('plotly-div', { height: getPlotHeight() });
    Plotly.Plots.resize('plotly-div');
    // Time series: hide stats bar (slice stats don't apply to spatial-mean plots)
    $('stats-bar').classList.add('hidden');
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
  STATE.selectedIdx = null;
  document.querySelectorAll('.var-item').forEach(el => el.classList.remove('selected'));
  const sliders = $('dim-sliders');
  if (sliders) sliders.innerHTML = '';
  const cards = $('cube-cards');
  if (cards) cards.innerHTML = '';
  $('plot-area').classList.add('hidden');
  $('stats-bar').classList.add('hidden');
  setPlotMode(false);
  $('welcome-screen').classList.remove('hidden');
}
function downloadPlot() { Plotly.downloadImage('plotly-div', { format: 'png', scale: 2, filename: 'viewnc_plot' }); }

// ── Statistics bar ────────────────────────────────────────────────────────────

/**
 * Non-blocking fetch of slice statistics.  Populates the stats bar below the
 * plot; silently swallows errors so it never disrupts the main render path.
 */
async function fetchAndRenderStats() {
  if (STATE.selectedIdx === null) return;
  try {
    const s = await apiFetch('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cube_index: STATE.selectedIdx, constraints: STATE.constraints }),
    });
    renderStatsBar(s);
  } catch (_) {
    // Stats are best-effort — don't break the UI on failure
    $('stats-bar').classList.add('hidden');
  }
}

/**
 * Populate and reveal the stats bar with the server-computed statistics.
 * @param {Object} s  Response from /api/stats
 */
function renderStatsBar(s) {
  const bar = $('stats-bar');
  const pills = $('stats-pills');
  const badge = $('stats-masked-badge');
  if (!bar || !pills || !badge) return;

  /** Format a number with 4 significant figures, falling back to '—'. */
  function fmt(v) {
    if (v === null || v === undefined) return '—';
    const abs = Math.abs(v);
    if (abs === 0) return '0';
    if (abs >= 1e4 || abs < 1e-3) return v.toExponential(3);
    if (abs >= 100) return v.toFixed(2);
    if (abs >= 10) return v.toFixed(3);
    return v.toPrecision(4);
  }

  const units = s.units ? ` ${s.units}` : '';
  const PILLS = [
    { key: 'min', label: 'Min', cls: 'pill-min' },
    { key: 'mean', label: 'Mean', cls: 'pill-mean' },
    { key: 'median', label: 'Median', cls: '' },
    { key: 'max', label: 'Max', cls: 'pill-max' },
    { key: 'std', label: 'Std', cls: 'pill-std' },
    { key: 'p5', label: 'P5', cls: '' },
    { key: 'p95', label: 'P95', cls: '' },
  ];

  pills.innerHTML = PILLS.map(p => `
    <div class="stat-pill ${p.cls}" title="${p.label}: ${fmt(s[p.key])}${units}">
      <span class="stat-pill-label">${p.label}</span>
      <span class="stat-pill-value">${fmt(s[p.key])}</span>
    </div>
  `).join('');

  // Coverage badge
  const pct = s.pct_masked ?? 0;
  const coverage = (100 - pct).toFixed(1);
  const n = s.count_valid?.toLocaleString() ?? '?';
  const total = s.count_total?.toLocaleString() ?? '?';
  badge.textContent = `${coverage}% valid  (${n} / ${total})`;
  badge.className = 'stats-masked-badge ' + (
    pct === 0 ? 'badge-ok-cov' :
      pct < 25 ? 'badge-warn-cov' :
        'badge-bad-cov'
  );

  bar.classList.remove('hidden');
}


/** Trigger a browser download from a blob URL and clean up. */
function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

/** Download the currently displayed 2-D slice as a CSV file. */
async function exportCSV() {
  if (STATE.selectedIdx === null) { alert('No variable selected.'); return; }
  try {
    const res = await fetch('/api/export/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cube_index: STATE.selectedIdx, constraints: STATE.constraints }),
    });
    if (!res.ok) { const j = await res.json(); throw new Error(j.error || `HTTP ${res.status}`); }
    const blob = await res.blob();
    // Try to read the Content-Disposition header for the server-chosen filename
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : 'viewnc_export.csv';
    _triggerDownload(blob, filename);
  } catch (err) {
    alert('CSV export failed: ' + err.message);
  }
}

/** Download the currently displayed 2-D slice as a NetCDF file. */
async function exportNetCDF() {
  if (STATE.selectedIdx === null) { alert('No variable selected.'); return; }
  try {
    const res = await fetch('/api/export/netcdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cube_index: STATE.selectedIdx, constraints: STATE.constraints }),
    });
    if (!res.ok) { const j = await res.json(); throw new Error(j.error || `HTTP ${res.status}`); }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : 'viewnc_export.nc';
    _triggerDownload(blob, filename);
  } catch (err) {
    alert('NetCDF export failed: ' + err.message);
  }
}

/** Download all currently plotted location series as a multi-column CSV. */
/** Export CSV for a specific axis window. Called from each window's button. */
async function exportAxisCSV(axisKey) {
  const win = _axisWins.get(axisKey);
  if (!win || !win.initialized || win.traces.length === 0) {
    alert('No series data to export for this axis.'); return;
  }
  const gd = document.getElementById(win.plotDivId);
  if (!gd || !gd.data || gd.data.length === 0) { alert('No series data found.'); return; }

  const cube = STATE.cubes.find(c => c.index === STATE.selectedIdx) ?? STATE.cubes[STATE.selectedIdx];
  const isVert = win.isVertProfile;
  const seriesPayload = gd.data.map((trace, i) => ({
    label: trace.name || `series_${i}`,
    axis_values: isVert ? trace.y : trace.x,
    values: isVert ? trace.x : trace.y,
  }));

  try {
    const res = await fetch('/api/export/series_csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        axis_name: win.axisName ?? 'index',
        axis_units: win.axisUnits ?? '',
        units: win.units ?? '',
        name: cube?.name ?? 'variable',
        series: seriesPayload,
      }),
    });
    if (!res.ok) { const j = await res.json(); throw new Error(j.error || `HTTP ${res.status}`); }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    _triggerDownload(blob, match ? match[1] : 'viewnc_series.csv');
  } catch (err) {
    alert('Series CSV export failed: ' + err.message);
  }
}

/** Legacy — export all windows sequentially. */
async function exportSeriesCSV() {
  if (_axisWins.size === 0) { alert('No location series to export.'); return; }
  for (const key of _axisWins.keys()) await exportAxisCSV(key);
}

/** Download the current series plot as a high-res PNG. */
function downloadAxisPNG(axisKey) {
  const win = _axisWins.get(axisKey);
  if (!win || !win.initialized) { alert('No plot to download yet.'); return; }
  const cube = STATE.cubes.find(c => c.index === STATE.selectedIdx) ?? STATE.cubes[STATE.selectedIdx];
  const safeName = (cube?.name || 'series').replace(/\s+/g, '_');
  const safeAxis = axisKey.replace(/\s+/g, '_');
  Plotly.downloadImage(win.plotDivId, {
    format: 'png',
    filename: `viewnc_${safeName}_${safeAxis}_series`,
    width: win.isVertProfile ? 680 : 1040,
    height: win.isVertProfile ? 960 : 560,
    scale: 2,
  });
}

/** Export the series data as a NetCDF file via the backend. */
async function exportAxisNetCDF(axisKey) {
  const win = _axisWins.get(axisKey);
  if (!win || !win.initialized || win.traces.length === 0) {
    alert('No series data to export for this axis.'); return;
  }
  const gd = document.getElementById(win.plotDivId);
  if (!gd || !gd.data || gd.data.length === 0) { alert('No series data found.'); return; }

  const cube = STATE.cubes.find(c => c.index === STATE.selectedIdx) ?? STATE.cubes[STATE.selectedIdx];
  const isVert = win.isVertProfile;
  const seriesPayload = gd.data.map((trace, i) => ({
    label: trace.name || `series_${i}`,
    axis_values: isVert ? trace.y : trace.x,
    values: isVert ? trace.x : trace.y,
  }));

  try {
    showLoading('Exporting NetCDF…');
    const res = await fetch('/api/export/series_netcdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        axis_name: win.axisName ?? 'index',
        axis_units: win.axisUnits ?? '',
        units: win.units ?? '',
        name: cube?.name ?? 'variable',
        series: seriesPayload,
      }),
    });
    hideLoading();
    if (!res.ok) {
      const text = await res.text();
      let errMsg;
      try { errMsg = JSON.parse(text).error; } catch (_) { errMsg = null; }
      throw new Error(errMsg || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    _triggerDownload(blob, match ? match[1] : 'viewnc_series.nc');
  } catch (err) {
    hideLoading();
    alert('Series NetCDF export failed: ' + err.message);
  }
}

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
