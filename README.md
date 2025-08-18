# Carta Gantt Interactiva (Flask + Plotly)

Aplicación web para cargar un **Excel de tareas**, procesarlo y visualizar una **Carta Gantt interactiva** con filtros, dependencias, dashboard de KPIs, editor de tareas y exportaciones (PNG/PDF/HTML/Excel). Incluye **modo claro/oscuro** y un **Excel de ejemplo**.

---

## 1) Requisitos

- **Python 3.10+** (recomendado 3.10 o 3.11)
- pip y venv
- Navegador moderno (Chrome/Edge/Firefox)

### Dependencias
```
Flask>=3.0
pandas>=2.0
numpy>=1.24
plotly>=5.22
kaleido>=0.2.1
openpyxl>=3.1
XlsxWriter>=3.2
tzdata>=2024.1   # Requerido en Windows para zoneinfo
```

Instalación rápida:
```bash
pip install -r requirements.txt
```

---

## 2) Puesta en marcha

```bash
git clone <tu-repo>.git
cd <tu-repo>

python -m venv venv
# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt

python app.py
# o: flask --app app run --debug

# Navegador
http://localhost:5000/
```

> Límite de subida: **20 MB** (configurable en `app.config["MAX_CONTENT_LENGTH"]`).

---

## 3) Estructura

```
.
├─ app.py
├─ templates/
│  ├─ layout.html
│  ├─ index.html
│  ├─ menu.html
│  ├─ gantt.html
│  └─ tasks.html
└─ static/
   ├─ style.css
   ├─ app.js
   └─ sample_data/
      └─ simulacion1_1_1.xlsx   # (opcional)
```

> Si el archivo de ejemplo no está presente, `GET /example-excel` **genera** uno compatible con la app (hoja *Cronograma Detallado*).

---

## 4) Formato del Excel

Columnas **mínimas** (obligatorias):

- `ID`
- `Tarea`
- `Inicio Planificado`
- `Fin Planificado`
- `Predecesor` *(puede contener múltiples IDs separados por coma, punto y coma o espacios)*
- `Inicio Real`
- `Fin Real`

Columnas **opcionales** (aceptadas si existen):
`Fase`, `Duración Planificada (días)`, `Costo Planificado (USD)`, `Riesgo de Retraso (%)`, `Estado`, `Duración Real (días)`, `% Avance Físico`, `Costo Real (USD)`, `Retraso (días)`, `Sobrecosto (USD)`, `Causa de Retraso`, `Observaciones`, `Días de Retraso`, `Buffer sugerido (días)`.

**Notas:**
- Fechas en `DD-MM-YYYY` o `YYYY-MM-DD` (se ignoran horas).
- Números/porcentajes: el parser tolera `,` y `.` como separadores, y símbolos `$`/`%`.
- Si existe la hoja **Cronograma Detallado**, se utiliza; de lo contrario, se usa la **primera** hoja.

---

## 5) Cálculos automáticos

- **Estado (auto)**
  - `Pendiente`: `Inicio Real` vacío
  - `En progreso (a tiempo)`: `Inicio Real` no vacío y `Fin Real` vacío con **HOY ≤ Fin Planificado**
  - `En progreso (atrasada)`: `Inicio Real` no vacío y `Fin Real` vacío con **HOY > Fin Planificado**
  - `Completada anticipadamente`: `Fin Real < Fin Planificado`
  - `Completada a tiempo`: `Fin Real = Fin Planificado`
  - `Completada con retraso`: `Fin Real > Fin Planificado`

- **Retraso (días) (auto)**: si está completada `Fin Real − Fin Planificado`; si sigue en progreso `max(0, HOY − Fin Planificado)`
- **Duración Real (días) (auto)**: `(Fin Real − Inicio Real) + 1` cuando ambas fechas existen
- **Sobrecosto (USD) (auto)**: `Costo Real − Costo Planificado` (si ambos están presentes)
- **% Avance Físico**
  - `norm`: normalizado a **0..100**
  - `acum`: se calcula en una **vista ordenada** por fin/inicio planificado y luego se reindexa, **sin alterar el orden original**

---

## 6) Funcionalidad

- **Menú**: atajos a Gantt, editor de tareas y cargar otro archivo.
- **Editor de tareas**: edición inline de `Tarea`, `Predecesor`, `Inicio/Fin Real`, `% Avance Físico`, `Costo Real (USD)`, `Observaciones`, `Causa de Retraso)`. Al **Guardar** se recalculan los derivados y se mantiene el **orden original**.
- **Gantt (Plotly)**:
  - Barra gris: planificado
  - Barra de color: real (según estado)
  - **Flechas de dependencias** por `Predecesor`
  - **Filtros** por `Fase`, `Estado` y **Riesgo mínimo (%)**
  - **Exportar**: PNG, PDF, HTML interactivo y Excel con derivados
  - **Responsive**: el gráfico se ajusta al tamaño del contenedor/ventana

---

## 7) Endpoints útiles

- `GET /` → carga de archivo
- `POST /upload` → procesa y redirige a menú
- `GET /menu/<upload_id>` → acciones rápidas
- `GET /gantt/<upload_id>` → carta Gantt
- `GET /tasks/<upload_id>` → editor
- `GET /api/tasks/<upload_id>` → filas JSON (fechas `YYYY-MM-DD`)
- `POST /api/tasks/<upload_id>` → guarda cambios y recalcula
- `GET /api/data/<upload_id>` → datos de la Gantt y filtros
- `GET /api/dashboard/<upload_id>` → KPIs
- `GET /api/export/excel/<upload_id>` → Excel con derivados
- `POST /api/export/image/<upload_id>?fmt=png|pdf|svg|jpeg|webp` → imagen Gantt
- `POST /api/export/html/<upload_id>` → HTML interactivo
- `GET /example-excel` → sirve el ejemplo si existe o lo genera

---

## 8) Solución de problemas

- **404 al abrir el ejemplo**: coloca `simulacion1_1_1.xlsx` en `static/sample_data/` o usa `/example-excel`.
- **Formato de fecha incorrecto**: asegúrate de usar `DD-MM-YYYY` o `YYYY-MM-DD`.
- **Valores numéricos con coma**: el parser ya los tolera; si falla, revisa celdas con texto no numérico.
- **Pérdida de datos al reiniciar**: los datasets viven en memoria. Exporta a Excel y vuelve a cargar.

---