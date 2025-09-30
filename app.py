#!/usr/bin/env python3
import io
import json
import uuid
import re
from datetime import datetime, date
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from flask import (
    Flask, render_template, request, redirect, url_for,
    jsonify, send_file, session, flash
)
import plotly.io as pio

app = Flask(__name__)
app.config["SECRET_KEY"] = "change-me-in-production"
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20MB upload limit

# In-memory storage for uploaded/processed datasets (simple for demo)
DATASETS = {}

REQUIRED_COLUMNS = [
    "ID", "Tarea", "Inicio Planificado", "Fin Planificado",
    "Predecesor", "Inicio Real", "Fin Real"
]

# Color mapping for estados (front-end will use same palette)
ESTADO_COLORS = {
    "Completada a tiempo": "#2ecc71",         # 🟢
    "Completada anticipadamente": "#f1c40f",  # 🟡
    "Completada con retraso": "#e74c3c",      # 🔴
    "En progreso (a tiempo)": "#e67e22",      # 🟠
    "En progreso (atrasada)": "#c0392b",      # 🟥
    "Pendiente": "#ecf0f1"                    # ⚪
}

# -------------------- Utils --------------------
def _today_cl(date_tz: str = "America/Santiago") -> date:
    """Project rules: work with date only, using user's TZ for 'today'."""
    return datetime.now(ZoneInfo(date_tz)).date()

def _parse_date_series(s: pd.Series) -> pd.Series:
    if s is None:
        return pd.Series([pd.NaT] * 0, dtype="datetime64[ns]")
    # Coerce with dayfirst; then take only date (strip time)
    return pd.to_datetime(s, errors="coerce", dayfirst=True).dt.date

_money_re = re.compile(r"[^\d\-,\.]")
_percent_re = re.compile(r"[^\d\-,\.]")

def _to_float(v):
    """Tolerant number parser: handles $, %, commas, dots, blanks."""
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return np.nan
    if isinstance(v, (int, float, np.number)):
        return float(v)
    # Strings
    s = str(v).strip()
    if s == "":
        return np.nan
    # replace locale comma decimal -> dot
    s_clean = _money_re.sub("", s)
    # if both comma and dot exist, assume comma as thousand sep -> remove commas
    if "," in s_clean and "." in s_clean:
        s_clean = s_clean.replace(",", "")
    else:
        # if only comma, treat as decimal
        s_clean = s_clean.replace(",", ".")
    try:
        return float(s_clean)
    except:
        return np.nan

def _to_percent_0_100(v):
    """Return percentage in 0..100 (e.g., '35%', 0.35, 35 -> 35)."""
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return np.nan
    if isinstance(v, (int, float, np.number)):
        # if <=1, assume fraction
        return float(v) * 100.0 if v <= 1.0 else float(v)
    s = str(v).strip()
    if s == "":
        return np.nan
    s = _percent_re.sub("", s)
    if "," in s and "." in s:
        s = s.replace(",", "")
    else:
        s = s.replace(",", ".")
    try:
        val = float(s)
    except:
        return np.nan
    # if typical percent with % removed earlier, guess scale:
    return val * 100.0 if val <= 1.0 else val

def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    return df

def _validate_columns(df: pd.DataFrame) -> list[str]:
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    return missing

def _split_predecessors(val) -> list[str]:
    if pd.isna(val):
        return []
    if isinstance(val, (int, float)) and not pd.isna(val):
        return [str(int(val))]
    text = str(val)
    # Split by comma/semicolon/space
    parts = []
    for token in text.replace(";", ",").split(","):
        token = token.strip()
        if not token:
            continue
        # Some users separate by space
        subparts = token.split()
        for sp in subparts:
            sp = sp.strip()
            if sp:
                parts.append(sp)
    return parts

