/**
 * results_db.js — SQLite-backed run results storage using sql.js (WASM).
 *
 * The entire database is serialized to localStorage after each write
 * and restored on page load.  For databases exceeding the localStorage
 * quota (~5 MB) we fall back to IndexedDB automatically.
 *
 * Usage (from app.js):
 *   import { resultsDb } from './results_db.js';
 *   await resultsDb.init();                     // call once at boot
 *   await resultsDb.saveRun(meta, execResult);  // after each solver run
 *   const rows = resultsDb.listRuns();          // browse history
 *   const full = resultsDb.getRun(id);          // fetch one run w/ all data
 *   resultsDb.deleteRun(id);                    // remove a single run
 *   resultsDb.clearAll();                       // wipe the database
 *   resultsDb.exportDb();                       // returns Uint8Array of .db
 */

const LS_KEY = '_vl_results_db';
const IDB_NAME = 'vibelattice';
const IDB_STORE = 'results_db';
const IDB_KEY = 'db_bytes';

// ---------------------------------------------------------------------------
// IndexedDB helpers (fallback when localStorage quota exceeded)
// ---------------------------------------------------------------------------
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(bytes) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

function idbGet() {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  }));
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
function persistBytes(bytes) {
  // Try localStorage first (fast, synchronous reads later).
  try {
    const b64 = btoa(String.fromCharCode(...bytes));
    localStorage.setItem(LS_KEY, b64);
    return;
  } catch { /* quota exceeded — fall through */ }

  // Fallback: IndexedDB (async, no size limit in practice).
  idbPut(bytes).catch((err) => {
    console.warn('[results_db] Failed to persist to IndexedDB:', err);
  });
}

