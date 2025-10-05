/* app.js — EmbiggenEye (robust, PSR-aware, detector + suggestions, verbose & debug-ready)
   Paste this entire file into docs/app.js (or wherever your index.html loads it).
   Requirements: Leaflet + leaflet.markercluster are already loaded by index.html.
   Optional: psr.geojson, suggestions.json, features_part*.json or features.json
   This script will:
     - load features (multi-part fallback)
     - load PSR geojson (if present) and compute overlap with crater footprints
     - compute normalized metrics and water_score using available components
     - present a very accessible Suggestions UI + Accept/Comment/Export flows
     - add many debugging outputs and counts so you can see "what's not working"
*/

(() => {
  'use strict';

  /* ===========================
     CONFIG
     =========================== */
  const DEBUG = false;                 // set true to get more console logs
  const MAX_MAP_ZOOM = 5;
  // Files (relative to PAGE_BASE computed below)
  const FEATURE_PARTS = ['features_part1.json', 'features_part2.json', 'features_part3.json'];
  const FEATURE_SINGLE = 'features.json';
  const SUGGESTIONS_FILE = 'suggestions.json';
  const PSR_FILE = 'psr.geojson';              // try PAGE_BASE + PSR_FILE and PAGE_BASE + 'static/' + PSR_FILE
  const BLANK_TILE = 'static/blank-tile.png';  // tiny transparent fallback
  // tile templates (replace PAGE_BASE at runtime)
  let TILE_PATHS = {
    vis: 'tiles/layer_vis/{z}/{x}/{y}.png',
    ir:  'tiles/layer_ir/{z}/{x}/{y}.png',
    elev:'tiles/layer_elev/{z}/{x}/{y}.png',
    index:'tiles/layer_index/{z}/{x}/{y}.png'
  };

  // default water scoring weights (used if all components available)
  const DEFAULT_WEIGHTS = {
    psr: 0.35,
    hydrogen: 0.30,
    spectral: 0.30,
    depth: 0.05
  };

  /* ===========================
     PAGE BASE
     =========================== */
  function computePageBase(){
    let path = window.location.pathname || '/';
    if (path.indexOf('.') !== -1) path = path.substring(0, path.lastIndexOf('/')+1);
    if (!path.endsWith('/')) path = path + '/';
    return path;
  }
  const PAGE_BASE = computePageBase();
  // apply page base to tile templates
  Object.keys(TILE_PATHS).forEach(k => TILE_PATHS[k] = PAGE_BASE + TILE_PATHS[k]);
  const BLANK_TILE_URL = PAGE_BASE + BLANK_TILE;

  /* ===========================
     DYNAMIC LOADER UTILITIES
     =========================== */
  function $id(id){ return document.getElementById(id); }
  function $qs(sel){ return document.querySelector(sel); }
  function $qsa(sel){ return Array.from(document.querySelectorAll(sel)); }

  function toast(msg, t=2400){
    const el = $id('toast');
    if(!el){ console.log('TOAST:', msg); return; }
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(el._t);
    el._t = setTimeout(()=> el.classList.remove('visible'), t);
  }

  function setLoader(text){
    const L = $id('loader');
    if(!L) return;
    if(text) { L.style.display = 'block'; L.textContent = text; }
    else { L.style.display = 'none'; L.textContent = ''; }
  }

  async function fetchJSON(url){
    const res = await fetch(url, {cache: 'no-cache'});
    if(!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  }

  // lazy load a script (resolve when loaded)
  function loadScript(url){
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = (e) => reject(new Error('Failed to load ' + url));
      document.head.appendChild(s);
    });
  }

  /* ===========================
     GEOMETRY HELPERS (uses Turf if available)
     =========================== */
  function ensureTurf(){
    // returns Promise that resolves when turf is available as window.turf
    if(window.turf) return Promise.resolve(window.turf);
    const turfUrl = 'https://unpkg.com/@turf/turf@6.5.0/turf.min.js';
    return loadScript(turfUrl).then(() => {
      if(!window.turf) throw new Error('Turf failed to initialize');
      return window.turf;
    });
  }

  // create a circle polygon (approx) around lat/lon with radius meters using turf.buffer
  function turfCircle(lat, lon, radius_m){
    if(!window.turf) return null;
    try {
      const pt = window.turf.point([lon, lat]);
      const buff = window.turf.buffer(pt, radius_m, {units: 'meters'});
      return buff;
    } catch(e) {
      if(DEBUG) console.warn('turfCircle failed', e);
      return null;
    }
  }

  // compute overlap area between crater circle and PSR polygon (Turf-based)
  function computePsrOverlapArea(craterPoly, psrFeature){
    if(!window.turf) return 0;
    try{
      // turf.intersect returns geometry of intersection or null
      const inter = window.turf.intersect(craterPoly, psrFeature);
      if(!inter) return 0;
      const interArea = window.turf.area(inter); // in square meters (approx for lon/lat uses spherical area)
      return interArea;
    }catch(e){
      if(DEBUG) console.warn('computePsrOverlapArea error', e);
      return 0;
    }
  }

  /* ===========================
     NORMALIZATION HELPERS
     =========================== */
  function toNum(v){ if(v===undefined || v===null || v==='') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
  function clamp01(v){ return Math.max(0, Math.min(1, (v==null ? 0 : +v))); }
  function normalizeArrayMinMax(arr){
    // arr: numeric array (may contain nulls). returns {min,max,fn(value)->normalized}
    const valid = arr.filter(v => v != null && !Number.isNaN(v));
    const mn = valid.length ? Math.min(...valid) : 0;
    const mx = valid.length ? Math.max(...valid) : 1;
    const span = (mx - mn) || 1;
    return {
      min: mn, max: mx,
      norm: (v) => { if(v==null || Number.isNaN(v)) return 0; return clamp01((v - mn)/span); }
    };
  }

  /* ===========================
     APP STATE
     =========================== */
  const STATE = {
    featuresRaw: [],        // raw JSON rows
    features: [],           // normalized features
    featureMap: new Map(),  // id -> {feature, marker}
    psrGeojson: null,       // loaded PSR geojson (if any)
    suggestions: [],        // current suggestions array
    annotations: [],        // local annotations (from localStorage)
    tileLayers: {},         // tile layer objects
    map: null,
    markerCluster: null,
    suggestionLayer: null,
    annotationLayer: null,
    highlightLayer: null,
    currentLayerName: 'vis',
    turfLoaded: false
  };

  /* ===========================
     FEATURE NORMALIZATION (input tolerant)
     =========================== */
  function normalizeRow(raw){
    const r = Object.assign({}, raw);
    // rename/normalize fields — support many possible key names
    r.id = r.id !== undefined ? String(r.id) : (r.name ? String(r.name) : 'f_' + Math.random().toString(36).slice(2,9));
    r.name = r.name || r.id || 'Feature ' + r.id;
    r.lat = r.lat !== undefined ? toNum(r.lat) : (r.latitude !== undefined ? toNum(r.latitude) : null);
    r.lon = r.lon !== undefined ? toNum(r.lon) : (r.longitude !== undefined ? toNum(r.longitude) : null);
    r.x = r.x !== undefined ? toNum(r.x) : (r.pixel_x !== undefined ? toNum(r.pixel_x) : null);
    r.y = r.y !== undefined ? toNum(r.y) : (r.pixel_y !== undefined ? toNum(r.pixel_y) : null);
    // diameter in meters pref
    if(r.diameter_m === undefined){
      if(r.diameter_km !== undefined) r.diameter_m = toNum(r.diameter_km) * 1000;
      else if(r.diameter !== undefined) r.diameter_m = toNum(r.diameter);
      else if(r.diam !== undefined) r.diameter_m = toNum(r.diam);
      else r.diameter_m = null;
    } else r.diameter_m = toNum(r.diameter_m);
    r.water_score = (r.water_score !== undefined) ? toNum(r.water_score) : ( (r.score!==undefined)? toNum(r.score) : null );
    r.psr_overlap = (r.psr_overlap !== undefined) ? r.psr_overlap : ( (r.psr!==undefined)? r.psr : null );
    r.spectral_mean = (r.spectral_mean!==undefined) ? toNum(r.spectral_mean) : ( (r.spectral!==undefined)? toNum(r.spectral) : null );
    r.hydrogen_mean = (r.hydrogen_mean!==undefined) ? toNum(r.hydrogen_mean) : ( (r.hydrogen!==undefined)? toNum(r.hydrogen) : null );
    r.depth_metric = (r.depth_metric!==undefined) ? toNum(r.depth_metric) : ( (r.depth!==undefined)? toNum(r.depth) : null );
    return r;
  }

  /* ===========================
     I/O: load features (parts or single), load psr if present, load suggestions
     =========================== */
  async function loadFeatures(){
    setLoader('Loading features (parts or single)…');
    let rows = [];
    // try parts
    for(const part of FEATURE_PARTS){
      try {
        const url = PAGE_BASE + part;
        const data = await fetchJSON(url);
        if(Array.isArray(data)) { rows = rows.concat(data); if(DEBUG) console.log('Loaded', part, data.length); }
      } catch(e){ if(DEBUG) console.log('No part', part); }
    }
    // if none loaded from parts, try single file
    if(rows.length === 0){
      try {
        const url = PAGE_BASE + FEATURE_SINGLE;
        const data = await fetchJSON(url);
        if(Array.isArray(data)) rows = rows.concat(data);
        else if(data && Array.isArray(data.features)) rows = rows.concat(data.features);
        if(DEBUG) console.log('Loaded', FEATURE_SINGLE, rows.length);
      } catch(e){
        if(DEBUG) console.log('No features.json found at PAGE_BASE; trying bare name');
        try { 
          const data = await fetchJSON(FEATURE_SINGLE);
          if(Array.isArray(data)) rows = rows.concat(data);
        } catch(e2){ /* nothing */ }
      }
    }
    STATE.featuresRaw = rows;
    setLoader('');
    return rows;
  }

  async function loadPSR(){
    setLoader('Looking for PSR polygons (psr.geojson)…');
    const candidates = [ PAGE_BASE + PSR_FILE, PAGE_BASE + 'static/' + PSR_FILE, PSR_FILE, 'static/' + PSR_FILE ];
    for(const url of candidates){
      try{
        const g = await fetchJSON(url);
        STATE.psrGeojson = g;
        setLoader('');
        console.log('PSR geojson loaded from', url);
        toast('Loaded PSR polygons');
        return g;
      }catch(e){
        if(DEBUG) console.log('psr not at', url);
      }
    }
    setLoader('');
    console.warn('No PSR file found (checked common locations). PSR-based scoring will be disabled.');
    return null;
  }

  async function loadSuggestionsFile(){
    try{
      const s = await fetchJSON(PAGE_BASE + SUGGESTIONS_FILE);
      if(Array.isArray(s)) { STATE.suggestions = s; toast('Loaded suggestions.json'); if(DEBUG) console.log('suggestions loaded', s.length); return s; }
    }catch(e){ if(DEBUG) console.log('no suggestions.json found'); }
    // try bare name
    try{
      const s = await fetchJSON(SUGGESTIONS_FILE);
      if(Array.isArray(s)) { STATE.suggestions = s; toast('Loaded suggestions.json'); return s; }
    }catch(e){}
    return null;
  }

  /* ===========================
     MAP INIT
     =========================== */
  function initMap(){
    setLoader('Initializing map…');
    if(!window.L) throw new Error('Leaflet must be loaded before app.js');

    // create map centered near South Pole
    const map = L.map('map', { preferCanvas: true, maxZoom: MAX_MAP_ZOOM }).setView([-89.6, -45.0], 2);
    STATE.map = map;

    // create tile layers with blank fallback
    function mk(tpl){
      return L.tileLayer(tpl, { maxZoom: MAX_MAP_ZOOM, tileSize: 256, noWrap: true, errorTileUrl: BLANK_TILE_URL });
    }
    STATE.tileLayers.vis = mk(TILE_PATHS.vis);
    STATE.tileLayers.ir = mk(TILE_PATHS.ir);
    STATE.tileLayers.elev = mk(TILE_PATHS.elev);
    STATE.tileLayers.index = mk(TILE_PATHS.index);

    // add visible base by default (if tiles missing, blank tile prevents 404s)
    STATE.tileLayers.vis.addTo(map);

    // add control for base layers
    L.control.layers({ 'Visible': STATE.tileLayers.vis }, {}, { collapsed: true }).addTo(map);

    // marker cluster group
    STATE.markerCluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false });
    map.addLayer(STATE.markerCluster);

    // suggestion and annotation groups
    STATE.suggestionLayer = L.layerGroup().addTo(map);
    STATE.annotationLayer = L.layerGroup().addTo(map);

    setLoader('');
    return map;
  }

  /* ===========================
     FEATURE RENDERING & POPUP WIRING
     =========================== */
  // build popup HTML (includes Accept / Comment / Permalink buttons)
  function buildPopupHtml(f){
    const diam = f.diameter_m ? `${Math.round(f.diameter_m)} m (${(f.diameter_m/1000).toFixed(2)} km)` : '—';
    const score = (f.water_score !== null && f.water_score !== undefined) ? f.water_score.toFixed(3) : '—';
    const spectral = (f.spectral_mean!=null) ? f.spectral_mean.toFixed(3) : '—';
    const hydrogen = (f.hydrogen_mean!=null) ? f.hydrogen_mean.toFixed(3) : '—';
    const depth = (f.depth_metric!=null) ? f.depth_metric.toFixed(3) : '—';
    const psr = (f.psr_overlap && f.psr_overlap > 0) ? `Yes (${(f.psr_overlap*100).toFixed(1)}% overlap)` : 'No';
    // include Comment button
    return `<div class="popup-card" style="min-width:240px">
      <h4 style="margin:0 0 6px 0">${escapeHtml(f.name)}</h4>
      <table class="popup-table" style="width:100%;font-size:13px">
        <tr><td>Water score</td><td style="text-align:right"><b>${score}</b></td></tr>
        <tr><td>PSR overlap</td><td style="text-align:right">${psr}</td></tr>
        <tr><td>Diameter</td><td style="text-align:right">${diam}</td></tr>
        <tr><td>Spectral</td><td style="text-align:right">${spectral}</td></tr>
        <tr><td>Hydrogen</td><td style="text-align:right">${hydrogen}</td></tr>
        <tr><td>Depth</td><td style="text-align:right">${depth}</td></tr>
      </table>
      <div style="margin-top:8px;text-align:right">
        <button class="popup-accept btn small">Accept</button>
        <button class="popup-comment btn small ghost" style="margin-left:6px">Comment</button>
        <button class="popup-permalink btn small ghost" style="margin-left:6px">Permalink</button>
      </div>
    </div>`;
  }

  // create marker for a normalized feature
  function createMarker(f){
    if(f.lat==null || f.lon==null) { if(DEBUG) console.warn('createMarker: missing coords for', f.id); return null; }
    // visual radius scaled from diameter but kept small for cluster UX
    const r = diameterToRadiusPx(f.diameter_m || 1000);
    const marker = L.circleMarker([f.lat, f.lon], {
      radius: Math.max(6, Math.min(30, r)),
      color: colorForScore(f.water_score),
      weight: 1.5,
      fillOpacity: 0.78
    });
    marker.featureId = f.id;
    marker._feature = f;
    marker.bindPopup(buildPopupHtml(f), { minWidth: 260 });
    // on click: highlight + populate details pane
    marker.on('click', () => {
      try { marker.openPopup(); } catch(e) {}
      highlightFeatureOnMap(f);
      populateRightPanelDetails(f);
    });
    // when popup opens, wire accept/comment/permalink buttons (safe)
    marker.on('popupopen', (ev) => {
      const el = ev.popup.getElement();
      if(!el) return;
      // Accept
      const a = el.querySelector('.popup-accept');
      if(a){ a.onclick = ()=> { addAnnotation(f); try{ ev.popup._source.closePopup(); }catch(_){} }; }
      // Comment
      const c = el.querySelector('.popup-comment');
      if(c){ c.onclick = ()=> { promptComment(f); } }
      // Permalink
      const p = el.querySelector('.popup-permalink');
      if(p){ p.onclick = ()=> { writePermalink({ zoom: STATE.map.getZoom(), lat: f.lat, lon: f.lon, layer: STATE.currentLayerName, id: f.id }); toast('Permalink set'); } }
    });
    return marker;
  }

  function colorForScore(s){
    // blue -> yellow -> red
    const v = clamp01(s);
    const r = Math.round(255 * Math.min(1, Math.max(0, (v-0.5)*2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5-v)*2)));
    const g = Math.round(255 * (1 - Math.abs(v-0.5)*2));
    return `rgb(${r},${g},${b})`;
  }

  // highlight selected feature with a circle (single)
  function highlightFeatureOnMap(f){
    if(STATE.highlightLayer){ try{ STATE.map.removeLayer(STATE.highlightLayer); }catch(_){} STATE.highlightLayer = null; }
    if(!f || f.lat==null || f.lon==null) return;
    const radius = Math.max(1000, (f.diameter_m? f.diameter_m*0.5 : 4000));
    STATE.highlightLayer = L.circle([f.lat, f.lon], { radius, color: '#00ffff', weight: 2.4, fillOpacity: 0.06 }).addTo(STATE.map);
    // ensure view focuses (but don't zoom super close)
    try { STATE.map.setView([f.lat, f.lon], Math.min(MAX_MAP_ZOOM, Math.max(3, STATE.map.getZoom()))); } catch(e){}
  }

  /* ===========================
     RIGHT-PANEL: Details / Suggestions / Debug tabs (create and manage)
     =========================== */
  function ensureRightPanelTabs(){
    // right panel has id "featureDetails" per index.html
    const root = $id('featureDetails');
    if(!root) return;
    // if tabs already injected, return
    if(root._tabsInjected) return;
    root._tabsInjected = true;

    // create tab header
    root.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <button id="tab-details" class="btn small ghost">Details</button>
        <button id="tab-suggestions" class="btn small ghost">Suggestions</button>
        <button id="tab-debug" class="btn small ghost">Debug</button>
        <div style="flex:1"></div>
        <button id="btn-detect" class="btn small">Detect</button>
      </div>
      <div id="tab-content" style="min-height:120px"></div>
    `;

    // wire tabs
    $id('tab-details').addEventListener('click', ()=> showRightTab('details'));
    $id('tab-suggestions').addEventListener('click', ()=> showRightTab('suggestions'));
    $id('tab-debug').addEventListener('click', ()=> showRightTab('debug'));
    $id('btn-detect').addEventListener('click', ()=> { detectLocalCandidates(); showRightTab('suggestions'); });

    // default to details
    showRightTab('details');
  }

  function showRightTab(name){
    const content = $id('tab-content');
    if(!content) return;
    content.innerHTML = ''; // reset
    // style active header
    ['details','suggestions','debug'].forEach(k => {
      const btn = $id('tab-' + k);
      if(btn) btn.classList.toggle('active', k === name);
    });
    if(name === 'details'){
      content.innerHTML = `<div class="empty" style="color:var(--muted)">Click a crater to view details</div>`;
      // if a feature is currently selected via permalink or highlight, show it
      if(STATE._lastSelectedFeature) populateRightPanelDetails(STATE._lastSelectedFeature);
    } else if(name === 'suggestions'){
      renderSuggestionsPanel(content);
    } else if(name === 'debug'){
      renderDebugPanel(content);
    }
  }

  function populateRightPanelDetails(f){
    if(!f) return;
    ensureRightPanelTabs();
    const content = $id('tab-content');
    if(!content) return;
    STATE._lastSelectedFeature = f;
    content.innerHTML = `
      <div style="padding:6px">
        <h3 style="margin:6px 0;color:var(--accent)">${escapeHtml(f.name)}</h3>
        <div class="meta">id: ${escapeHtml(f.id)}</div>
        <div style="margin-top:8px">Water score: <b style="color:${colorForScore(f.water_score)}">${(f.water_score!=null? f.water_score.toFixed(3): '—')}</b></div>
        <div style="margin-top:6px">PSR overlap: ${(f.psr_overlap? (f.psr_overlap>0? (f.psr_overlap*100).toFixed(1)+'%': 'Yes') : 'No')}</div>
        <div>Diameter: ${(f.diameter_m? Math.round(f.diameter_m)+' m':'—')}</div>
        <div>Spectral mean: ${(f.spectral_mean!=null? f.spectral_mean.toFixed(3):'—')}</div>
        <div>Hydrogen mean: ${(f.hydrogen_mean!=null? f.hydrogen_mean.toFixed(3):'—')}</div>
        <div>Depth metric: ${(f.depth_metric!=null? f.depth_metric.toFixed(3):'—')}</div>
        <div style="margin-top:8px">
          <button id="detailAccept" class="btn small">Accept</button>
          <button id="detailComment" class="btn small ghost">Comment</button>
          <button id="detailPermalink" class="btn small ghost">Permalink</button>
        </div>
      </div>
    `;
    // wire buttons
    $id('detailAccept').onclick = () => addAnnotation(f);
    $id('detailComment').onclick = () => promptComment(f);
    $id('detailPermalink').onclick = () => { writePermalink({ zoom: STATE.map.getZoom(), lat: f.lat, lon: f.lon, layer: STATE.currentLayerName, id: f.id }); toast('Permalink updated'); };
  }

  function renderSuggestionsPanel(containerEl){
    // containerEl is the tab content node (string or element)
    if(typeof containerEl === 'string') containerEl = document.getElementById(containerEl);
    if(!containerEl) return;
    containerEl.innerHTML = `<div style="margin-bottom:8px"><button id="suggestRefresh" class="btn small ghost">Refresh suggestions</button> <button id="suggestAcceptAll" class="btn small">Accept All</button></div><div id="suggest-list"></div>`;
    $id('suggestRefresh').onclick = async () => { await computeSuggestions(); renderSuggestionsPanel(containerEl); };
    $id('suggestAcceptAll').onclick = () => {
      for(const s of STATE.suggestions || []) addAnnotation(s);
      toast('Accepted all suggestions locally');
      renderSuggestionsPanel(containerEl);
    };

    const listDiv = $id('suggest-list');
    const arr = STATE.suggestions || [];
    if(arr.length === 0) { listDiv.innerHTML = `<div style="color:var(--muted)">No suggestions available — click Detect or load suggestions.json</div>`; return; }
    listDiv.innerHTML = '';
    // create item for each suggestion
    for(const s of arr){
      const name = escapeHtml(s.name || s.id);
      const score = s.water_score != null ? s.water_score.toFixed(3) : '—';
      const row = document.createElement('div');
      row.className = 'ann-row';
      row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.alignItems = 'center';
      row.innerHTML = `<div style="flex:1"><b>${name}</b><div style="font-size:12px;color:var(--muted)">id: ${escapeHtml(s.id || '')}</div></div><div style="display:flex;gap:8px;align-items:center"><div style="min-width:68px;text-align:right;color:${colorForScore(s.water_score)}">${score}</div><button class="btn small accept-sugg">Accept</button></div>`;
      // Accept button
      row.querySelector('.accept-sugg').onclick = () => { addAnnotation(s); toast(`Accepted ${name}`); renderSuggestionsPanel(containerEl); };
      // click on row -> center map and open popup / highlight if exists in featureMap
      row.style.cursor = 'pointer';
      row.onclick = () => {
        const id = String(s.id);
        const rec = STATE.featureMap.get(id);
        if(rec && rec.marker){ rec.marker.fire('click'); rec.marker.openPopup(); } else { // create temp visual
          if(s.lat!=null && s.lon!=null) { STATE.map.setView([s.lat, s.lon], Math.min(MAX_MAP_ZOOM, 4)); highlightFeatureOnMap(s); populateRightPanelDetails(s); }
        }
      };
      listDiv.appendChild(row);
    }
  }

  function renderDebugPanel(containerEl){
    if(typeof containerEl === 'string') containerEl = document.getElementById(containerEl);
    if(!containerEl) return;
    // compute diagnostics
    const total = STATE.features.length;
    const missingLatLon = STATE.features.filter(f => f.lat==null || f.lon==null).length;
    const missingSpectral = STATE.features.filter(f => f.spectral_mean==null).length;
    const missingHydrogen = STATE.features.filter(f => f.hydrogen_mean==null).length;
    const missingDepth = STATE.features.filter(f => f.depth_metric==null).length;
    const psrPresent = !!STATE.psrGeojson;
    const suggestionsLoaded = (STATE.suggestions && STATE.suggestions.length>0);

    containerEl.innerHTML = `
      <div style="font-size:13px;color:var(--muted);padding:6px">
        <div>Total features: <b>${total}</b></div>
        <div>Missing lat/lon: <b>${missingLatLon}</b></div>
        <div>Missing spectral_mean: <b>${missingSpectral}</b></div>
        <div>Missing hydrogen_mean: <b>${missingHydrogen}</b></div>
        <div>Missing depth_metric: <b>${missingDepth}</b></div>
        <div>PSR geojson loaded: <b>${psrPresent}</b></div>
        <div>Suggestions present: <b>${suggestionsLoaded}</b></div>
        <div style="margin-top:8px"><button id="dbg-show-sample" class="btn small ghost">Show sample features (console)</button> <button id="dbg-recompute" class="btn small">Recompute scores</button></div>
      </div>
    `;
    $id('dbg-show-sample').onclick = () => { console.log('Sample features', STATE.features.slice(0,20)); toast('Sample printed to console (first 20)'); };
    $id('dbg-recompute').onclick = async () => { await computePerCraterMetricsAndScores(true); toast('Recomputed scores (check console)'); };
  }

  /* ===========================
     ANNOTATIONS (localStorage) + COMMENTS
     =========================== */
  const ANNO_KEY = 'embiggen_annotations_v1';
  function loadAnnotationsFromStorage(){ try { return JSON.parse(localStorage.getItem(ANNO_KEY) || '[]'); } catch(e){ return []; } }
  function saveAnnotationsToStorage(arr){ localStorage.setItem(ANNO_KEY, JSON.stringify(arr)); }

  function refreshAnnotationsListInLeftPanel(){
    const leftAnn = $id('annotationsList');
    if(!leftAnn) return;
    const anns = loadAnnotationsFromStorage();
    if(anns.length === 0){ leftAnn.textContent = 'None yet'; return; }
    leftAnn.innerHTML = anns.map(a => `<div class="ann-row" style="display:flex;justify-content:space-between;align-items:center"><div><b>${escapeHtml(a.name)}</b><div style="font-size:12px;color:var(--muted)">${escapeHtml(a.id || '')}</div></div><div style="text-align:right"><div style="color:${colorForScore(a.water_score || 0)}">${(a.water_score!=null? a.water_score.toFixed(3):'—')}</div><div style="font-size:11px;color:var(--muted)">${new Date(a.ts).toLocaleString()}</div></div></div>`).join('');
  }

  function addAnnotation(f){
    if(!f || f.lat==null || f.lon==null){ toast('Cannot annotate — no coordinates'); return; }
    const anns = loadAnnotationsFromStorage();
    if(anns.find(a => a.id && f.id && String(a.id) === String(f.id))) { toast('Already annotated'); return; }
    const entry = { id: f.id, name: f.name, lat: f.lat, lon: f.lon, water_score: (f.water_score!=null? f.water_score : 0), ts: new Date().toISOString(), comment: f._comment || null };
    anns.push(entry);
    saveAnnotationsToStorage(anns);
    // add visual annotation on map
    const marker = L.circleMarker([f.lat, f.lon], { radius: 10, color: '#2ee6a1', weight:1.6, fillOpacity:0.65 }).addTo(STATE.annotationLayer).bindPopup(`<b>${escapeHtml(f.name)}</b><br/>annotated`);
    refreshAnnotationsListInLeftPanel();
    toast('Annotation saved (local)');
  }

  function promptComment(f){
    const note = prompt('Add a comment/observation (saved locally)', f._comment || '');
    if(note === null) return;
    f._comment = note;
    // if already annotated, update annotation
    const anns = loadAnnotationsFromStorage();
    const idx = anns.findIndex(a => a.id && f.id && String(a.id) === String(f.id));
    if(idx !== -1){
      anns[idx].comment = note; anns[idx].ts = new Date().toISOString();
      saveAnnotationsToStorage(anns); refreshAnnotationsListInLeftPanel();
      toast('Comment saved to annotation');
    } else {
      toast('Comment saved locally. Accept to attach annotation.');
    }
  }

  /* ===========================
     PER-CRATER METRICS & WATER SCORE
     - uses available fields (psr_overlap, hydrogen_mean, spectral_mean, depth_metric)
     - normalizes each available component to 0..1 (min-max)
     - if a component is missing for many features, weights are redistributed proportionally
     =========================== */
  async function computePerCraterMetricsAndScores(force=false){
    // If already computed and not forced, skip
    if(STATE._scoresComputed && !force){ if(DEBUG) console.log('scores already computed'); return; }
    setLoader('Computing per-crater metrics & water scores…');
    // ensure turf loaded if psr available
    if(STATE.psrGeojson && !STATE.turfLoaded){
      try { await ensureTurf(); STATE.turfLoaded = true; console.log('Turf loaded for PSR computations'); } catch(e){ console.warn('Turf failed to load; PSR overlap computations will be skipped'); STATE.turfLoaded = false; }
    }

    // Prepare arrays for normalization
    const spectralArr = []; const hydrogenArr = []; const depthArr = []; const psrOverlapArr = [];
    // for each feature: if psr exists & turf available -> compute overlap percent
    for(const f of STATE.features){
      // ensure numeric fields
      f.spectral_mean = toNum(f.spectral_mean);
      f.hydrogen_mean = toNum(f.hydrogen_mean);
      f.depth_metric = toNum(f.depth_metric);
      f.psr_overlap = toNum(f.psr_overlap);
      // If PSR geojson present and turf loaded, compute overlap if not already computed
      if(STATE.psrGeojson && STATE.turfLoaded && (!f._psr_computed || force)){
        if(f.lat!=null && f.lon!=null && f.diameter_m != null){
          try{
            const craterPoly = window.turf.buffer(window.turf.point([f.lon, f.lat]), Math.max(10, f.diameter_m/2), { units: 'meters' });
            // compute total overlap across PSR features
            let totalOverlapArea = 0;
            for(const feat of STATE.psrGeojson.features || []){
              try{
                const area = computePsrOverlapArea(craterPoly, feat);
                totalOverlapArea += area;
              }catch(e){ if(DEBUG) console.warn('psr overlap error', e); }
            }
            const craterArea = window.turf.area(craterPoly);
            const percent = craterArea > 0 ? clamp01(totalOverlapArea / craterArea) : 0;
            f.psr_overlap = percent; f._psr_computed = true;
          }catch(e){
            if(DEBUG) console.warn('PSR overlap compute failed for', f.id, e);
            f.psr_overlap = f.psr_overlap || 0;
          }
        }
      }
      // push to arrays for normalization
      if(f.spectral_mean != null) spectralArr.push(f.spectral_mean);
      if(f.hydrogen_mean != null) hydrogenArr.push(f.hydrogen_mean);
      if(f.depth_metric != null) depthArr.push(f.depth_metric);
      // psr overlap is 0..1 already (if existed)
      if(f.psr_overlap != null) psrOverlapArr.push(f.psr_overlap);
    }

    // compute normalizers
    const specNorm = normalizeArrayMinMax(spectralArr);
    const hydNorm = normalizeArrayMinMax(hydrogenArr);
    const depthNorm = normalizeArrayMinMax(depthArr);
    const psrNorm = normalizeArrayMinMax(psrOverlapArr); // psr overlap already 0..1 but keep norm function

    // For each feature compute normalized components
    for(const f of STATE.features){
      f._norm = {}; // store normalized components
      f._norm.spectral = f.spectral_mean != null ? specNorm.norm(f.spectral_mean) : null;
      f._norm.hydrogen = f.hydrogen_mean != null ? hydNorm.norm(f.hydrogen_mean) : null;
      f._norm.depth = f.depth_metric != null ? depthNorm.norm(f.depth_metric) : null;
      f._norm.psr = f.psr_overlap != null ? psrNorm.norm(f.psr_overlap) : 0; // default 0 if missing
    }

    // decide active components and compute weights
    // prefer DEFAULT_WEIGHTS if most components present; otherwise redistribute weights among present ones
    for(const f of STATE.features) {
      // determine which components are present for this feature
      const has = {
        psr: (f.psr_overlap != null && f.psr_overlap > 0),
        hydrogen: f.hydrogen_mean != null,
        spectral: f.spectral_mean != null,
        depth: f.depth_metric != null
      };
      // compute weights: base on DEFAULT_WEIGHTS but zero out missing components then renormalize
      let w = Object.assign({}, DEFAULT_WEIGHTS);
      let tot = 0;
      for(const k of Object.keys(w)) { if(!has[k]) w[k] = 0; tot += w[k]; }
      if(tot === 0){
        // if everything missing, fallback: use spectral if any, else hydrogen, else depth, else PSR flag
        if(has.spectral) { w = { spectral: 1, hydrogen:0, psr:0, depth:0 }; }
        else if(has.hydrogen) { w = { hydrogen:1, spectral:0, psr:0, depth:0 }; }
        else if(has.psr) { w = { psr:1, spectral:0, hydrogen:0, depth:0 }; }
        else if(has.depth) { w = { depth:1, spectral:0, hydrogen:0, psr:0 }; }
        else { w = { psr:0.5, spectral:0.25, hydrogen:0.15, depth:0.10 }; } // arbitrary fallback
      } else {
        // renormalize
        const scale = 1 / tot;
        Object.keys(w).forEach(k => w[k] *= scale);
      }
      // compute water score
      const comp_psr = f._norm.psr != null ? f._norm.psr : 0;
      const comp_spec = f._norm.spectral != null ? f._norm.spectral : 0;
      const comp_hyd = f._norm.hydrogen != null ? f._norm.hydrogen : 0;
      const comp_dep = f._norm.depth != null ? f._norm.depth : 0;
      const score = (w.psr * comp_psr) + (w.hydrogen * comp_hyd) + (w.spectral * comp_spec) + (w.depth * comp_dep);
      f.water_score = Number.isFinite(score) ? score : 0;
      f._weights_used = w;
    }

    STATE._scoresComputed = true;
    setLoader('');
    if(DEBUG) console.log('Scores computed, sample:', STATE.features.slice(0,6).map(f=>({id:f.id, score:f.water_score, weights:f._weights_used})));
    return true;
  }

  /* ===========================
     SUGGESTION GENERATION (if suggestions.json missing)
     - uses computed water_score, PSR, cluster proximity, and diameter heuristics
     =========================== */
  async function computeSuggestions(){
    // if suggestions.json exists and loaded earlier, use it
    if(STATE.suggestions && STATE.suggestions.length > 0){
      return STATE.suggestions;
    }
    // compute scores if not yet done
    await computePerCraterMetricsAndScores();

    // heuristic: pick features with water_score above threshold OR PSR overlap > 0 and reasonable size
    const candidates = [];
    for(const f of STATE.features){
      // require lat/lon
      if(f.lat == null || f.lon == null) continue;
      const score = f.water_score != null ? f.water_score : 0;
      // criteria
      if(score >= 0.5) { candidates.push(Object.assign({}, f)); continue; }
      // PSR strong candidate
      if(f.psr_overlap && f.psr_overlap > 0.25 && (f.diameter_m && f.diameter_m > 2000)) { candidates.push(Object.assign({}, f)); continue; }
      // spectral/hydrogen bump
      if((f.spectral_mean != null && f.spectral_mean > 0.6) || (f.hydrogen_mean != null && f.hydrogen_mean > 0.6)) { candidates.push(Object.assign({}, f)); continue; }
    }
    // sort descending by water_score (or fallback heuristics)
    candidates.sort((a,b) => (b.water_score || 0) - (a.water_score || 0));

    // spatial clustering: reduce candidates to one per cluster if many close by (simple grid snap)
    const final = [];
    const seenGrid = new Set();
    const GRID_DEG = 0.02; // ~2km at poles approx (coarse)
    for(const c of candidates){
      const gx = Math.round(c.lon / GRID_DEG);
      const gy = Math.round(c.lat / GRID_DEG);
      const key = gx + ':' + gy;
      if(seenGrid.has(key)) continue;
      seenGrid.add(key);
      final.push(c);
    }

    // limit to top 30
    STATE.suggestions = final.slice(0, 30).map(s => ({ id: s.id, name: s.name, lat:s.lat, lon:s.lon, water_score: s.water_score }));
    console.log('Computed suggestions count', STATE.suggestions.length);
    return STATE.suggestions;
  }

  /* ===========================
     DETECTION: Local detector for "new patterns"
     - heuristic detection that finds spatial clusters of high-scoring features
     - also flags features with unusually high spectral/hydrogen values
     =========================== */
  function detectLocalCandidates(opts = { scoreThresh: 0.45, spectralThresh: null, hydrogenThresh: null, clusterRadiusKm: 20 }){
    if(!STATE.features || STATE.features.length === 0){ toast('No features loaded'); return []; }
    // thresholds
    const st = opts.scoreThresh || 0.45;
    const spectT = opts.spectralThresh || null;
    const hydT = opts.hydrogenThresh || null;
    const clusterDeg = (opts.clusterRadiusKm || 20) / 111.0;

    const flagged = [];
    // first pass: threshold
    for(const f of STATE.features){
      const score = f.water_score || 0;
      const spec = f.spectral_mean;
      const hyd = f.hydrogen_mean;
      let pick = false;
      if(score >= st) pick = true;
      if(spectT != null && spec != null && spec >= spectT) pick = true;
      if(hydT != null && hyd != null && hyd >= hydT) pick = true;
      if(pick) flagged.push(f);
    }
    // cluster boost: select those that are in local clusters
    const grouped = [];
    for(const f of flagged){
      const near = flagged.filter(o => Math.abs(o.lat - f.lat) <= clusterDeg && Math.abs(o.lon - f.lon) <= clusterDeg);
      if(near.length >= 2) grouped.push(f);
    }
    const finalList = grouped.length > 0 ? grouped : flagged.slice(0, 40);
    // visualize as suggestions
    STATE.suggestions = finalList.map(f => ({ id: f.id, name: f.name, lat: f.lat, lon: f.lon, water_score: f.water_score }));
    // draw on map
    STATE.suggestionLayer.clearLayers();
    for(const s of STATE.suggestions){
      const c = L.circleMarker([s.lat, s.lon], { radius: 12, color:'#ff7a00', weight:2, fillOpacity:0.22 }).addTo(STATE.suggestionLayer);
      c.bindPopup(`<b>${escapeHtml(s.name)}</b><br/>score:${(s.water_score!=null? s.water_score.toFixed(3): '—')}<br/><button class="popup-accept btn small">Accept</button>`);
      c.on('popupopen', (ev) => {
        const el = ev.popup.getElement(); if(!el) return;
        const btn = el.querySelector('.popup-accept'); if(btn) btn.onclick = () => { addAnnotation(STATE.features.find(x => String(x.id) === String(s.id))); try{ ev.popup._source.closePopup(); }catch(_){} };
      });
      const el = c.getElement(); if(el) el.classList.add('pulse');
    }
    toast(`${STATE.suggestions.length} candidates detected (heuristic)`);
    showRightTab('suggestions'); // show to user
    return STATE.suggestions;
  }

  /* ===========================
     PERMISSION / UTILITIES
     =========================== */
  function escapeHtml(s){ if(s==null) return ''; return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

  /* ===========================
     PERMALINKS
     =========================== */
  function writePermalink({ zoom, lat, lon, layer, id }){
    const parts = [];
    if(zoom!=null) parts.push('z='+encodeURIComponent(zoom));
    if(lat!=null) parts.push('lat='+encodeURIComponent(lat.toFixed(6)));
    if(lon!=null) parts.push('lon='+encodeURIComponent(lon.toFixed(6)));
    if(layer) parts.push('layer='+encodeURIComponent(layer));
    if(id) parts.push('id='+encodeURIComponent(id));
    location.hash = parts.join('&');
  }
  function readPermalink(){
    const h = location.hash.replace(/^#/, '');
    if(!h) return null;
    const o = {}; h.split('&').forEach(p => { const [k,v] = p.split('='); if(k) o[k] = decodeURIComponent(v||''); });
    if(o.z) o.z = +o.z; if(o.lat) o.lat = +o.lat; if(o.lon) o.lon = +o.lon;
    return o;
  }

  /* ===========================
     LOW-LEVEL UI: wire search, export, layer radios, help
     =========================== */
  function wireLeftControls(){
    const searchInput = $id('searchInput'), searchBtn = $id('searchBtn');
    if(searchBtn) searchBtn.onclick = () => doSearch(searchInput && searchInput.value);
    if(searchInput) searchInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') doSearch(searchInput && searchInput.value); });

    const suggestBtn = $id('suggestBtn'); if(suggestBtn) suggestBtn.onclick = async () => {
      const sfile = await loadSuggestionsFile();
      if(sfile && sfile.length) { STATE.suggestions = sfile; toast('Loaded suggestions.json'); showRightTab('suggestions'); renderSuggestionsPanel($id('tab-content')); } 
      else { // run detect fallback
        detectLocalCandidates();
      }
    };

    const exportBtn = $id('exportBtn'); if(exportBtn) exportBtn.onclick = () => {
      const anns = loadAnnotationsFromStorage();
      const fc = { type: 'FeatureCollection', features: anns.map(a => ({ type:'Feature', properties: { id:a.id, name:a.name, water_score:a.water_score, ts:a.ts }, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } })) };
      const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'embiggen_annotations.geojson'; a.click(); URL.revokeObjectURL(url); toast('Annotations exported');
    };

    const helpBtn = $id('helpBtn'); if(helpBtn) helpBtn.onclick = ()=> {
      alert('EmbiggenEye Help:\n- Search by crater name/ID\n- Suggest: load suggestions.json or run Detect\n- Accept: annotate candidates locally\n- Comment: add notes to a feature\n- Export: download annotations.geojson\n- Press Ctrl/Cmd+S to try side-by-side view (Visible vs IR)');
    };

    // layer radios
    $qsa('input[name="layer"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        if(e.target.checked) {
          setLayer(e.target.value);
        }
      });
    });
  }

  function doSearch(q){
    if(!q || !String(q).trim()){ toast('Type a crater name or id'); return; }
    const s = String(q).trim().toLowerCase();
    const found = STATE.features.find(f => (f.name && String(f.name).toLowerCase().includes(s)) || (String(f.id).toLowerCase() === s));
    if(!found){ toast('No crater matched'); return; }
    const rec = STATE.featureMap.get(String(found.id));
    if(rec && rec.marker){ rec.marker.fire('click'); rec.marker.openPopup(); } else { highlightFeatureOnMap(found); populateRightPanelDetails(found); STATE.map.setView([found.lat, found.lon], Math.min(MAX_MAP_ZOOM, 4)); }
    writePermalink({ zoom: STATE.map.getZoom(), lat: found.lat, lon: found.lon, layer: STATE.currentLayerName, id: found.id });
  }

  function setLayer(name){
    STATE.currentLayerName = name;
    // remove all
    Object.values(STATE.tileLayers).forEach(t => { try { STATE.map.removeLayer(t) } catch(_){} });
    // add chosen
    const tl = STATE.tileLayers[name];
    if(tl) STATE.map.addLayer(tl);
  }

  // side-by-side lazy loader (Ctrl/Cmd+S)
  function wireSideBySideShortcut(){
    window.addEventListener('keydown', (ev) => {
      if((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's'){ ev.preventDefault(); enableSideBySide(); }
    });
  }
  async function enableSideBySide(){
    if(window.SideBySide){ // toggle
      if(window.sideBySideControl){ window.sideBySideControl.remove(); window.sideBySideControl = null; toast('Side-by-side removed'); return; }
      window.sideBySideControl = L.control.sideBySide(STATE.tileLayers.vis, STATE.tileLayers.ir).addTo(STATE.map);
      toast('Side-by-side enabled');
      return;
    }
    try {
      await loadScript('https://unpkg.com/leaflet-side-by-side/leaflet-side-by-side.min.js');
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet-side-by-side/leaflet-side-by-side.css'; document.head.appendChild(css);
      window.sideBySideControl = L.control.sideBySide(STATE.tileLayers.vis, STATE.tileLayers.ir).addTo(STATE.map);
      toast('Side-by-side enabled (Visible / IR)');
    } catch(e){
      toast('Side-by-side failed to load');
    }
  }

  /* ===========================
     ENTRYPOINT: initialize everything (load features, psr, map, compute scores, render)
     =========================== */
  async function startApp(){
    try{
      setLoader('Starting EmbiggenEye…');
      // init map
      initMap();
      // wire left controls (search, suggest etc.)
      wireLeftControls();
      wireSideBySideShortcut();
      // ensure right panel tabs exist
      ensureRightPanelTabs();
      // load features
      const raw = await loadFeatures();
      if(!(raw && raw.length > 0)) {
        // nothing to display; show fallback message
        toast('No features found — add features.json or features_part*.json into docs/');
        populateRightPanelDetails(null);
        setLoader('');
        return;
      }
      // normalize & store features
      STATE.features = raw.map(r => normalizeRow(r));
      // quick diagnostics
      const cnt = STATE.features.length;
      console.log('Features loaded:', cnt);
      // load PSR if available
      await loadPSR(); // will set STATE.psrGeojson or null
      // compute metrics & scores (will lazy-load Turf if PSR present)
      await computePerCraterMetricsAndScores();
      // build markers
      await renderAllFeaturesToMap();
      // load suggestions.json if present, else compute suggestions later on demand
      await loadSuggestionsFile().catch(()=>{ /* ignore */ });
      // refresh annotations UI
      refreshAnnotationsListInLeftPanel();
      // show debug info
      showRightTab('debug');
      setLoader('');
      toast('EmbiggenEye ready — suggestions in right panel');
      // try restore permalink if present
      applyPermalinkIfAny();
    } catch(e){
      console.error('startApp error', e);
      setLoader('');
      toast('Initialization failed (see console)');
    }
  }

  // render features into cluster & build featureMap
  async function renderAllFeaturesToMap(){
    setLoader('Rendering features onto map…');
    STATE.markerCluster.clearLayers();
    STATE.featureMap.clear();
    // prep annotation layer from storage
    const anns = loadAnnotationsFromStorage();
    for(const a of anns){
      try{
        const m = L.circleMarker([a.lat, a.lon], { radius:10, color:'#2ee6a1', weight:1.6, fillOpacity:0.7 }).addTo(STATE.annotationLayer);
        m.bindPopup(`<b>${escapeHtml(a.name)}</b><br/>annotated`);
      }catch(e){ /* ignore invalid coords */ }
    }
    let added=0, skipped=0;
    for(const f of STATE.features){
      if(f.lat==null || f.lon==null){
        skipped++; continue;
      }
      const mark = createMarker(f);
      if(mark){ STATE.markerCluster.addLayer(mark); STATE.featureMap.set(String(f.id), { feature: f, marker: mark }); added++; }
      else skipped++;
    }
    setLoader('');
    console.log(`Rendered features: added=${added}, skipped=${skipped} (see console for sample)`);
    toast(`Rendered ${added} craters (skipped ${skipped})`);
    return { added, skipped };
  }

  function applyPermalinkIfAny(){
    const p = readPermalink();
    if(!p) return;
    if(p.layer) {
      const r = document.querySelector(`input[name="layer"][value="${p.layer}"]`);
      if(r) r.checked = true;
      setLayer(p.layer);
    }
    if(p.lat != null && p.lon != null){
      STATE.map.setView([p.lat, p.lon], (p.z || 3));
    }
    if(p.id){
      setTimeout(()=> {
        const rec = STATE.featureMap.get(String(p.id));
        if(rec && rec.marker){ rec.marker.fire('click'); rec.marker.openPopup(); } else {
          console.log('Permalink requested id not found in featureMap:', p.id);
        }
      }, 700);
    }
  }

  /* ===========================
     BOOT
     =========================== */
  document.addEventListener('DOMContentLoaded', () => {
    // start the app
    startApp();
  });

  /* ===========================
     EXPOSE internals for debugging from console
     =========================== */
  window.EMBIGEN = window.EMBIGEN || {};
  Object.assign(window.EMBIGEN, {
    STATE,
    computePerCraterMetricsAndScores,
    computeSuggestions,
    detectLocalCandidates,
    refreshAnnotationsListInLeftPanel,
    renderAllFeaturesToMap,
    loadFeatures,
    loadPSR,
    loadSuggestionsFile
  });

  /* ===========================
     FEEDBACK NOTE (auto)
     - After loading, if you're missing suggestions / PSR / spectral/hydrogen:
       * Open browser console (F12) and check logs produced by this script:
         - "Features loaded:" shows how many rows were read.
         - The Debug panel (Right tab) shows counts of missing fields.
       * If features are skipped (skipped>0) because of missing lat/lon, either:
         - add lat/lon to those features, or
         - ensure x/y pixel fields exist (the app will attempt a pixel-spread fallback),
         - or run the computePerCraterMetricsAndScores and renderAllFeaturesToMap and inspect console sample rows.
     - If PSR-based scoring is not happening, ensure psr.geojson exists at docs/psr.geojson or docs/static/psr.geojson
     - If spectral/hydrogen values are not present in features.json, the app cannot compute them from raw rasters client-side (you must precompute per-crater aggregates server-side or in preprocessing scripts and put them into features.json).
     =========================== */

  // end IIFE
})();