def _compute_estado(row, today: date) -> str:
    ini_r = row.get("Inicio Real")
    fin_r = row.get("Fin Real")
    fin_p = row.get("Fin Planificado")

    if pd.isna(ini_r):
        return "Pendiente"
    if pd.isna(fin_r):
        # In progress
        if not pd.isna(fin_p) and today <= fin_p:
            return "En progreso (a tiempo)"
        else:
            return "En progreso (atrasada)"
    # Completed
    if not pd.isna(fin_p):
        if fin_r < fin_p:
            return "Completada anticipadamente"
        elif fin_r == fin_p:
            return "Completada a tiempo"
        else:
            return "Completada con retraso"
    # If no planned finish to compare, default to completed on time
    return "Completada a tiempo"

# -------------------- Core processing --------------------
OPTIONAL_DEFAULTS = {
    "Fase": "",
    "Duración Planificada (días)": np.nan,
    "Costo Planificado (USD)": np.nan,
    "Riesgo de Retraso (%)": np.nan,
    "Estado": "",
    "Duración Real (días)": np.nan,
    "% Avance Físico": np.nan,
    "Costo Real (USD)": np.nan,
    "Retraso (días)": np.nan,
    "Sobrecosto (USD)": np.nan,
    "Causa de Retraso": "",
    "Observaciones": "",
    "Días de Retraso": np.nan,
    "Buffer sugerido (días)": np.nan,
}

