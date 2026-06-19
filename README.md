# viewnc

**Interactive iris data viewer** for NetCDF, PP and GRIB files — powered by Python `iris` and `Plotly.js`.

![viewnc screenshot](docs/screenshot.png)

*Average Monthly Rate of Precipitation (mm/day) plotted as an interactive heatmap with Natural Earth coastlines overlaid. Loaded via the built-in file browser.*

---

## Quick Start

```bash
# Install (once)
pip install -e /path/to/viewnc

# Open a file directly — browser opens automatically
viewnc /path/to/data.nc

# Or start the server and use the built-in file browser
viewnc --port 5765
```

Browser opens at **http://127.0.0.1:5765** automatically.

---

## Features

| Feature | Details |
|---|---|
| **File formats** | NetCDF4, PP, GRIB2 (via `iris`) |
| **File browser** | Server-side filesystem browser with breadcrumb navigation, file size & date metadata, type-to-filter |
| **Variable browser** | Lists all cubes with shape, units and coordinate summary |
| **2D Heatmap** | Interactive Plotly heatmap with hover, zoom and pan |
| **2D Contour** | Filled contour with contour labels |
| **Time Series** | Spatial-mean time series collapsed over lat/lon |
| **Line / Profile** | Cross-section line plot through the middle row |
| **Dimension sliders** | Slider for each non-spatial dimension (time, level, ensemble …) |
| **Colormaps** | RdBu_r, Viridis, Plasma, Inferno, YlOrRd, Blues, Greens, Greys, Hot, Jet |
| **Coastlines** | Natural Earth overlay at 110 m / 50 m / 10 m resolution; selectable line colour |
| **Aspect ratio** | Lat/lon plots automatically lock to 1°lat = 1°lon (equirectangular) |
| **Variable detail** | Full coordinate & attribute modal (click any cube card) |
| **PNG export** | One-click PNG download of the current plot |

---

## Usage

1. Launch `viewnc` — the browser opens automatically.
2. Click **📁** to browse the filesystem, or paste a file path and press **Load**.
3. Click a variable in the **Variables** list to select it.
4. Use **Dimension Selectors** sliders to pick a time step or level.
5. Choose a **Plot Type** and **Colormap**.
6. Toggle **Coastlines** on/off; select resolution and line colour.
7. Click **Plot**. Use Plotly's toolbar to zoom, pan or download PNG.

---

## Dependencies

| Package | Purpose |
|---|---|
| `iris >= 3` | Climate data loading and slicing |
| `flask >= 3` | Lightweight web server |
| `numpy` | Array operations |
| `cartopy` | Natural Earth coastline geometries |
| `matplotlib` | Iris back-end (required by iris) |

Frontend: **Plotly.js 2.35** (loaded via CDN), **Google Fonts** (Inter, JetBrains Mono).

---

## Project Structure

```
viewnc/
├── viewnc/
│   ├── app.py          # Flask routes: /api/load, /api/slice, /api/browse, /api/coastlines …
│   ├── iris_loader.py  # Iris loading, slice extraction, coordinate resolution
│   ├── cli.py          # viewnc command-line entry point
│   ├── static/
│   │   ├── app.js      # Frontend logic (Plotly, file browser, coastline overlay)
│   │   └── style.css   # Dark glassmorphism design system
│   └── templates/
│       └── index.html  # Single-page application shell
├── docs/
│   └── screenshot.png  # UI screenshot
├── setup.py
└── README.md
```

---

## Installation (development)

```bash
git clone git@github.com:princekx/viewnc.git
cd viewnc
pip install -e .
```
