// Utilities
function parseDate(d) {
  return d ? new Date(d) : null;
}

function formatDateISO(date) {
  if (!date) return null;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
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
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);

  const enriched = rows.map(row => ({
    row,
    planStart: parseDate(row.InicioPlan),
    planEnd: parseDate(row.FinPlan),
    realStart: parseDate(row.InicioReal),
    realEnd: parseDate(row.FinReal),
    delayExcel: (row.DiasRetrasoExcel === null || row.DiasRetrasoExcel === undefined || isNaN(row.DiasRetrasoExcel))
      ? null
      : Number(row.DiasRetrasoExcel)
  }));

  // Drop tasks that don't have enough information to render
  const candidates = enriched.filter(item => (
    (item.planStart && item.planEnd) ||
    item.realStart ||
    (item.planStart && item.delayExcel !== null)
  ));

  // Keep order consistent and stable
  const sorted = [...candidates].sort((a, b) => {
    const ad = a.planStart || a.realStart || a.planEnd || a.realEnd;
    const bd = b.planStart || b.realStart || b.planEnd || b.realEnd;
    if (!ad && !bd) {
      return String(a.row.ID).localeCompare(String(b.row.ID));
    }
    if (!ad) return 1;
    if (!bd) return -1;
    const diff = ad - bd;
    if (diff !== 0) return diff;
    return String(a.row.ID).localeCompare(String(b.row.ID));
  });

  const y = sorted.map(item => `${item.row.ID} — ${item.row.Tarea}`);

  // Planned bars
  const x_plan = [];
  const base_plan = [];
  const hover_plan = [];
  for (const item of sorted) {
    const { row: r, planStart: sp, planEnd: ep } = item;
    let dur = null;
    if (sp && ep) {
      dur = Math.max(ep - sp, 0);
    }
    x_plan.push(dur);
    base_plan.push(dur !== null ? sp : null);
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
  for (const item of sorted) {
    const { row: r } = item;
    const delayDays = Number.isFinite(item.delayExcel) ? Math.max(0, Math.round(item.delayExcel)) : null;
    const isPending = r.EstadoAuto === 'Pendiente' && !item.realStart && !item.realEnd;
    let sr = item.realStart || item.planStart || null;
    let er = item.realEnd ? new Date(item.realEnd.getTime()) : null;

    if (!er) {
      if (delayDays !== null) {
        if (isPending && sr) {
          // Pending tasks should only display the recorded delay span.
          er = new Date(sr.getTime());
          er.setDate(er.getDate() + delayDays);
        } else if (item.planEnd) {
          er = new Date(item.planEnd.getTime());
          er.setDate(er.getDate() + delayDays);
        } else if (sr) {
          er = new Date(sr.getTime());
          er.setDate(er.getDate() + delayDays);
        }
      } else if (sr) {
        // Without recorded delay use today to show current progress window
        const todayOrStart = Math.max(today.getTime(), sr.getTime());
        er = new Date(todayOrStart);
      }
    }

    // If there is still no sensible start but we do have a planned start, reuse it
    if (!sr && item.planStart) {
      sr = item.planStart;
    }

    // For pending tasks with zero recorded delay, make the bar visible for today.
    if (!er && isPending && sr) {
      const todayOrStart = Math.max(today.getTime(), sr.getTime());
      er = new Date(todayOrStart);
    }

    let dur = null;
    if (sr && er) {
      dur = Math.max(er.getTime() - sr.getTime(), 0);
      if (dur === 0) {
        // ensure bars for same-day tasks still render with width
        dur = 24 * 60 * 60 * 1000;
      }
    }
    x_real.push(dur);
    base_real.push(dur !== null ? sr : null);  // eje fecha -> null si no hay inicio real
    text_real.push(r.EstadoAuto);
    marker_color.push(FILTERS.palette[r.EstadoAuto] || '#ffffff');
    const retraso = (r.RetrasoDias != null) ? r.RetrasoDias : '—';
    const retrasoExcel = (r.DiasRetrasoExcel != null) ? r.DiasRetrasoExcel : '—';
    const sob = (r.SobrecostoAuto != null) ? currencyFmt(r.SobrecostoAuto) : '—';
    const startDisplay = r.InicioReal || (sr ? formatDateISO(sr) : '—');
    const endDisplay = r.FinReal || (er ? formatDateISO(er) : (sr ? todayISO : '—'));
    hover_real.push(
      `<b>${r.Tarea}</b><br>` +
      `Real: ${startDisplay} → ${endDisplay}<br>` +
      `Estado: ${r.EstadoAuto}<br>` +
      `Avance: ${percentFmt(r.AvanceFisico)}<br>` +
      `Retraso (auto): ${retraso} días<br>` +
      `Retraso registrado: ${retrasoExcel} días<br>` +
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
  for (const item of sorted) {
    const { row: r, planStart: sp } = item;
    const taskName = `${r.ID} — ${r.Tarea}`;
    for (const pred of (r.Predecesores || [])) {
      const predItem = sorted.find(x => String(x.row.ID) === String(pred));
      if (!predItem) continue;
      const predName = `${predItem.row.ID} — ${predItem.row.Tarea}`;
      const predEnd = predItem.planEnd;
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

  shapes.push({
    type: 'line',
    xref: 'x',
    yref: 'paper',
    x0: todayISO,
    y0: 0,
    x1: todayISO,
    y1: 1,
    line: { color: '#34495e', width: 2, dash: 'dash' }
  });
  annotations.push({
    xref: 'x',
    yref: 'paper',
    x: todayISO,
    y: 1.02,
    text: 'Hoy',
    showarrow: false,
    font: { color: '#34495e', size: 12 }
  });

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
    yaxis: { automargin: true, autorange: 'reversed' },
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
