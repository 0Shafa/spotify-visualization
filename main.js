/* Spotify Popularity Explorer (D3 v7)
   Views:
   - Scatter: Energy vs Popularity (brush selects subset)
   - Bar: Avg popularity by genre (click filters genre)
   - Line: Avg popularity by year
   - Heatmap: Pearson correlation of features on current subset
*/

const DATA_PATH = "data/spotify_clean.csv";

const FEATURES_FOR_HEATMAP = [
  "danceability",
  "energy",
  "loudness",
  "speechiness",
  "acousticness",
  "instrumentalness",
  "liveness",
  "valence",
  "tempo",
  "duration_ms",
  "popularity"
];

const fmt = {
  int: d3.format(",d"),
  num2: d3.format(".2f"),
  pct0: d3.format(".0%")
};

const els = {
  genreSelect: document.getElementById("genreSelect"),
  yearMin: document.getElementById("yearMin"),
  yearMax: document.getElementById("yearMax"),
  popMin: document.getElementById("popMin"),
  popMax: document.getElementById("popMax"),
  clearBrushBtn: document.getElementById("clearBrushBtn"),
  resetBtn: document.getElementById("resetBtn"),
  tooltip: d3.select("#tooltip"),
  status: document.getElementById("status"),
  scatterMeta: document.getElementById("scatterMeta"),
  barMeta: document.getElementById("barMeta"),
  lineMeta: document.getElementById("lineMeta"),
  heatMeta: document.getElementById("heatMeta"),
};

const state = {
  data: [],
  filtered: [],
  brushedIds: null,      // Set of ids or null
  genre: "All",
  yearMin: null,
  yearMax: null,
  popMin: 0,
  popMax: 100,
  // performance: cap plotted points for scatter; keep analysis on full filtered subset
  scatterMaxPoints: 12000
};

function setStatus(msg) { els.status.textContent = msg; }

function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function clamp(v, lo, hi) {
  const x = Number(v);
  if (Number.isNaN(x)) return null;
  return Math.max(lo, Math.min(hi, x));
}

function parseRow(d) {
  // must match preprocess.py output schema
  return {
    id: d.id,
    name: d.track_name,
    artist: d.track_artist,
    genre: d.genre,
    year: +d.year,
    popularity: +d.popularity,
    energy: +d.energy,
    danceability: +d.danceability,
    valence: +d.valence,
    tempo: +d.tempo,
    loudness: +d.loudness,
    speechiness: +d.speechiness,
    acousticness: +d.acousticness,
    instrumentalness: +d.instrumentalness,
    liveness: +d.liveness,
    duration_ms: +d.duration_ms
  };
}

function setControlsFromData(data) {
  const years = data.map(d => d.year).filter(Number.isFinite);
  const yMin = d3.min(years);
  const yMax = d3.max(years);

  state.yearMin = yMin;
  state.yearMax = yMax;

  els.yearMin.value = yMin;
  els.yearMax.value = yMax;

  els.popMin.value = 0;
  els.popMax.value = 100;

  const genres = Array.from(new Set(data.map(d => d.genre))).sort(d3.ascending);
  els.genreSelect.innerHTML = "";

  const optAll = document.createElement("option");
  optAll.value = "All";
  optAll.textContent = "All";
  els.genreSelect.appendChild(optAll);

  for (const g of genres) {
    const opt = document.createElement("option");
    opt.value = g;
    opt.textContent = g;
    els.genreSelect.appendChild(opt);
  }
  els.genreSelect.value = "All";
}

function applyFilters() {
  const base = state.data;

  const yrLo = state.yearMin;
  const yrHi = state.yearMax;
  const pLo = state.popMin;
  const pHi = state.popMax;

  let out = base.filter(d =>
    d.year >= yrLo && d.year <= yrHi &&
    d.popularity >= pLo && d.popularity <= pHi
  );

  if (state.genre !== "All") {
    out = out.filter(d => d.genre === state.genre);
  }

  // Apply brush subset if active
  if (state.brushedIds && state.brushedIds.size > 0) {
    out = out.filter(d => state.brushedIds.has(d.id));
  }

  state.filtered = out;
  setStatus(`Showing ${fmt.int(out.length)} tracks (filters + selection).`);
}

function topGenres(data, k = 10) {
  const roll = d3.rollups(data, v => ({
    n: v.length,
    avg: d3.mean(v, d => d.popularity)
  }), d => d.genre);

  roll.sort((a, b) => d3.descending(a[1].avg, b[1].avg));
  return roll.slice(0, k).map(([genre, stats]) => ({ genre, ...stats }));
}

