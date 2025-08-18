// Utilities
function parseDate(d) {
  return d ? new Date(d) : null;
}

function daysBetween(a, b) {
  if (!a || !b) return 0;
  const ms = (b - a);
  return Math.max(0, Math.ceil(ms / 86400000));
}

function currencyFmt(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function percentFmt(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return `${(Math.round(n * 100) / 100).toFixed(2)}%`;
}

let ALL_ROWS = [];
let FILTERS = { fases: [], estados: [], palette: {} };
let CURRENT_FIGURE = null;

async function loadData() {
  const res = await fetch(`/api/data/${uploadId}`);
  const data = await res.json();
  ALL_ROWS = data.rows;
  FILTERS.fases = data.filters.fases;
  FILTERS.estados = data.filters.estados;
  FILTERS.palette = data.paletaEstados;

  // Populate UI filters
  const faseSel = document.getElementById('faseFilter');
  FILTERS.fases.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f; opt.textContent = f;
    faseSel.appendChild(opt);
  });
  const estadoSel = document.getElementById('estadoFilter');
  FILTERS.estados.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e; opt.textContent = e;
    estadoSel.appendChild(opt);
  });

  await loadDashboard();
  renderGantt(ALL_ROWS);
  setupResizeObserver();
}

async function loadDashboard() {
  const res = await fetch(`/api/dashboard/${uploadId}`);
  const d = await res.json();
  document.getElementById('kpiTareas').textContent = d.totales.tareas;
  document.getElementById('kpiOnTime').textContent = d.porcentajes.completadasATiempo + '%';
  document.getElementById('kpiDelayedDone').textContent = d.porcentajes.completadasConRetraso + '%';
  document.getElementById('kpiSobrecosto').textContent = currencyFmt(d.sobrecostoTotalUSD);
  document.getElementById('kpiRiesgo').textContent = d.riesgoPromedioPct + '%';
}

function containerHeight() {
  const el = document.getElementById('gantt');
  // si no hay altura definida en CSS, caemos en 620px
  return (el && el.clientHeight ? el.clientHeight : 620);
}

function themeColors() {
  // Toma colores del tema (CSS variables)
  const cs = getComputedStyle(document.body);
  return {
    bg: cs.getPropertyValue('--card-bg').trim() || 'white',
    fg: cs.getPropertyValue('--text').trim() || '#111'
  };
}

function buildTraces(rows) {
  // Sort rows by planned start
  const sorted = [...rows].sort((a, b) => {
    const ad = parseDate(a.InicioPlan) || new Date(0);
    const bd = parseDate(b.InicioPlan) || new Date(0);
    return ad - bd || String(a.ID).localeCompare(String(b.ID));
  });

  const y = sorted.map(r => `${r.ID} — ${r.Tarea}`);

  // Planned bars
  const x_plan = [];
  const base_plan = [];
  const hover_plan = [];
  for (const r of sorted) {
    const sp = parseDate(r.InicioPlan);
    const ep = parseDate(r.FinPlan);
    const dur = (sp && ep) ? (ep - sp) : 0;
    x_plan.push(dur);
    base_plan.push(sp || null);
    hover_plan.push(
      `<b>${r.Tarea}</b><br>` +
      `Plan: ${r.InicioPlan || '—'} → ${r.FinPlan || '—'}`
    );
  }
  const tracePlan = {
    type: 'bar',
    orientation: 'h',
    y: y,
    x: x_plan,
    base: base_plan,
    marker: { color: '#95a5a6' },
    name: 'Planificado',
    hovertemplate: hover_plan,
    opacity: 0.5
  };

  // Real bars with estado coloring
  const x_real = [];
  const base_real = [];
  const text_real = [];
  const marker_color = [];
  const hover_real = [];
  const todayISO = (new Date()).toISOString().slice(0,10);
  for (const r of sorted) {
    const sr = parseDate(r.InicioReal);
    let er = parseDate(r.FinReal);
    if (!er && r.InicioReal) er = new Date(); // "today"
    const dur = (sr && er) ? (er - sr) : 0;
    x_real.push(dur);
    base_real.push(sr || null);  // eje fecha -> null si no hay inicio real
    text_real.push(r.EstadoAuto);
    marker_color.push(FILTERS.palette[r.EstadoAuto] || '#ffffff');
    const retraso = (r.RetrasoDias != null) ? r.RetrasoDias : '—';
    const sob = (r.SobrecostoAuto != null) ? currencyFmt(r.SobrecostoAuto) : '—';
    hover_real.push(
      `<b>${r.Tarea}</b><br>` +
      `Real: ${r.InicioReal || '—'} → ${r.FinReal || todayISO}<br>` +
      `Estado: ${r.EstadoAuto}<br>` +
      `Avance: ${percentFmt(r.AvanceFisico)}<br>` +
      `Retraso: ${retraso} días<br>` +
      `Costo: ${currencyFmt(r.CostoPlan)} vs ${currencyFmt(r.CostoReal)}<br>` +
      `Sobrecosto: ${sob}`
    );
  }
  const traceReal = {
    type: 'bar',
    orientation: 'h',
    y: y,
    x: x_real,
    base: base_real,
    marker: { color: marker_color },
    name: 'Real',
    hovertemplate: hover_real
  };

  // Dependency arrows (shapes + annotations)
  const shapes = [];
  const annotations = [];
  for (const r of sorted) {
    const taskName = `${r.ID} — ${r.Tarea}`;
    const sp = parseDate(r.InicioPlan);
    for (const pred of (r.Predecesores || [])) {
      const predRow = sorted.find(x => String(x.ID) === String(pred));
      if (!predRow) continue;
      const predName = `${predRow.ID} — ${predRow.Tarea}`;
      const predEnd = parseDate(predRow.FinPlan);
      if (!sp || !predEnd) continue;
      shapes.push({
        type: 'line',
        xref: 'x',
        yref: 'y',
        x0: predEnd,
        y0: predName,
        x1: sp,
        y1: taskName,
        line: { width: 1, dash: 'dot', color: '#9ca3af' }
      });
      annotations.push({
        xref: 'x', yref: 'y',
        x: sp, y: taskName,
        showarrow: true, arrowhead: 3, arrowsize: 1, arrowwidth: 1, arrowcolor: '#9ca3af',
        axref: 'x', ayref: 'y', ax: predEnd, ay: predName,
        opacity: 0.7
      });
    }
  }

  const colors = themeColors();
  const layout = {
    barmode: 'overlay',
    bargap: 0.25,
    height: Math.max(400, containerHeight()),
    margin: { l: 220, r: 40, t: 20, b: 40 },
    xaxis: {
      type: 'date',
      title: 'Fecha',
      tickformat: '%d-%m-%Y'
    },
    yaxis: { automargin: true },
    shapes, annotations,
    legend: { orientation: 'h', y: -0.15 },
    paper_bgcolor: colors.bg,
    plot_bgcolor: colors.bg,
    font: { color: colors.fg }
  };

  return { data: [tracePlan, traceReal], layout: layout, config: { responsive: true } };
}