def _coerce_types(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    # Dates to date
    for col in ["Inicio Planificado", "Fin Planificado", "Inicio Real", "Fin Real"]:
        if col in df.columns:
            df[col] = _parse_date_series(df[col])

    # IDs & Tarea as text
    df["ID"] = df["ID"].astype(str).str.strip()
    df["Tarea"] = df["Tarea"].astype(str).str.strip()

    # Numerics tolerant
    if "Costo Planificado (USD)" in df.columns:
        df["Costo Planificado (USD)"] = df["Costo Planificado (USD)"].apply(_to_float)
    if "Costo Real (USD)" in df.columns:
        df["Costo Real (USD)"] = df["Costo Real (USD)"].apply(_to_float)
    if "% Avance Físico" in df.columns:
        df["% Avance Físico"] = df["% Avance Físico"].apply(_to_percent_0_100)
    if "Riesgo de Retraso (%)" in df.columns:
        df["Riesgo de Retraso (%)"] = df["Riesgo de Retraso (%)"].apply(_to_percent_0_100)
    if "Días de Retraso" in df.columns:
        df["Días de Retraso"] = df["Días de Retraso"].apply(_to_float)

    # Ensure optional columns exist
    for col, default in OPTIONAL_DEFAULTS.items():
        if col not in df.columns:
            df[col] = default

    return df

def _recompute_derivatives(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    today = _today_cl()

    # Estado automático
    df["Estado (auto)"] = df.apply(_compute_estado, axis=1, today=today)

    # Retraso (días) (auto)
    def delay_days(row) -> float:
        fin_p = row["Fin Planificado"]
        fin_r = row["Fin Real"]
        ini_r = row["Inicio Real"]
        if not pd.isna(fin_r) and not pd.isna(fin_p):
            return (fin_r - fin_p).days
        if not pd.isna(ini_r) and pd.isna(fin_r) and not pd.isna(fin_p):
            return max(0, (today - fin_p).days)
        return 0

    df["Retraso (días) (auto)"] = df.apply(delay_days, axis=1)

    # Duración real (auto)
    def dur_real_calc(row):
        ini_r, fin_r = row["Inicio Real"], row["Fin Real"]
        if not pd.isna(ini_r) and not pd.isna(fin_r):
            return max(1, (fin_r - ini_r).days + 1)
        return row.get("Duración Real (días)", np.nan)

    df["Duración Real (días) (auto)"] = df.apply(dur_real_calc, axis=1)

    # Sobrecosto (auto)
    def sobrecosto_calc(row):
        cp = row.get("Costo Planificado (USD)", np.nan)
        cr = row.get("Costo Real (USD)", np.nan)
        if not pd.isna(cr) and not pd.isna(cp):
            return cr - cp
        return row.get("Sobrecosto (USD)", np.nan)

    df["Sobrecosto (USD) (auto)"] = df.apply(sobrecosto_calc, axis=1)

    # % Avance normalizado y acumulado (simple)
    av = df["% Avance Físico"].astype(float)
    df["% Avance Físico (norm)"] = av.clip(lower=0).clip(upper=100)
    # Orden sugerido por Fin Planificado, luego Inicio Planificado, luego ID
    df["_sort_key"] = pd.to_datetime(df["Fin Planificado"], errors="coerce").fillna(
        pd.to_datetime(df["Inicio Planificado"], errors="coerce")
    )
    df.sort_values(by=["_sort_key", "ID"], inplace=True, kind="stable")
    df["% Avance Físico (acum)"] = df["% Avance Físico (norm)"].fillna(0).cumsum().clip(upper=100)
    df.drop(columns=["_sort_key"], inplace=True)

    # Predecesores como lista
    df["Predecesores (lista)"] = df["Predecesor"].apply(_split_predecessors)

    return df

def _process_dataframe(df_raw: pd.DataFrame) -> pd.DataFrame:
    df = _normalize_columns(df_raw)
    missing = _validate_columns(df)
    if missing:
        raise ValueError(f"Faltan columnas requeridas: {', '.join(missing)}")

    df = _coerce_types(df)
    df = _recompute_derivatives(df)
    return df

# -------------------- Routes --------------------
@app.route("/", methods=["GET"])
def index():
    return render_template("index.html")

@app.route("/upload", methods=["POST"])
def upload():
    f = request.files.get("file")
    if not f:
        flash("Debes seleccionar un archivo Excel.", "error")
        return redirect(url_for("index"))

    try:
        # Si existe la hoja 'Cronograma Detallado', úsala; si no, usa la primera
        xls = pd.ExcelFile(f)
        sheet_to_use = "Cronograma Detallado" if "Cronograma Detallado" in xls.sheet_names else xls.sheet_names[0]
        df_raw = pd.read_excel(xls, sheet_name=sheet_to_use)
        processed = _process_dataframe(df_raw)
    except Exception as e:
        flash(f"Error al procesar el Excel: {e}", "error")
        return redirect(url_for("index"))

    upload_id = str(uuid.uuid4())
    DATASETS[upload_id] = {
        "df": processed,
        "uploaded_at": datetime.utcnow().isoformat() + "Z",
        "filename": getattr(f, "filename", "proyecto.xlsx")
    }
    session["last_upload"] = upload_id
    return redirect(url_for("menu", upload_id=upload_id))

@app.route("/menu/<upload_id>")
def menu(upload_id):
    if upload_id not in DATASETS:
        flash("Archivo no encontrado.", "error")
        return redirect(url_for("index"))
    return render_template("menu.html", upload_id=upload_id)

@app.route("/gantt/<upload_id>", methods=["GET"])
def gantt_page(upload_id):
    if upload_id not in DATASETS:
        flash("ID de carga no encontrado. Vuelve a subir el archivo.", "error")
        return redirect(url_for("index"))
    return render_template("gantt.html", upload_id=upload_id)

@app.route("/tasks/<upload_id>")
def tasks_page(upload_id):
    if upload_id not in DATASETS:
        flash("Archivo no encontrado.", "error")
        return redirect(url_for("index"))
    return render_template("tasks.html", upload_id=upload_id)

@app.route("/api/tasks/<upload_id>", methods=["GET", "POST"])
def api_tasks(upload_id):
    if upload_id not in DATASETS:
        return jsonify({"error": "not_found"}), 404

    if request.method == "GET":
        # Devuelve el DF actual tal como está (incluye derivadas)
        df = DATASETS[upload_id]["df"]
        return df.to_json(orient="records", date_format="iso")

    # POST: guardar cambios desde la tabla y recalcular
    try:
        data = request.get_json(force=True)
        if not isinstance(data, list):
            return jsonify({"error": "payload_must_be_array"}), 400

        # Construir DF desde lo que vino del front
        new_df = pd.DataFrame(data)

        # Asegurar que existen columnas mínimas (si no, error claro)
        missing = [c for c in REQUIRED_COLUMNS if c not in new_df.columns]
        if missing:
            return jsonify({"error": f"faltan_columnas_requeridas: {', '.join(missing)}"}), 400

        # Re-procesar (normaliza fechas, numéricos y recalcula derivados)
        processed = _process_dataframe(new_df)

        DATASETS[upload_id]["df"] = processed
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/data/<upload_id>", methods=["GET"])
def api_data(upload_id):
    if upload_id not in DATASETS:
        return jsonify({"error": "not_found"}), 404
    df = DATASETS[upload_id]["df"].copy()

    # Saneamos columnas numéricas para evitar float('') -> ValueError
    numeric_cols = [
        "Riesgo de Retraso (%)",
        "% Avance Físico (norm)",
        "% Avance Físico (acum)",
        "Costo Planificado (USD)",
        "Costo Real (USD)",
        "Sobrecosto (USD) (auto)",
        "Buffer sugerido (días)",
        "Retraso (días) (auto)",
        "Duración Real (días) (auto)",
        "Duración Planificada (días)",
    ]
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Asegurar lista de predecesores (por si vino mal guardado)
    if "Predecesores (lista)" not in df.columns and "Predecesor" in df.columns:
        df["Predecesores (lista)"] = df["Predecesor"].apply(_split_predecessors)

    # Preparar filas para el front
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "ID": str(r["ID"]),
            "Fase": r.get("Fase", ""),
            "Tarea": r["Tarea"],
            "InicioPlan": r["Inicio Planificado"].isoformat() if not pd.isna(r["Inicio Planificado"]) else None,
            "FinPlan": r["Fin Planificado"].isoformat() if not pd.isna(r["Fin Planificado"]) else None,
            "InicioReal": r["Inicio Real"].isoformat() if not pd.isna(r["Inicio Real"]) else None,
            "FinReal": r["Fin Real"].isoformat() if not pd.isna(r["Fin Real"]) else None,
            "EstadoAuto": r.get("Estado (auto)", ""),
            "RiesgoRetraso": None if pd.isna(r.get("Riesgo de Retraso (%)", np.nan)) else float(r["Riesgo de Retraso (%)"]),
            "AvanceFisico": None if pd.isna(r.get("% Avance Físico (norm)", np.nan)) else float(r["% Avance Físico (norm)"]),
            "AvanceFisicoAcum": None if pd.isna(r.get("% Avance Físico (acum)", np.nan)) else float(r["% Avance Físico (acum)"]),
            "CostoPlan": None if pd.isna(r.get("Costo Planificado (USD)", np.nan)) else float(r["Costo Planificado (USD)"]),
            "CostoReal": None if pd.isna(r.get("Costo Real (USD)", np.nan)) else float(r["Costo Real (USD)"]),
            "SobrecostoAuto": None if pd.isna(r.get("Sobrecosto (USD) (auto)", np.nan)) else float(r["Sobrecosto (USD) (auto)"]),
            "BufferSugerido": None if pd.isna(r.get("Buffer sugerido (días)", np.nan)) else float(r["Buffer sugerido (días)"]),
            "RetrasoDias": None if pd.isna(r.get("Retraso (días) (auto)", np.nan)) else float(r["Retraso (días) (auto)"]),
            "DiasRetrasoExcel": None if pd.isna(r.get("Días de Retraso", np.nan)) else float(r["Días de Retraso"]),
            "Predecesores": r.get("Predecesores (lista)", []),
        })

    fases = sorted({row["Fase"] for row in rows if row["Fase"]})
    estados = list(ESTADO_COLORS.keys())

    return jsonify({
        "rows": rows,
        "filters": {
            "fases": fases,
            "estados": estados
        },
        "paletaEstados": ESTADO_COLORS
    })