function yearlyAvg(data) {
  const roll = d3.rollups(
    data,
    v => ({ n: v.length, avg: d3.mean(v, d => d.popularity) }),
    d => d.year
  );
  roll.sort((a, b) => d3.ascending(a[0], b[0]));
  return roll.map(([year, stats]) => ({ year: +year, ...stats }));
}

function pearsonCorr(x, y) {
  // Robust Pearson correlation
  const n = Math.min(x.length, y.length);
  if (n < 3) return NaN;

  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;

  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  if (!den) return NaN;
  return num / den;
}

function correlationMatrix(data, features) {
  // Build vectors once
  const cols = new Map();
  for (const f of features) cols.set(f, []);

  for (const d of data) {
    for (const f of features) {
      const val = d[f];
      if (Number.isFinite(val)) cols.get(f).push(val);
      else cols.get(f).push(NaN);
    }
  }

  // Align by filtering rows with NaNs for each pair
  const matrix = [];
  for (let i = 0; i < features.length; i++) {
    for (let j = 0; j < features.length; j++) {
      const a = features[i], b = features[j];
      const xa = cols.get(a);
      const yb = cols.get(b);
      const x = [], y = [];
      for (let k = 0; k < xa.length; k++) {
        const vx = xa[k], vy = yb[k];
        if (Number.isFinite(vx) && Number.isFinite(vy)) {
          x.push(vx); y.push(vy);
        }
      }
      matrix.push({ a, b, r: pearsonCorr(x, y) });
    }
  }
  return matrix;
}

/* ---------- Tooltip ---------- */

function showTooltip(html, clientX, clientY) {
  els.tooltip
    .style("opacity", 1)
    .style("left", `${clientX}px`)
    .style("top", `${clientY}px`)
    .attr("aria-hidden", "false")
    .html(html);
}
function hideTooltip() {
  els.tooltip
    .style("opacity", 0)
    .attr("aria-hidden", "true");
}

/* ---------- Chart base helpers ---------- */

function makeSVG(container, { width, height, margin }) {
  const root = d3.select(container);
  root.selectAll("*").remove();

  const w = width;
  const h = height;

  const svg = root.append("svg")
    .attr("width", w)
    .attr("height", h)
    .attr("viewBox", `0 0 ${w} ${h}`)
    .attr("role", "img");

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  return { svg, g, innerW: w - margin.left - margin.right, innerH: h - margin.top - margin.bottom };
}

function addGridlines(g, x, y, innerH, innerW) {
  g.append("g")
    .attr("class", "gridline")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(6).tickSize(-innerH).tickFormat(""));

  g.append("g")
    .attr("class", "gridline")
    .call(d3.axisLeft(y).ticks(6).tickSize(-innerW).tickFormat(""));
}

/* ---------- Scatter (Energy vs Popularity) ---------- */