function renderGantt(rows) {
  const fig = buildTraces(rows);
  CURRENT_FIGURE = fig; // keep a reference for exports
  Plotly.newPlot('gantt', fig.data, fig.layout, fig.config);
}

function applyFilters() {
  const fFase = document.getElementById('faseFilter').value;
  const fEstado = document.getElementById('estadoFilter').value;
  const fRiesgoMin = parseFloat(document.getElementById('riesgoMin').value);
  const filtered = ALL_ROWS.filter(r => {
    const okFase = !fFase || (r.Fase === fFase);
    const okEstado = !fEstado || (r.EstadoAuto === fEstado);
    const riesgo = (r.RiesgoRetraso == null) ? -Infinity : r.RiesgoRetraso;
    const okRiesgo = isNaN(fRiesgoMin) ? true : (riesgo >= fRiesgoMin);
    return okFase && okEstado && okRiesgo;
  });
  renderGantt(filtered);
}

document.getElementById('applyFilters').addEventListener('click', applyFilters);
document.getElementById('clearFilters').addEventListener('click', () => {
  document.getElementById('faseFilter').value = '';
  document.getElementById('estadoFilter').value = '';
  document.getElementById('riesgoMin').value = '';
  renderGantt(ALL_ROWS);
});

// Exports using server-side Kaleido
async function postFigure(url, figure) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: figure.data, layout: figure.layout, config: {displayModeBar: false} })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Export failed: ${t}`);
  }
  return res;
}

document.getElementById('btnExportPNG').addEventListener('click', async () => {
  try {
    const res = await postFigure(`/api/export/image/${uploadId}?fmt=png`, CURRENT_FIGURE);
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'gantt.png'; document.body.appendChild(a); a.click();
    a.remove(); window.URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
});

document.getElementById('btnExportPDF').addEventListener('click', async () => {
  try {
    const res = await postFigure(`/api/export/image/${uploadId}?fmt=pdf`, CURRENT_FIGURE);
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'gantt.pdf'; document.body.appendChild(a); a.click();
    a.remove(); window.URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
});

document.getElementById('btnExportHTML').addEventListener('click', async () => {
  try {
    const res = await postFigure(`/api/export/html/${uploadId}`, CURRENT_FIGURE);
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'gantt_interactivo.html'; document.body.appendChild(a); a.click();
    a.remove(); window.URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
});

document.getElementById('btnExportExcel').addEventListener('click', async () => {
  window.location.href = `/api/export/excel/${uploadId}`;
});

// Mantener el gráfico ajustado al tamaño del contenedor/pantalla
function setupResizeObserver(){
  const el = document.getElementById('gantt');
  if (!el) return;
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => {
      if (CURRENT_FIGURE) Plotly.Plots.resize(el);
    });
    ro.observe(el);
  } else {
    window.addEventListener('resize', () => {
      if (CURRENT_FIGURE) Plotly.Plots.resize(el);
    });
  }
}

// Bootstrap
loadData().catch(e => alert('Error cargando datos: ' + e.message));