@app.route("/api/dashboard/<upload_id>", methods=["GET"])
def api_dashboard(upload_id):
    if upload_id not in DATASETS:
        return jsonify({"error": "not_found"}), 404
    df = DATASETS[upload_id]["df"]

    completed_mask = df["Estado (auto)"].isin([
        "Completada a tiempo", "Completada con retraso", "Completada anticipadamente"
    ])
    total = len(df)
    completed = int(completed_mask.sum())
    on_time = int(df["Estado (auto)"].isin(["Completada a tiempo", "Completada anticipadamente"]).sum())
    delayed_done = int(df["Estado (auto)"].isin(["Completada con retraso"]).sum())

    pct_on_time = round(100 * on_time / total, 2) if total else 0.0
    pct_delayed_done = round(100 * delayed_done / total, 2) if total else 0.0

    sobrecosto_total = df["Sobrecosto (USD) (auto)"].replace({np.nan: 0}).sum()
    riesgo_prom = df["Riesgo de Retraso (%)"].astype(float).replace({np.nan: np.nan}).mean()
    if pd.isna(riesgo_prom):
        riesgo_prom = 0.0

    return jsonify({
        "totales": {
            "tareas": int(total),
            "tareasCompletadas": completed
        },
        "porcentajes": {
            "completadasATiempo": pct_on_time,
            "completadasConRetraso": pct_delayed_done
        },
        "sobrecostoTotalUSD": round(float(sobrecosto_total), 2),
        "riesgoPromedioPct": round(float(riesgo_prom), 2)
    })