function ScatterView(containerId) {
  const container = document.getElementById(containerId);
  const margin = { top: 14, right: 16, bottom: 40, left: 52 };

  let api = {};
  let currentBrush = null;

  api.render = (data, metaText = "") => {
    const rect = container.getBoundingClientRect();
    const width = Math.max(520, Math.floor(rect.width) - 20);
    const height = Math.max(380, Math.floor(rect.height) - 20);

    const { svg, g, innerW, innerH } = makeSVG(container, { width, height, margin });

    els.scatterMeta.textContent = metaText;

    // Plot cap for speed
    const plotData = data.length > state.scatterMaxPoints
      ? d3.shuffle(data.slice()).slice(0, state.scatterMaxPoints)
      : data;

    const x = d3.scaleLinear().domain([0, 1]).nice().range([0, innerW]);
    const y = d3.scaleLinear().domain([0, 100]).nice().range([innerH, 0]);

    addGridlines(g, x, y, innerH, innerW);

    const xAxis = g.append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(6));

    const yAxis = g.append("g")
      .attr("class", "axis")
      .call(d3.axisLeft(y).ticks(6));

    // Axis labels
    g.append("text")
      .attr("x", innerW / 2)
      .attr("y", innerH + 34)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.75)")
      .text("Energy (0–1)");

    g.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -innerH / 2)
      .attr("y", -38)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.75)")
      .text("Popularity (0–100)");

    // Color by genre for readability
    const genres = Array.from(new Set(plotData.map(d => d.genre))).sort(d3.ascending);
    const color = d3.scaleOrdinal()
      .domain(genres)
      .range(d3.schemeTableau10.concat(d3.schemeSet3).slice(0, Math.max(10, genres.length)));

    const points = g.append("g")
      .attr("class", "points")
      .selectAll("circle")
      .data(plotData, d => d.id)
      .join("circle")
      .attr("cx", d => x(d.energy))
      .attr("cy", d => y(d.popularity))
      .attr("r", 2.4)
      .attr("fill", d => color(d.genre))
      .attr("fill-opacity", 0.75)
      .attr("stroke", "rgba(0,0,0,0.25)")
      .attr("stroke-width", 0.4)
      .on("mousemove", (event, d) => {
        const html = `
          <div class="t-title">${escapeHtml(d.name)}</div>
          <div class="t-row"><b>Artist:</b> ${escapeHtml(d.artist)}</div>
          <div class="t-row"><b>Genre:</b> ${escapeHtml(d.genre)} | <b>Year:</b> ${d.year}</div>
          <div class="t-row"><b>Popularity:</b> ${d.popularity}</div>
          <div class="t-row">Energy ${fmt.num2(d.energy)} | Danceability ${fmt.num2(d.danceability)} | Valence ${fmt.num2(d.valence)}</div>
        `;
        showTooltip(html, event.clientX, event.clientY);
      })
      .on("mouseleave", hideTooltip);

    // Brush
    const brush = d3.brush()
      .extent([[0, 0], [innerW, innerH]])
      .on("start brush end", ({ selection }) => {
        currentBrush = selection;
        if (!selection) {
          state.brushedIds = null;
          dispatch();
          return;
        }

        const [[x0, y0], [x1, y1]] = selection;
        const ids = new Set();

        // Use plotData for selection ids. That is fine because selection reflects visible marks.
        for (const d of plotData) {
          const cx = x(d.energy);
          const cy = y(d.popularity);
          if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) ids.add(d.id);
        }

        state.brushedIds = ids.size ? ids : null;
        dispatch();
      });

    g.append("g").attr("class", "brush").call(brush);

    // If we already have a brush selection, try to keep it visually
    if (currentBrush) g.select(".brush").call(brush.move, currentBrush);

    api.clearBrush = () => {
      currentBrush = null;
      state.brushedIds = null;
      g.select(".brush").call(brush.move, null);
      dispatch();
    };
  };

  return api;
}

/* ---------- Bar (Avg popularity by genre) ---------- */

function BarView(containerId) {
  const container = document.getElementById(containerId);
  const margin = { top: 14, right: 10, bottom: 42, left: 58 };

  const api = {};
  api.render = (data, metaText = "") => {
    const rect = container.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width) - 20);
    const height = Math.max(320, Math.floor(rect.height) - 20);

    const { g, innerW, innerH } = makeSVG(container, { width, height, margin });

    els.barMeta.textContent = metaText;

    const bars = topGenres(data, 10);

    const x = d3.scaleLinear()
      .domain([0, d3.max(bars, d => d.avg) || 1])
      .nice()
      .range([0, innerW]);

    const y = d3.scaleBand()
      .domain(bars.map(d => d.genre))
      .range([0, innerH])
      .padding(0.15);

    g.append("g")
      .attr("class", "axis")
      .call(d3.axisLeft(y).tickSize(0))
      .selectAll("text")
      .style("font-size", "11px");

    g.append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(5));

    const barG = g.append("g");

    barG.selectAll("rect")
      .data(bars, d => d.genre)
      .join("rect")
      .attr("x", 0)
      .attr("y", d => y(d.genre))
      .attr("height", y.bandwidth())
      .attr("width", d => x(d.avg))
      .attr("rx", 6)
      .attr("fill", d => (state.genre === d.genre ? "rgba(255,255,255,0.60)" : "rgba(255,255,255,0.25)"))
      .attr("stroke", "rgba(255,255,255,0.15)")
      .on("click", (_, d) => {
        state.genre = (state.genre === d.genre) ? "All" : d.genre;
        els.genreSelect.value = state.genre;
        state.brushedIds = null; // optional: clear brush when genre changes for clarity
        dispatch();
      })
      .on("mousemove", (event, d) => {
        const html = `
          <div class="t-title">${escapeHtml(d.genre)}</div>
          <div class="t-row"><b>Avg popularity:</b> ${d3.format(".1f")(d.avg)}</div>
          <div class="t-row"><b>Tracks:</b> ${fmt.int(d.n)}</div>
        `;
        showTooltip(html, event.clientX, event.clientY);
      })
      .on("mouseleave", hideTooltip);

    barG.selectAll("text.value")
      .data(bars, d => d.genre)
      .join("text")
      .attr("class", "value")
      .attr("x", d => x(d.avg) + 6)
      .attr("y", d => y(d.genre) + y.bandwidth() / 2 + 4)
      .attr("fill", "rgba(255,255,255,0.75)")
      .style("font-family", "var(--mono)")
      .style("font-size", "11px")
      .text(d => d3.format(".1f")(d.avg));
  };

  return api;
}