async function loadBytes() {
  // Try localStorage first.
  try {
    const b64 = localStorage.getItem(LS_KEY);
    if (b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
  } catch { /* unavailable */ }

  // Try IndexedDB.
  try {
    const bytes = await idbGet();
    if (bytes) return new Uint8Array(bytes);
  } catch { /* unavailable */ }

  return null;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Aircraft / file context
  avl_filename    TEXT,
  run_filename    TEXT,
  run_case_name   TEXT,
  run_case_index  INTEGER,
  case_signature  TEXT,

  -- Reference geometry
  sref            REAL,
  cref            REAL,
  bref            REAL,
  xref            REAL,
  yref            REAL,
  zref            REAL,

  -- Flight state
  alpha_deg       REAL,
  beta_deg        REAL,
  mach            REAL,
  pb2v            REAL,
  qc2v            REAL,
  rb2v            REAL,
  velocity        REAL,
  bank_deg        REAL,

  -- Total forces (stability-axis)
  cltot           REAL,
  cdtot           REAL,
  cytot           REAL,
  cdvtot          REAL,
  cdind           REAL,
  span_eff        REAL,

  -- Total force vector (body-axis)  CX, CY, CZ
  cx_tot          REAL,
  cy_tot          REAL,
  cz_tot          REAL,

  -- Total moment vector  Cl, Cm, Cn
  cl_mom          REAL,
  cm_mom          REAL,
  cn_mom          REAL,

  -- Control deflections  (JSON array: [{name, value}])
  control_deflections TEXT,

  -- Hinge moments  (JSON array: [{name, chinge, moment}])
  hinge_moments   TEXT,

  -- Stability derivatives  (JSON: {CLa, CLb, CLp, CLq, CLr, CYa, ...})
  stability_derivs TEXT,

  -- Body-axis derivatives (JSON: {CXu, CXv, CXw, CXp, ...})
  body_derivs      TEXT,

  -- Surface forces  (JSON array: [{name, CL, CD, CY, Cl, Cm, Cn}])
  surface_forces   TEXT,

  -- Strip forces  (JSON array of per-strip rows)
  strip_forces     TEXT,

  -- Element forces (JSON array of per-element rows)
  element_forces   TEXT,

  -- Eigenmodes  (JSON array)
  eigenmodes       TEXT,

  -- Full solver result blob (everything from the worker postMessage)
  result_json      TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_avl ON runs(avl_filename);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_current_case
  ON runs(avl_filename, run_case_index);
`;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let _db = null;  // sql.js Database instance

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const resultsDb = {

  /** Initialise sql.js and open / create the database. */
  async init() {
    if (_db) return;

    // sql.js must be loaded globally before this module.
    if (typeof initSqlJs !== 'function') {
      console.warn('[results_db] sql.js not loaded — database disabled.');
      return;
    }

    const SQL = await initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${file}`,
    });

    const existingBytes = await loadBytes();
    if (existingBytes) {
      try {
        _db = new SQL.Database(existingBytes);
        // Run schema anyway (IF NOT EXISTS) to handle upgrades.
        _db.run(SCHEMA_SQL);
      } catch (err) {
        console.warn('[results_db] Corrupt DB — recreating.', err);
        _db = new SQL.Database();
        _db.run(SCHEMA_SQL);
      }
    } else {
      _db = new SQL.Database();
      _db.run(SCHEMA_SQL);
    }

    console.log('[results_db] Database ready.');
  },

  /** Returns true when the DB is initialised and usable. */
  isReady() {
    return _db !== null;
  },

  // -----------------------------------------------------------------------
  // Write
  // -----------------------------------------------------------------------

  /**
   * Save a solver run to the database.
   *
   * @param {object} meta  — contextual metadata from the UI:
   *   { avlFilename, runFilename, runCaseName, runCaseIndex,
   *     mach, velocity, bankDeg,
   *     controlDeflections: [{name, value}],
   *     stabilityDerivs, bodyDerivs,
   *     surfaceForces: [{name, CL, CD, CY, Cl, Cm, Cn}],
   *     hingeMoments: [{name, chinge, moment}],
   *     stripForces, elementForces, eigenmodes }
   * @param {object} result — the raw exec-worker result object.
   */
  saveRun(meta, result) {
    if (!_db) return null;

    const r = result || {};
    const m = meta || {};
    const deg = 180 / Math.PI;

    if (Number.isFinite(m.runCaseIndex)) {
      if (m.avlFilename == null) {
        _db.run('DELETE FROM runs WHERE avl_filename IS NULL AND run_case_index = ?', [m.runCaseIndex]);
      } else {
        _db.run('DELETE FROM runs WHERE avl_filename = ? AND run_case_index = ?', [m.avlFilename, m.runCaseIndex]);
      }
    }

    _db.run(`INSERT INTO runs (
      avl_filename, run_filename, run_case_name, run_case_index,
      case_signature,
      sref, cref, bref, xref, yref, zref,
      alpha_deg, beta_deg, mach, pb2v, qc2v, rb2v, velocity, bank_deg,
      cltot, cdtot, cytot, cdvtot, cdind, span_eff,
      cx_tot, cy_tot, cz_tot,
      cl_mom, cm_mom, cn_mom,
      control_deflections, hinge_moments,
      stability_derivs, body_derivs,
      surface_forces, strip_forces, element_forces,
      eigenmodes, result_json
    ) VALUES (
      ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?
    )`, [
      m.avlFilename  || null,
      m.runFilename  || null,
      m.runCaseName  || null,
      Number.isFinite(m.runCaseIndex) ? m.runCaseIndex : null,
      m.caseSignature || null,

      fin(r.SREF), fin(r.CREF), fin(r.BREF),
      fin(r.XREF), fin(r.YREF), fin(r.ZREF),

      fin(r.ALFA) !== null ? r.ALFA * deg : null,
      fin(r.BETA) !== null ? r.BETA * deg : null,
      fin(m.mach)        || null,
      r.WROT ? fin(r.WROT[0]) : null,
      r.WROT ? fin(r.WROT[1]) : null,
      r.WROT ? fin(r.WROT[2]) : null,
      fin(m.velocity)    || null,
      fin(m.bankDeg)     || null,

      fin(r.CLTOT), fin(r.CDTOT), fin(r.CYTOT), fin(r.CDVTOT),
      (fin(r.CDTOT) !== null && fin(r.CDVTOT) !== null) ? r.CDTOT - r.CDVTOT : null,
      fin(r.SPANEF),

      r.CFTOT ? fin(r.CFTOT[0]) : null,
      r.CFTOT ? fin(r.CFTOT[1]) : null,
      r.CFTOT ? fin(r.CFTOT[2]) : null,

      r.CMTOT ? fin(r.CMTOT[0]) : null,
      r.CMTOT ? fin(r.CMTOT[1]) : null,
      r.CMTOT ? fin(r.CMTOT[2]) : null,

      jsonOrNull(m.controlDeflections),
      jsonOrNull(m.hingeMoments),
      jsonOrNull(m.stabilityDerivs),
      jsonOrNull(m.bodyDerivs),
      jsonOrNull(m.surfaceForces),
      jsonOrNull(m.stripForces),
      jsonOrNull(m.elementForces),
      jsonOrNull(m.eigenmodes),
      jsonOrNull(r),
    ]);

    const id = _db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
    _persist();
    return id;
  },

  // -----------------------------------------------------------------------
  // Read
  // -----------------------------------------------------------------------

  /** List all runs (lightweight — no blobs). Returns array of row objects. */
  listRuns() {
    if (!_db) return [];
    const stmt = _db.prepare(`
      SELECT id, created_at, avl_filename, run_filename,
             run_case_name, run_case_index,
             alpha_deg, beta_deg, mach,
             cltot, cdtot, cytot, cdvtot, cdind, span_eff,
             cx_tot, cy_tot, cz_tot,
             cl_mom, cm_mom, cn_mom
      FROM runs ORDER BY id DESC
    `);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },

  /** Get a single run with all fields including result_json. */
  getRun(id) {
    if (!_db) return null;
    const stmt = _db.prepare('SELECT * FROM runs WHERE id = ?');
    stmt.bind([id]);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row ? _parseJsonColumns(row) : null;
  },

  /** Get the current stored row for one run case index. */
  getRunByCaseIndex(runCaseIndex, avlFilename = null) {
    if (!_db || !Number.isFinite(runCaseIndex)) return null;
    const stmt = avlFilename == null
      ? _db.prepare('SELECT * FROM runs WHERE avl_filename IS NULL AND run_case_index = ? ORDER BY id DESC LIMIT 1')
      : _db.prepare('SELECT * FROM runs WHERE avl_filename = ? AND run_case_index = ? ORDER BY id DESC LIMIT 1');
    stmt.bind(avlFilename == null ? [runCaseIndex] : [avlFilename, runCaseIndex]);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row ? _parseJsonColumns(row) : null;
  },

  /** Delete a single run. */
  deleteRun(id) {
    if (!_db) return;
    _db.run('DELETE FROM runs WHERE id = ?', [id]);
    _persist();
  },

  /** Delete all runs. */
  clearAll() {
    if (!_db) return;
    _db.run('DELETE FROM runs');
    _persist();
  },

  /** Delete all results for a specific run_case_index. */
  deleteByRunCaseIndex(index) {
    if (!_db) return;
    _db.run('DELETE FROM runs WHERE run_case_index = ?', [index]);
    _persist();
  },

  /**
   * Re-index run_case_index values after a run case is removed from
   * the middle of the list.  All rows with index > removedIndex get
   * decremented by 1.
   */
  reindexAfterRemoval(removedIndex) {
    if (!_db) return;
    _db.run('DELETE FROM runs WHERE run_case_index = ?', [removedIndex]);
    _db.run('UPDATE runs SET run_case_index = run_case_index - 1 WHERE run_case_index > ?', [removedIndex]);
    _persist();
  },

  /**
   * Keep only results whose run_case_index is in the given set of
   * valid indices.  Removes orphaned rows from deleted/reloaded cases.
   */
  pruneToIndices(validIndices) {
    if (!_db) return;
    if (!validIndices || !validIndices.length) {
      _db.run('DELETE FROM runs');
      _persist();
      return;
    }
    const placeholders = validIndices.map(() => '?').join(',');
    _db.run(
      `DELETE FROM runs WHERE run_case_index IS NULL OR run_case_index NOT IN (${placeholders})`,
      validIndices,
    );
    _persist();
  },

  /**
   * Clear results that don't match the current session context.
   * Call on boot or when the AVL file changes.
   */
  clearStaleForSession(avlFilename) {
    if (!_db) return;
    if (!avlFilename) return;
    _db.run('DELETE FROM runs WHERE avl_filename IS NULL OR avl_filename != ?', [avlFilename]);
    _persist();
  },

  /** Return a map of run_case_index -> case_signature for one AVL session. */
  caseSignaturesByIndex(avlFilename = null) {
    if (!_db) return new Map();
    const stmt = avlFilename == null
      ? _db.prepare('SELECT run_case_index, case_signature FROM runs WHERE avl_filename IS NULL AND run_case_index IS NOT NULL')
      : _db.prepare('SELECT run_case_index, case_signature FROM runs WHERE avl_filename = ? AND run_case_index IS NOT NULL');
    if (avlFilename != null) stmt.bind([avlFilename]);
    const map = new Map();
    while (stmt.step()) {
      const row = stmt.getAsObject();
      map.set(Number(row.run_case_index), row.case_signature || null);
    }
    stmt.free();
    return map;
  },

  /**
   * Keep only results that still match the current AVL + run-case definitions.
   * Any deleted/reordered/edited cases lose their stored result until rerun.
   */
  syncCurrentCases(avlFilename, currentCases) {
    if (!_db) return;
    const normalizedAvl = avlFilename || null;
    const currentMap = new Map();
    (Array.isArray(currentCases) ? currentCases : []).forEach((entry) => {
      const idx = Number(entry?.runCaseIndex);
      if (!Number.isFinite(idx)) return;
      currentMap.set(idx, entry?.caseSignature || null);
    });

    const stmt = _db.prepare('SELECT id, avl_filename, run_case_index, case_signature FROM runs');
    const idsToDelete = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const rowAvl = row.avl_filename ?? null;
      const rowIndex = Number(row.run_case_index);
      if (rowAvl !== normalizedAvl) {
        idsToDelete.push(row.id);
        continue;
      }
      if (!Number.isFinite(rowIndex)) {
        idsToDelete.push(row.id);
        continue;
      }
      const expectedSignature = currentMap.get(rowIndex);
      if (!currentMap.has(rowIndex) || row.case_signature !== expectedSignature) {
        idsToDelete.push(row.id);
      }
    }
    stmt.free();

    if (!idsToDelete.length) return;
    const deleteStmt = _db.prepare('DELETE FROM runs WHERE id = ?');
    idsToDelete.forEach((id) => deleteStmt.run([id]));
    deleteStmt.free();
    _persist();
  },

  /** Return the set of run_case_index values that have stored results. */
  indicesWithResults() {
    if (!_db) return new Set();
    const res = _db.exec('SELECT DISTINCT run_case_index FROM runs WHERE run_case_index IS NOT NULL');
    if (!res.length) return new Set();
    return new Set(res[0].values.map(row => row[0]));
  },

  /** Return the number of stored runs. */
  count() {
    if (!_db) return 0;
    const res = _db.exec('SELECT COUNT(*) FROM runs');
    return res.length ? res[0].values[0][0] : 0;
  },

  /** Export the raw database as a Uint8Array (.sqlite / .db file). */
  exportDb() {
    if (!_db) return null;
    return _db.export();
  },

  /** Import a database from a Uint8Array, replacing current data. */
  async importDb(bytes) {
    if (typeof initSqlJs !== 'function') return;
    const SQL = await initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${file}`,
    });
    _db = new SQL.Database(new Uint8Array(bytes));
    _db.run(SCHEMA_SQL);
    _persist();
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function fin(v) {
  return Number.isFinite(v) ? v : null;
}

function jsonOrNull(obj) {
  if (obj == null) return null;
  try { return JSON.stringify(obj); } catch { return null; }
}

function _parseJsonColumns(row) {
  for (const col of [
    'control_deflections', 'hinge_moments',
    'stability_derivs', 'body_derivs',
    'surface_forces', 'strip_forces', 'element_forces',
    'eigenmodes', 'result_json',
  ]) {
    if (row[col]) {
      try { row[col] = JSON.parse(row[col]); } catch { /* leave as string */ }
    }
  }
  return row;
}

function _persist() {
  if (!_db) return;
  const bytes = _db.export();
  persistBytes(bytes);
}

export { resultsDb };