@app.route("/api/export/excel/<upload_id>", methods=["GET"])
def export_excel(upload_id):
    if upload_id not in DATASETS:
        return jsonify({"error": "not_found"}), 404
    df = DATASETS[upload_id]["df"].copy()

    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
        df.to_excel(writer, index=False, sheet_name="Proyecto")
    output.seek(0)
    filename = f"proyecto_con_derivados_{upload_id[:8]}.xlsx"
    return send_file(
        output,
        as_attachment=True,
        download_name=filename,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )

@app.route("/api/export/image/<upload_id>", methods=["POST"])
def export_image(upload_id):
    if upload_id not in DATASETS:
        return jsonify({"error": "not_found"}), 404

    fmt = request.args.get("fmt", "png").lower()
    if fmt not in ("png", "pdf", "svg", "jpeg", "webp"):
        fmt = "png"

    try:
        fig_json = request.get_json(force=True)
        fig = pio.from_json(json.dumps(fig_json))
        img_bytes = fig.to_image(format=fmt, scale=2, engine="kaleido")
    except Exception as e:
        return jsonify({"error": f"export_failed: {e}"}), 400

    return send_file(
        io.BytesIO(img_bytes),
        as_attachment=True,
        download_name=f"gantt.{fmt}",
        mimetype=f"image/{fmt if fmt != 'pdf' else 'pdf'}"
    )

@app.route("/api/export/html/<upload_id>", methods=["POST"])
def export_html(upload_id):
    if upload_id not in DATASETS:
        return jsonify({"error": "not_found"}), 404
    try:
        fig_json = request.get_json(force=True)
        fig = pio.from_json(json.dumps(fig_json))
        html_str = pio.to_html(fig, include_plotlyjs="cdn", full_html=True)
        buf = io.BytesIO(html_str.encode("utf-8"))
    except Exception as e:
        return jsonify({"error": f"export_failed: {e}"}), 400

    return send_file(buf, as_attachment=True, download_name="gantt_interactivo.html", mimetype="text/html")

if __name__ == "__main__":
    # Debug server
    app.run(host="0.0.0.0", port=5000, debug=True)