/* ---------- Line (Avg popularity by year) ---------- */

function LineView(containerId) {
  const container = document.getElementById(containerId);
  const margin = { top: 14, right: 16, bottom: 40, left: 52 };
  const api = {};

  api.render = (data, metaText = "") => {
    const rect = container.getBoundingClientRect();
    const width = Math.max(520, Math.floor(rect.width) - 20);
    const height = Math.max(300, Math.floor(rect.height) - 20);

    const { g, innerW, innerH } = makeSVG(container, { width, height, margin });
    els.lineMeta.textContent = metaText;

    const series = yearlyAvg(data);
    const x = d3.scaleLinear()
      .domain(d3.extent(series, d => d.year) || [2000, 2020])
      .nice()
      .range([0, innerW]);

    const y = d3.scaleLinear()
      .domain([0, d3.max(series, d => d.avg) || 1])
      .nice()
      .range([innerH, 0]);

    addGridlines(g, x, y, innerH, innerW);

    g.append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(8).tickFormat(d3.format("d")));

    g.append("g")
      .attr("class", "axis")
      .call(d3.axisLeft(y).ticks(6));

    g.append("text")
      .attr("x", innerW / 2)
      .attr("y", innerH + 34)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.75)")
      .text("Release year");

    g.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -innerH / 2)
      .attr("y", -38)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.75)")
      .text("Avg popularity");

    const line = d3.line()
      .x(d => x(d.year))
      .y(d => y(d.avg))
      .curve(d3.curveMonotoneX);

    g.append("path")
      .datum(series)
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.78)")
      .attr("stroke-width", 2)
      .attr("d", line);

    // Optional points for tooltip
    g.append("g")
      .selectAll("circle")
      .data(series)
      .join("circle")
      .attr("cx", d => x(d.year))
      .attr("cy", d => y(d.avg))
      .attr("r", 3)
      .attr("fill", "rgba(255,255,255,0.55)")
      .attr("stroke", "rgba(0,0,0,0.3)")
      .attr("stroke-width", 0.6)
      .on("mousemove", (event, d) => {
        const html = `
          <div class="t-title">Year ${d.year}</div>
          <div class="t-row"><b>Avg popularity:</b> ${d3.format(".2f")(d.avg)}</div>
          <div class="t-row"><b>Tracks:</b> ${fmt.int(d.n)}</div>
        `;
        showTooltip(html, event.clientX, event.clientY);
      })
      .on("mouseleave", hideTooltip);
  };

  return api;
}

/* ---------- Heatmap (Correlation matrix) ---------- */

function HeatmapView(containerId) {
  const container = document.getElementById(containerId);
  const margin = { top: 70, right: 10, bottom: 10, left: 80 };
  const api = {};

  api.render = (data, metaText = "") => {
    const rect = container.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width) - 20);
    const height = Math.max(320, Math.floor(rect.height) - 20);

    const { g, innerW, innerH } = makeSVG(container, { width, height, margin });
    els.heatMeta.textContent = metaText;

    const features = FEATURES_FOR_HEATMAP;

    const matrix = correlationMatrix(data, features);

    const x = d3.scaleBand().domain(features).range([0, innerW]).padding(0.05);
    const y = d3.scaleBand().domain(features).range([0, innerH]).padding(0.05);

    const color = d3.scaleDiverging()
      .domain([-1, 0, 1])
      .interpolator(d3.interpolateRdBu);

    // labels
    g.append("g")
      .selectAll("text")
      .data(features)
      .join("text")
      .attr("x", d => x(d) + x.bandwidth() / 2)
      .attr("y", -10)
      .attr("text-anchor", "start")
      .attr("transform", d => `translate(${x(d) + x.bandwidth() / 2}, -10) rotate(-45)`)
      .attr("fill", "rgba(255,255,255,0.75)")
      .style("font-size", "10px")
      .text(d => d);

    g.append("g")
      .selectAll("text")
      .data(features)
      .join("text")
      .attr("x", -10)
      .attr("y", d => y(d) + y.bandwidth() / 2 + 4)
      .attr("text-anchor", "end")
      .attr("fill", "rgba(255,255,255,0.75)")
      .style("font-size", "10px")
      .text(d => d);

    g.append("g")
      .selectAll("rect")
      .data(matrix, d => `${d.a}|${d.b}`)
      .join("rect")
      .attr("x", d => x(d.b))
      .attr("y", d => y(d.a))
      .attr("width", x.bandwidth())
      .attr("height", y.bandwidth())
      .attr("rx", 4)
      .attr("fill", d => Number.isFinite(d.r) ? color(d.r) : "rgba(255,255,255,0.08)")
      .attr("stroke", "rgba(255,255,255,0.12)")
      .on("mousemove", (event, d) => {
        const r = Number.isFinite(d.r) ? d3.format(".3f")(d.r) : "NA";
        const html = `
          <div class="t-title">Correlation</div>
          <div class="t-row"><b>${escapeHtml(d.a)}</b> vs <b>${escapeHtml(d.b)}</b></div>
          <div class="t-row"><b>r:</b> ${r}</div>
        `;
        showTooltip(html, event.clientX, event.clientY);
      })
      .on("mouseleave", hideTooltip);
  };

  return api;
}

/* ---------- Utility ---------- */

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[m]));
}

/* ---------- Wiring ---------- */

const scatter = ScatterView("scatter");
const bar = BarView("bar");
const line = LineView("line");
const heat = HeatmapView("heatmap");

const dispatch = debounce(() => {
  applyFilters();

  const f = state.filtered;
  const meta = {
    count: f.length,
    years: `${state.yearMin}–${state.yearMax}`,
    pop: `${state.popMin}–${state.popMax}`,
    genre: state.genre,
    brushed: state.brushedIds ? fmt.int(state.brushedIds.size) : "none"
  };

  scatter.render(f, `Tracks: ${fmt.int(meta.count)} | Genre: ${meta.genre} | Years: ${meta.years} | Pop: ${meta.pop} | Selection: ${meta.brushed}`);
  bar.render(f, `Subset: ${fmt.int(meta.count)} tracks`);
  line.render(f, `Subset: ${fmt.int(meta.count)} tracks`);
  heat.render(f, `Subset: ${fmt.int(meta.count)} tracks`);

}, 120);

function bindUI() {
  els.genreSelect.addEventListener("change", () => {
    state.genre = els.genreSelect.value || "All";
    state.brushedIds = null;
    dispatch();
  });

  const onYearChange = () => {
    const lo = clamp(els.yearMin.value, -9999, 9999);
    const hi = clamp(els.yearMax.value, -9999, 9999);
    if (lo === null || hi === null) return;
    state.yearMin = Math.min(lo, hi);
    state.yearMax = Math.max(lo, hi);
    state.brushedIds = null;
    dispatch();
  };

  const onPopChange = () => {
    const lo = clamp(els.popMin.value, 0, 100);
    const hi = clamp(els.popMax.value, 0, 100);
    if (lo === null || hi === null) return;
    state.popMin = Math.min(lo, hi);
    state.popMax = Math.max(lo, hi);
    state.brushedIds = null;
    dispatch();
  };

  els.yearMin.addEventListener("input", debounce(onYearChange, 180));
  els.yearMax.addEventListener("input", debounce(onYearChange, 180));
  els.popMin.addEventListener("input", debounce(onPopChange, 180));
  els.popMax.addEventListener("input", debounce(onPopChange, 180));

  els.clearBrushBtn.addEventListener("click", () => {
    if (scatter.clearBrush) scatter.clearBrush();
    else {
      state.brushedIds = null;
      dispatch();
    }
  });

  els.resetBtn.addEventListener("click", () => {
    state.genre = "All";
    els.genreSelect.value = "All";
    state.yearMin = d3.min(state.data, d => d.year);
    state.yearMax = d3.max(state.data, d => d.year);
    state.popMin = 0;
    state.popMax = 100;

    els.yearMin.value = state.yearMin;
    els.yearMax.value = state.yearMax;
    els.popMin.value = 0;
    els.popMax.value = 100;

    state.brushedIds = null;
    dispatch();
  });

  // Hide tooltip on scroll
  window.addEventListener("scroll", hideTooltip, { passive: true });
  window.addEventListener("resize", debounce(() => dispatch(), 250));
}

async function init() {
  setStatus("Loading data...");
  const raw = await d3.csv(DATA_PATH, parseRow);

  // basic sanity checks
  const cleaned = raw.filter(d =>
    d.id && d.genre &&
    Number.isFinite(d.year) &&
    Number.isFinite(d.popularity) &&
    Number.isFinite(d.energy)
  );

  state.data = cleaned;

  setControlsFromData(state.data);
  bindUI();

  setStatus(`Loaded ${fmt.int(state.data.length)} tracks.`);
  dispatch();
}

init().catch(err => {
  console.error(err);
  setStatus("Failed to load data. Check console and file paths.");
});
