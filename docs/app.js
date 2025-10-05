/*
  app.js — EmbiggenEye
  --------------------
  Production-ready (static-first) frontend for the NASA Space Apps "Embiggen Your Eyes"
  - GeoJSON-aware: reads FeatureCollection or flat arrays; accepts features_part*.json and features.json
  - Robust coordinate detection (properties.*, geometry.coordinates, alternate names)
  - Tile layers: Visible, IR, Elevation, Index (errorTile fallback)
  - PSR overlap computation (uses turf.js if psr.geojson present)
  - Water scoring fallback: weights redistributed if fields missing
  - Suggestions: loads suggestions.json or generates top-N heuristics from features
  - Annotation + comment flow: localStorage, export/import, visual markers
  - Clustering (leaflet.markercluster), highlight circle, single-highlight behavior
  - Side-by-side compare (loads leaflet-side-by-side dynamically on demand)
  - Permalink encoding of map state (#z=...&lat=...&lon=...&layer=...&id=...)
  - Debug & performance mode for very large catalogs (batch PSR computation with yield)
  - Friendly to be hosted on GitHub Pages (PAGE_BASE auto-detected)

  How to install:
  - Replace your existing app.js with this file in docs/ and keep index.html + styles.css as before.
  - Place tiles under docs/tiles/... or rely on blank-tile fallback.
  - Place features.json (GeoJSON FeatureCollection) at docs/features.json (or features_part1.json etc.)
  - Optional: psr.geojson, suggestions.json, tiles for IR/Elev/Index.

  NOTE: This file is long and intentionally robust. Read comments to understand each section.
*/

(function(){
  'use strict';

  // ---------- CONFIGURATION ----------
  // Toggle debug logs
  const DEBUG = false; // set true for verbose console logs

  // Tile / dataset filenames (relative to PAGE_BASE)
  const FEATURE_PARTS = ['features_part1.json','features_part2.json','features_part3.json'];
  const FEATURE_SINGLE = 'features.json';
  const SUGGESTIONS_FILE = 'suggestions.json';
  const PSR_FILE = 'psr.geojson';
  const BLANK_TILE = 'static/blank-tile.png';

  // Map options
  const MAX_MAP_ZOOM = 5; // demo tiles maximum
  const DEFAULT_VIEW = { lat: -89.6, lon: -45.0, z: 2 }; // south-pole oriented default

  // Water score weights (base). If any components missing, weights are redistributed.
  const DEFAULT_WEIGHTS = { psr: 0.35, hydrogen: 0.30, spectral: 0.30, depth: 0.05 };

  // Annotation localStorage key
  const ANNOTATION_KEY = 'embiggen_annotations_v1';

  // UI selectors - these should match your index.html
  const UI = {
    mapContainer: '#map',
    toast: '#toast',
    loader: '#loader',
    searchInput: '#searchInput',
    searchBtn: '#searchBtn',
    suggestBtn: '#suggestBtn',
    exportBtn: '#exportBtn',
    helpBtn: '#helpBtn',
    annotationsList: '#annotationsList',
    featureDetails: '#featureDetails'
  };

  // ---------- UTILS ----------
  function log(...args){ if(DEBUG) console.log('[EMBIGEN]', ...args); }
  function warn(...args){ console.warn('[EMBIGEN]', ...args); }
  function err(...args){ console.error('[EMBIGEN]', ...args); }

  function whenReady(){
    return new Promise(resolve => {
      if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ()=> resolve());
      else resolve();
    });
  }

  function computePageBase(){
    // returns a path like '/your/repo/docs/' for GitHub Pages friendly relative loading
    let path = window.location.pathname || '/';
    // remove trailing filename if any
    if(path.indexOf('.') !== -1) path = path.substring(0, path.lastIndexOf('/')+1);
    if(!path.endsWith('/')) path = path + '/';
    return path;
  }

  const PAGE_BASE = computePageBase();
  log('PAGE_BASE', PAGE_BASE);

  function toast(msg, t = 2500){
    const el = document.querySelector(UI.toast);
    if(!el){ console.log('TOAST', msg); return; }
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(el._timer);
    el._timer = setTimeout(()=> el.classList.remove('visible'), t);
  }

  function setLoader(txt){
    const el = document.querySelector(UI.loader);
    if(!el) return;
    if(txt){ el.style.display = 'block'; el.textContent = txt; }
    else { el.style.display = 'none'; el.textContent = ''; }
  }

  async function fetchJSON(url, opts = {}){
    const r = await fetch(url, Object.assign({cache:'no-cache'}, opts));
    if(!r.ok) throw new Error(`${url} -> ${r.status}`);
    return await r.json();
  }

  function safeNum(v){ if(v===undefined || v===null || v==='') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
  function clamp01(v){ if(v==null || Number.isNaN(v)) return 0; return Math.max(0, Math.min(1, v)); }

  function escapeHtml(s){ if(s==null) return ''; return String(s).replace(/[&<>'"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[c]); }

  // ---------- STATE ----------
  const STATE = {
    map: null,
    layerTiles: {},
    markerCluster: null,
    suggestionLayer: null,
    annotationLayer: null,
    highlightLayer: null,
    featuresRaw: [], // raw records as loaded (Feature objects or properties)
    features: [], // normalized feature objects used by UI
    featureMap: new Map(), // id -> { feature, marker }
    suggestions: [],
    psrGeo: null,
    turfLoaded: false,
    annotationsKey: ANNOTATION_KEY,
    sideBySideActive: false,
    sideBySideControl: null
  };

  window.EMBIGEN = window.EMBIGEN || {};
  window.EMBIGEN.STATE = STATE;

  // ---------- LEAFLET + TILES ----------
  function makeTileTemplate(name){
    return PAGE_BASE + `tiles/${name}/{z}/{x}/{y}.png`;
  }

  function tileLayerFromTemplate(template){
    const errTile = PAGE_BASE + BLANK_TILE;
    return L.tileLayer(template, { maxZoom: MAX_MAP_ZOOM, tileSize: 256, noWrap: true, errorTileUrl: errTile });
  }

  function initMap(){
    if(STATE.map) return STATE.map;
    const map = L.map(document.querySelector(UI.mapContainer).id, { preferCanvas: true, maxZoom: MAX_MAP_ZOOM }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.z);
    STATE.map = map;

    // tile layers
    STATE.layerTiles.vis = tileLayerFromTemplate(makeTileTemplate('layer_vis'));
    STATE.layerTiles.ir = tileLayerFromTemplate(makeTileTemplate('layer_ir'));
    STATE.layerTiles.elev = tileLayerFromTemplate(makeTileTemplate('layer_elev'));
    STATE.layerTiles.index = tileLayerFromTemplate(makeTileTemplate('layer_index'));

    // add default
    STATE.layerTiles.vis.addTo(map);

    // layer control
    const baseLayers = { 'Visible': STATE.layerTiles.vis };
    const overlays = {};
    L.control.layers(baseLayers, overlays, { collapsed: true }).addTo(map);

    // marker cluster
    STATE.markerCluster = L.markerClusterGroup({ chunkedLoading:true, showCoverageOnHover:false });
    map.addLayer(STATE.markerCluster);

    // suggestion and annotation layers
    STATE.suggestionLayer = L.layerGroup().addTo(map);
    STATE.annotationLayer = L.layerGroup().addTo(map);

    // hash update on move
    map.on('moveend', updatePermalinkHash);

    // simple click handler to clear highlight if map background clicked
    map.on('click', ()=> clearHighlight());

    return map;
  }

  // ---------- FEATURE LOADING & NORMALIZATION ----------

  async function loadFeaturesRaw(){
    setLoader('Loading feature catalog…');
    let raw = [];

    // try parts first
    for(const part of FEATURE_PARTS){
      try{
        const url = PAGE_BASE + part;
        const obj = await fetchJSON(url).catch(()=> null);
        if(obj){
          if(Array.isArray(obj)) raw = raw.concat(obj);
          else if(obj.type && obj.type.toLowerCase()==='featurecollection' && Array.isArray(obj.features)) raw = raw.concat(obj.features);
          else if(obj.features && Array.isArray(obj.features)) raw = raw.concat(obj.features);
        }
      }catch(e){ log('part not loaded', part, e.message); }
    }

    // if none loaded try single
    if(raw.length === 0){
      try{
        const url = PAGE_BASE + FEATURE_SINGLE;
        const obj = await fetchJSON(url).catch(()=> null);
        if(obj){
          if(Array.isArray(obj)) raw = raw.concat(obj);
          else if(obj.type && obj.type.toLowerCase()==='featurecollection' && Array.isArray(obj.features)) raw = raw.concat(obj.features);
          else if(obj.features && Array.isArray(obj.features)) raw = raw.concat(obj.features);
          else if(obj.properties || obj.geometry) raw.push(obj);
        }
      }catch(e){ log('single features not loaded', e.message); }
    }

    // fallback: try bare filenames without PAGE_BASE
    if(raw.length === 0){
      for(const part of FEATURE_PARTS.concat([FEATURE_SINGLE])){
        try{ const obj = await fetchJSON(part).catch(()=> null); if(obj){ if(Array.isArray(obj)) raw = raw.concat(obj); else if(obj.type && obj.type.toLowerCase()==='featurecollection' && Array.isArray(obj.features)) raw = raw.concat(obj.features); else if(obj.features && Array.isArray(obj.features)) raw = raw.concat(obj.features); } }catch(e){}
      }
    }

    // final fallback: none
    if(raw.length === 0){ setLoader('No features found'); toast('No features found — put features.json in docs/'); return []; }

    STATE.featuresRaw = raw;
    setLoader('Features loaded');
    log('raw features count', raw.length);
    return raw;
  }

  function normalizeFeatureRecord(rec){
    // Accept rec in three shapes: plain properties object, GeoJSON Feature, or arbitrary object
    let props = {}; let geom = null;
    if(rec == null) return null;
    if(rec.properties){ props = Object.assign({}, rec.properties); geom = rec.geometry || null; }
    else if(rec.geometry && rec.type && rec.type.toLowerCase()==='feature'){ props = Object.assign({}, rec.properties || {}); geom = rec.geometry; }
    else { props = Object.assign({}, rec); geom = rec._geometry || null; }

    // helper to extract numeric coordinate
    function extractLatLon(){
      // priority: explicit numeric props.lat & props.lon
      let lat = safeNum(props.lat ?? props.latitude ?? props.Lat ?? props.center_lat);
      let lon = safeNum(props.lon ?? props.longitude ?? props.Long ?? props.center_lon);
      if(lat==null || lon==null){
        // geometry coordinates if present (GeoJSON: [lon, lat])
        if(geom && Array.isArray(geom.coordinates)){
          lon = safeNum(geom.coordinates[0]);
          lat = safeNum(geom.coordinates[1]);
        }
      }
      if(lat==null || lon==null){
        // alternative properties
        const altLat = props.Y ?? props.y ?? props.pixel_y ?? props.PIXEL_Y ?? props.latitude_deg;
        const altLon = props.X ?? props.x ?? props.pixel_x ?? props.PIXEL_X ?? props.longitude_deg;
        lat = lat == null ? safeNum(altLat) : lat;
        lon = lon == null ? safeNum(altLon) : lon;
      }
      return { lat, lon };
    }

    const { lat, lon } = extractLatLon();

    // diameter in meters
    let diameter_m = safeNum(props.diameter_m ?? props.diam_m ?? props.DIAMETER_M);
    if(diameter_m == null){
      // maybe provided in km
      const km = safeNum(props.diameter_km ?? props.diameter_km_ ?? props.DIAMETER_KM);
      if(km != null) diameter_m = km * 1000;
      else {
        // other fallback
        const d = safeNum(props.diameter ?? props.diam);
        diameter_m = d != null && d>1000 ? d : (d!=null && d<1000 ? d*1000 : null);
      }
    }

    // numeric science fields
    const spectral_mean = safeNum(props.spectral_mean ?? props.spec ?? props.m3 ?? props.SPECTRAL_MEAN);
    const hydrogen_mean = safeNum(props.hydrogen_mean ?? props.hydro ?? props.hydrogen ?? props.HYDROGEN_MEAN);
    const depth_metric = safeNum(props.depth_metric ?? props.depth ?? props.DEPTH_METRIC);

    // psr overlap may be boolean or numeric
    let psr_overlap = null;
    if(props.psr_overlap === true) psr_overlap = 1;
    else if(props.psr_overlap === false) psr_overlap = 0;
    else psr_overlap = safeNum(props.psr_overlap ?? props.PSR_OVERLAP);

    // water_score may be present or will be computed
    let water_score = safeNum(props.water_score ?? props.score ?? props.WATER_SCORE);

    // id/name
    const id = (props.id ?? props.ID ?? props.CRATER_ID ?? props.name ?? props.NAME) + '';
    const name = props.name || props.NAME || id || `f_${Math.random().toString(36).slice(2,8)}`;

    // build normalized object
    const out = {
      id: id || name,
      name: name,
      lat: lat,
      lon: lon,
      diameter_m: diameter_m,
      spectral_mean: spectral_mean,
      hydrogen_mean: hydrogen_mean,
      depth_metric: depth_metric,
      psr_overlap: psr_overlap,
      water_score: water_score,
      raw: rec,
      _geometry: geom
    };

    return out;
  }

  function normalizeAllFeatures(rawList){
    const out = rawList.map(normalizeFeatureRecord).filter(x => x != null);
    // compute fallback water_score for those missing
    computeFallbackScores(out);
    return out;
  }

  function computeFallbackScores(list){
    // collects arrays for normalization
    const specArr = list.map(f=>f.spectral_mean).filter(v=>v!=null);
    const hydArr = list.map(f=>f.hydrogen_mean).filter(v=>v!=null);
    const depArr = list.map(f=>f.depth_metric).filter(v=>v!=null);
    const psrArr = list.map(f=>f.psr_overlap).filter(v=>v!=null);

    function makeNorm(arr){ if(!arr || arr.length===0) return v=>0; const mn = Math.min(...arr); const mx = Math.max(...arr); const span = (mx-mn) || 1; return v => (v==null ? 0 : Math.max(0, Math.min(1, (v-mn)/span))); }
    const normSpec = makeNorm(specArr);
    const normHyd = makeNorm(hydArr);
    const normDep = makeNorm(depArr);
    const normPsr = makeNorm(psrArr);

    for(const f of list){
      if(f.water_score != null) continue; // keep precomputed
      const ns = normSpec(f.spectral_mean);
      const nh = normHyd(f.hydrogen_mean);
      const nd = normDep(f.depth_metric);
      const np = normPsr(f.psr_overlap);

      // copy default weights then zero out for missing
      const w = Object.assign({}, DEFAULT_WEIGHTS);
      if(f.psr_overlap == null) w.psr = 0;
      if(f.hydrogen_mean == null) w.hydrogen = 0;
      if(f.spectral_mean == null) w.spectral = 0;
      if(f.depth_metric == null) w.depth = 0;
      const total = (w.psr + w.hydrogen + w.spectral + w.depth) || 1;
      w.psr /= total; w.hydrogen /= total; w.spectral /= total; w.depth /= total;
      const score = w.psr * np + w.hydrogen * nh + w.spectral * ns + w.depth * nd;
      f.water_score = Number.isFinite(score) ? Number(score.toFixed(6)) : 0;
      f._computed = true;
      f._norm = { ns, nh, nd, np };
      f._weights = w;
    }
  }

  // ---------- PSR LOADING & OVERLAP CALCULATION (client-side) ----------
  async function loadPSR(){
    // try multiple paths for resilient loading
    const paths = [ PAGE_BASE + PSR_FILE, PSR_FILE, 'docs/' + PSR_FILE ];
    let psr = null; let used = null;
    for(const p of paths){
      try{
        const r = await fetch(p, { cache: 'no-cache' });
        if(r.ok){ psr = await r.json(); used = p; break; }
      }catch(e){}
    }
    if(!psr){ log('No PSR file found'); return null; }
    STATE.psrGeo = psr;
    toast('PSR loaded');
    log('psr features', psr.features && psr.features.length);
    return psr;
  }

  async function ensureTurfLoaded(){
    if(window.turf){ STATE.turfLoaded = true; return window.turf; }
    // load from CDN
    await new Promise((resolve, reject)=>{
      const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js'; s.onload = ()=> resolve(); s.onerror = ()=> reject(new Error('Failed to load turf')); document.head.appendChild(s);
    });
    STATE.turfLoaded = !!window.turf;
    return window.turf;
  }

  async function computePSROverlapBatch(batchSize = 1000, yieldMs = 8){
    if(!STATE.psrGeo) await loadPSR();
    if(!STATE.psrGeo){ toast('No PSR file — skipping PSR pass'); return; }
    await ensureTurfLoaded();
    if(!window.turf){ warn('Turf failed to load'); return; }

    setLoader('Computing PSR overlap (client-side) — this may take time for many features');
    const features = STATE.features;
    const psrFeatures = STATE.psrGeo.features || [];

    // pre-sanitize: build PSR geometries list to speed up checks
    const psrGeoms = psrFeatures.map(f => f.geometry).filter(g=>g);

    let processed = 0;
    for(let i = 0; i < features.length; i++){
      const f = features[i];
      if(f.lat == null || f.lon == null) { processed++; continue; }
      // radius in meters (half diameter), minimum 50m
      const radius = (f.diameter_m ? Number(f.diameter_m)/2.0 : 200);
      try{
        const circle = turf.circle([f.lon, f.lat], (radius/1000), { units:'kilometers', steps:32 });
        let intersectionArea = 0;
        for(const pg of psrGeoms){
          try{
            const inter = turf.intersect(circle, pg);
            if(inter) intersectionArea += turf.area(inter);
          }catch(e){ /* ignore tiny errors */ }
        }
        const craterArea = turf.area(circle) || 1;
        f.psr_overlap = clamp01(intersectionArea / craterArea);
      }catch(e){ if(DEBUG) console.log('PSR compute error for', f.id, e); f.psr_overlap = f.psr_overlap == null ? 0 : f.psr_overlap; }

      processed++;
      // batch yield
      if(processed % batchSize === 0){
        log('PSR processed', processed, 'of', features.length);
        await new Promise(r=> setTimeout(r, yieldMs));
      }
    }

    // recompute fallback scores now that psr fields updated
    computeFallbackScores(features);
    setLoader('PSR pass complete');
    toast('PSR overlap computed');
    // re-render map
    renderFeatures(features);
  }

  // ---------- RENDERING: MARKERS, POPUPS, HIGHLIGHT ----------
  function scoreToColour(s){
    // blue -> green -> orange -> red mapping based on [0..1]
    const v = clamp01(s);
    const r = Math.round(255 * Math.min(1, Math.max(0, (v-0.5)*2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5-v)*2)));
    const g = Math.round(255 * (1 - Math.abs(v-0.5)*2));
    return `rgb(${r},${g},${b})`;
  }

  function diameterToVisualPx(d){
    if(!d) return 6;
    const km = Math.max(0.001, d/1000);
    return Math.min(48, Math.max(6, 6 + Math.log10(km+1)*14));
  }

  function clearHighlight(){ if(STATE.highlightLayer){ try{ STATE.map.removeLayer(STATE.highlightLayer); }catch(e){} STATE.highlightLayer = null; } }

  function showHighlight(feature){
    clearHighlight();
    if(!feature || feature.lat==null || feature.lon==null) return;
    const r = (feature.diameter_m ? feature.diameter_m/2.0 : 2000);
    STATE.highlightLayer = L.circle([feature.lat, feature.lon], { radius: r, color:'#00ffff', weight:2.4, fillOpacity:0.04 }).addTo(STATE.map);
    try{ STATE.map.setView([feature.lat, feature.lon], Math.min(MAX_MAP_ZOOM, Math.max(3, STATE.map.getZoom()))); }catch(e){}
  }

  function buildPopupHtml(f){
    const diam = f.diameter_m ? `${Math.round(f.diameter_m)} m (${(f.diameter_m/1000).toFixed(2)} km)` : '—';
    const score = f.water_score != null ? f.water_score.toFixed(4) : '—';
    const spec = f.spectral_mean != null ? f.spectral_mean.toFixed(4) : '—';
    const hydro = f.hydrogen_mean != null ? f.hydrogen_mean.toFixed(4) : '—';
    const depth = f.depth_metric != null ? f.depth_metric.toFixed(4) : '—';
    const psr = f.psr_overlap != null ? ( (f.psr_overlap>0)? (f.psr_overlap*100).toFixed(1)+'%':'0%' ) : '—';
    return `\n      <div class="popup-card">\n        <h4 style="margin:0 0 6px 0">${escapeHtml(f.name)}</h4>\n        <table class="popup-table" style="width:100%;font-size:13px">\n          <tr><td>water_score</td><td style="text-align:right"><b>${escapeHtml(String(score))}</b></td></tr>\n          <tr><td>PSR overlap</td><td style="text-align:right">${escapeHtml(String(psr))}</td></tr>\n          <tr><td>diameter</td><td style="text-align:right">${escapeHtml(String(diam))}</td></tr>\n          <tr><td>spectral_mean</td><td style="text-align:right">${escapeHtml(String(spec))}</td></tr>\n          <tr><td>hydrogen_mean</td><td style="text-align:right">${escapeHtml(String(hydro))}</td></tr>\n          <tr><td>depth_metric</td><td style="text-align:right">${escapeHtml(String(depth))}</td></tr>\n        </table>\n        <div style="margin-top:8px;text-align:right">\n          <button class="btn small popup-accept">Accept</button>\n          <button class="btn small ghost popup-comment">Comment</button>\n          <button class="btn small ghost popup-perm">Permalink</button>\n        </div>\n      </div>\n    `;
  }

  function createFeatureMarker(f){
    if(f.lat==null || f.lon==null) return null;
    const r = diameterToVisualPx(f.diameter_m);
    const color = scoreToColour(f.water_score || 0);
    const marker = L.circleMarker([f.lat, f.lon], { radius: Math.max(6, Math.min(36, r)), color: color, weight: 1.2, fillOpacity: 0.8 });
    marker.featureId = f.id;
    marker._feature = f;
    marker.bindPopup(buildPopupHtml(f), { minWidth: 220 });
    marker.on('click', ()=>{ try{ marker.openPopup(); }catch(e){} showHighlight(f); populateRightPanel(f); });
    marker.on('popupopen', (ev)=>{
      const el = ev.popup.getElement(); if(!el) return;
      const accept = el.querySelector('.popup-accept'); if(accept) accept.onclick = ()=>{ addAnnotation(f); try{ ev.popup._source.closePopup(); }catch(e){} };
      const comment = el.querySelector('.popup-comment'); if(comment) comment.onclick = ()=>{ promptComment(f); };
      const perm = el.querySelector('.popup-perm'); if(perm) perm.onclick = ()=>{ setPermalinkForFeature(f); toast('Permalink updated in URL hash'); };
    });
    return marker;
  }

  function renderFeatures(list){
    if(!STATE.map) initMap();
    if(!STATE.markerCluster) STATE.markerCluster = L.markerClusterGroup({ chunkedLoading:true });
    STATE.markerCluster.clearLayers(); STATE.featureMap.clear();

    let placed = 0; let skipped = 0;
    for(const f of list){
      if(f.lat == null || f.lon == null){ skipped++; continue; }
      const m = createFeatureMarker(f);
      if(m){ STATE.markerCluster.addLayer(m); STATE.featureMap.set(String(f.id), { feature: f, marker: m }); placed++; }
      else skipped++;
    }

    if(!STATE.map.hasLayer(STATE.markerCluster)) STATE.map.addLayer(STATE.markerCluster);
    toast(`Rendered ${placed} features (skipped ${skipped})`);
    log('renderFeatures done', placed, skipped);

    // update annotations overlay from localStorage
    restoreAnnotationsOnMap();
  }

  // ---------- SUGGESTIONS ----------
  async function loadSuggestionsFile(){
    const candidates = [ PAGE_BASE + SUGGESTIONS_FILE, SUGGESTIONS_FILE, 'docs/' + SUGGESTIONS_FILE ];
    for(const p of candidates){
      try{
        const r = await fetch(p, { cache: 'no-cache' });
        if(r.ok){ const data = await r.json(); log('suggestions loaded from', p); return data; }
      }catch(e){}
    }
    return null;
  }

  async function showSuggestions(n=100){
    let suggestions = await loadSuggestionsFile();
    if(suggestions == null){
      // generate heuristically
      suggestions = generateSuggestionsFromFeatures(n);
      toast('Generated suggestions from features');
    }
    // normalize shape: suggestions may be {suggestions: [...]}
    if(suggestions && suggestions.suggestions && Array.isArray(suggestions.suggestions)) suggestions = suggestions.suggestions;
    if(!Array.isArray(suggestions)) return toast('No suggestions available');

    STATE.suggestions = suggestions;
    STATE.suggestionLayer.clearLayers();

    for(const s of suggestions){
      const nf = normalizeFeatureRecord(s);
      if(nf.lat==null || nf.lon==null) continue;
      const circle = L.circleMarker([nf.lat, nf.lon], { radius: 10, color:'#ff7a00', weight:2, fillOpacity:0.22 }).addTo(STATE.suggestionLayer);
      circle.bindPopup(`<b>${escapeHtml(nf.name)}</b><br/>score: ${(nf.water_score!=null?nf.water_score.toFixed(4):'—')}<br/><button class="btn small popup-accept">Accept</button>`);
      circle.on('popupopen', (ev)=>{ const el = ev.popup.getElement(); if(!el) return; const btn = el.querySelector('.popup-accept'); if(btn) btn.onclick = ()=>{ addAnnotation(nf); try{ ev.popup._source.closePopup(); }catch(e){} }; });
      // visual pulse
      const e = circle.getElement(); if(e) e.classList.add('pulse');
    }
    toast(`${suggestions.length} suggestions shown`);
    // open suggestions tab
    const tab = document.getElementById('tab-suggestions'); if(tab) tab.click();
  }

  function generateSuggestionsFromFeatures(n=200){
    // pick top-n by water_score (computed), fallback to psr_overlap then random
    const arr = STATE.features.slice().map(f=>Object.assign({}, f));
    arr.sort((a,b)=> ( (b.water_score || 0) - (a.water_score || 0) ));
    return arr.slice(0, n).map(f => ({ id: f.id, name: f.name, lat: f.lat, lon: f.lon, diameter_m: f.diameter_m, water_score: f.water_score, components: { psr: f.psr_overlap, spec: f.spectral_mean, hydro: f.hydrogen_mean, depth: f.depth_metric } }));
  }

  // ---------- ANNOTATIONS, COMMENTS, EXPORT/IMPORT ----------
  function loadAnnotations(){ try{ return JSON.parse(localStorage.getItem(STATE.annotationsKey) || '[]'); }catch(e){ return []; } }
  function saveAnnotations(a){ localStorage.setItem(STATE.annotationsKey, JSON.stringify(a)); }

  function restoreAnnotationsOnMap(){
    STATE.annotationLayer.clearLayers();
    const anns = loadAnnotations();
    for(const a of anns){ try{ const m = L.circleMarker([a.lat, a.lon], { radius: 8, color: '#2ee6a1', weight:1.4, fillOpacity:0.7 }).addTo(STATE.annotationLayer); m.bindPopup(`<b>${escapeHtml(a.name)}</b><br/>${escapeHtml(a.id || '')}`); }catch(e){} }
    refreshAnnotationsUI();
  }

  function refreshAnnotationsUI(){
    const el = document.querySelector(UI.annotationsList);
    if(!el) return;
    const anns = loadAnnotations();
    if(!anns.length) { el.textContent = 'None yet'; return; }
    el.innerHTML = anns.map(a => `<div class="ann-row"><div><b>${escapeHtml(a.name)}</b><div style="font-size:12px;color:var(--color-muted)">${escapeHtml(a.id||'')}</div></div><div style="text-align:right;color:${scoreToColour(a.water_score||0)}">${(a.water_score!=null? a.water_score.toFixed(3):'—')}</div></div>`).join('');
  }

  function addAnnotation(feature){
    if(!feature || feature.lat==null || feature.lon==null){ toast('Cannot annotate (no coords)'); return; }
    const anns = loadAnnotations();
    if(anns.find(a=> a.id && feature.id && String(a.id) === String(feature.id))){ toast('Already annotated'); return; }
    const entry = { id: feature.id, name: feature.name, lat: feature.lat, lon: feature.lon, water_score: feature.water_score || null, ts: (new Date()).toISOString(), comment: feature._comment || null };
    anns.push(entry); saveAnnotations(anns); restoreAnnotationsOnMap(); toast('Annotation saved locally');
  }

  function promptComment(feature){
    const prev = feature._comment || '';
    const note = prompt('Add a comment for this crater:', prev);
    if(note === null) return; feature._comment = note;
    // if annotated, update stored annotation
    const anns = loadAnnotations(); const idx = anns.findIndex(a=> a.id && String(a.id) === String(feature.id)); if(idx !== -1){ anns[idx].comment = note; anns[idx].ts = (new Date()).toISOString(); saveAnnotations(anns); restoreAnnotationsOnMap(); }
    toast('Comment saved locally');
  }

  function exportAnnotations(){
    const anns = loadAnnotations();
    const fc = { type:'FeatureCollection', features: anns.map(a=> ({ type:'Feature', properties:{ id: a.id, name: a.name, water_score: a.water_score, ts: a.ts, comment: a.comment }, geometry: { type:'Point', coordinates:[a.lon, a.lat] } })) };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type:'application/geo+json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'embiggen_annotations.geojson'; a.click(); URL.revokeObjectURL(url);
    toast('Exported annotations');
  }

  async function importAnnotationsFromFile(file){
    try{
      const text = await file.text(); const data = JSON.parse(text);
      let arr = [];
      if(Array.isArray(data)) arr = data;
      else if(data.type && data.type.toLowerCase()==='featurecollection' && Array.isArray(data.features)) arr = data.features.map(f => ({ id: f.properties.id, name: f.properties.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], water_score: f.properties.water_score ?? null, comment: f.properties.comment ?? null }));
      const cur = loadAnnotations(); const merged = cur.concat(arr); saveAnnotations(merged); restoreAnnotationsOnMap(); toast('Imported annotations');
    }catch(e){ err('import annotations failed', e); toast('Failed to import annotations'); }
  }

  // ---------- PERMALINKS ----------
  function updatePermalinkHash(){
    if(!STATE.map) return;
    const c = STATE.map.getCenter(); const z = STATE.map.getZoom(); const layer = STATE.currentLayerName || 'vis';
    const parts = [`z=${z}`, `lat=${c.lat.toFixed(6)}`, `lon=${c.lng.toFixed(6)}`, `layer=${layer}`];
    location.hash = parts.join('&');
  }

  function applyPermalinkHash(){
    if(!location.hash) return;
    const hash = location.hash.replace('#',''); const kv = {};
    hash.split('&').forEach(p => { const [k,v] = p.split('='); if(k) kv[k] = v; });
    if(kv.z && STATE.map) STATE.map.setZoom(Number(kv.z));
    if(kv.lat && kv.lon && STATE.map) STATE.map.setView([Number(kv.lat), Number(kv.lon)], Number(kv.z || STATE.map.getZoom()));
    if(kv.id){ // try open feature
      const id = decodeURIComponent(kv.id);
      setTimeout(()=> { const entry = STATE.featureMap.get(String(id)); if(entry && entry.marker) { entry.marker.fire('click'); entry.marker.openPopup(); } }, 600);
    }
  }

  function setPermalinkForFeature(f){
    if(!f || f.lat==null || f.lon==null) return;
    location.hash = `z=${STATE.map.getZoom()}&lat=${f.lat.toFixed(6)}&lon=${f.lon.toFixed(6)}&id=${encodeURIComponent(f.id)}`;
  }

  // ---------- RIGHT PANEL & UI WIRING ----------
  function ensureRightPanel(){
    const root = document.querySelector(UI.featureDetails);
    if(!root) return;
    if(root._ready) return; root._ready = true;

    root.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <button id="tab-details" class="btn small ghost">Details</button>
        <button id="tab-suggestions" class="btn small ghost">Suggestions</button>
        <button id="tab-debug" class="btn small ghost">Debug</button>
        <div style="flex:1"></div>
        <button id="btn-detect" class="btn small">Detect</button>
      </div>
      <div id="tab-content" style="min-height:140px"><div class="empty">Click a crater to view details</div></div>
    `;
    document.getElementById('tab-details').addEventListener('click', ()=> showTab('details'));
    document.getElementById('tab-suggestions').addEventListener('click', ()=> showTab('suggestions'));
    document.getElementById('tab-debug').addEventListener('click', ()=> showTab('debug'));
    document.getElementById('btn-detect').addEventListener('click', ()=> { showHints('detecting'); showSuggestions(200); });
    showTab('details');
  }

  function showTab(name){ const content = document.getElementById('tab-content'); if(!content) return; ['details','suggestions','debug'].forEach(k=>{ const b=document.getElementById('tab-'+k); if(b) b.classList.toggle('active', k===name); }); if(name==='details'){ content.innerHTML = `<div class="empty">Click a crater to view details</div>`; } else if(name==='suggestions'){ content.innerHTML = `<div style="color:var(--color-muted)">Use Suggest to load suggestions.json or Detect for auto-candidates.</div>`; } else if(name==='debug'){ const total = STATE.features.length; const missCoords = STATE.features.filter(f=> f.lat==null || f.lon==null).length; const missSpec = STATE.features.filter(f=> f.spectral_mean==null).length; const missHyd = STATE.features.filter(f=> f.hydrogen_mean==null).length; const missDepth = STATE.features.filter(f=> f.depth_metric==null).length; content.innerHTML = `<div style="font-size:13px;color:var(--color-muted);padding:6px"> <div>Total features: <b>${total}</b></div> <div>Missing coords: <b>${missCoords}</b></div> <div>Missing spectral_mean: <b>${missSpec}</b></div> <div>Missing hydrogen_mean: <b>${missHyd}</b></div> <div>Missing depth_metric: <b>${missDepth}</b></div> <div style="margin-top:8px"><button id="dbg-console" class="btn small ghost">Print sample to console</button> <button id="dbg-recompute" class="btn small">Recompute scores</button></div></div>`; document.getElementById('dbg-console').onclick = ()=> console.log('features sample', STATE.features.slice(0,12)); document.getElementById('dbg-recompute').onclick = ()=>{ computeFallbackScores(STATE.features); renderFeatures(STATE.features); toast('Recomputed scores'); }; }
  }

  function populateRightPanel(f){
    ensureRightPanel(); const content = document.getElementById('tab-content'); if(!content) return; if(!f){ content.innerHTML = `<div class="empty">Click a crater to view details</div>`; return; }
    content.innerHTML = `
      <div style="padding:6px">
        <h3 style="margin:6px 0;color:var(--color-accent)">${escapeHtml(f.name)}</h3>
        <div>id: ${escapeHtml(String(f.id))}</div>
        <div style="margin-top:8px">Water score: <b style="color:${scoreToColour(f.water_score||0)}">${(f.water_score!=null? f.water_score.toFixed(4):'—')}</b></div>
        <div>PSR overlap: ${(f.psr_overlap!=null? ((f.psr_overlap*100).toFixed(1)+'%') : '—')}</div>
        <div>Diameter: ${(f.diameter_m? Math.round(f.diameter_m)+' m':'—')}</div>
        <div>Spectral: ${(f.spectral_mean!=null? f.spectral_mean.toFixed(4):'—')}</div>
        <div>Hydrogen: ${(f.hydrogen_mean!=null? f.hydrogen_mean.toFixed(4):'—')}</div>
        <div>Depth metric: ${(f.depth_metric!=null? f.depth_metric.toFixed(4):'—')}</div>
        <div style="margin-top:8px"><button id="detailAccept" class="btn small">Accept</button> <button id="detailComment" class="btn small ghost">Comment</button> <button id="detailPermalink" class="btn small ghost">Permalink</button></div>
      </div>
    `;
    document.getElementById('detailAccept').onclick = ()=> addAnnotation(f);
    document.getElementById('detailComment').onclick = ()=> promptComment(f);
    document.getElementById('detailPermalink').onclick = ()=> { setPermalinkForFeature(f); toast('Permalink set'); };
  }

  // ---------- SIDE-BY-SIDE (on-demand) ----------
  async function toggleSideBySide(){
    if(STATE.sideBySideActive){
      // disable
      if(STATE.sideBySideControl){
        try{ STATE.sideBySideControl.remove(); }catch(e){}
        STATE.sideBySideControl = null;
      }
      STATE.sideBySideActive = false; toast('Side-by-side disabled');
      return;
    }
    // dynamically load plugin if missing
    if(typeof L === 'undefined'){ toast('Leaflet missing'); return; }
    if(typeof L.control.sideBySide === 'undefined'){
      await new Promise((resolve,reject)=>{
        const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet-side-by-side@2.0.0/leaflet-side-by-side.min.js'; s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
      }).catch(()=>{ toast('Failed to load side-by-side'); });
    }
    // create second layer (IR or elev)
    const leftLayer = STATE.layerTiles.vis;
    const rightLayer = STATE.layerTiles.ir || STATE.layerTiles.elev || STATE.layerTiles.index;
    if(!rightLayer){ toast('No alternate layer found for comparison'); return; }
    STATE.sideBySideControl = L.control.sideBySide(leftLayer, rightLayer).addTo(STATE.map);
    STATE.sideBySideActive = true; toast('Side-by-side enabled');
  }

  // ---------- UI BINDINGS (topbar etc.) ----------
  function wireTopbar(){
    const searchInput = document.querySelector(UI.searchInput);
    const searchBtn = document.querySelector(UI.searchBtn);
    const suggestBtn = document.querySelector(UI.suggestBtn);
    const exportBtn = document.querySelector(UI.exportBtn);
    const helpBtn = document.querySelector(UI.helpBtn);

    if(searchBtn) searchBtn.addEventListener('click', ()=> doSearch(searchInput && searchInput.value));
    if(searchInput) searchInput.addEventListener('keydown', e=>{ if(e.key === 'Enter') doSearch(searchInput.value); });
    if(suggestBtn) suggestBtn.addEventListener('click', ()=> showSuggestions());
    if(exportBtn) exportBtn.addEventListener('click', ()=> exportAnnotations());
    if(helpBtn) helpBtn.addEventListener('click', ()=> showHelp());

    // layer radios (if present in UI)
    document.querySelectorAll('input[name="layer"]').forEach(r => r.addEventListener('change', (e)=>{
      const v = e.target.value; // vis/ir/elev/index
      Object.values(STATE.layerTiles).forEach(l=> { try{ STATE.map.removeLayer(l); }catch(e){} });
      if(v === 'vis' && STATE.layerTiles.vis) STATE.layerTiles.vis.addTo(STATE.map);
      else if(v === 'ir' && STATE.layerTiles.ir) STATE.layerTiles.ir.addTo(STATE.map);
      else if(v === 'elev' && STATE.layerTiles.elev) STATE.layerTiles.elev.addTo(STATE.map);
      else if(v === 'index' && STATE.layerTiles.index) STATE.layerTiles.index.addTo(STATE.map);
      STATE.currentLayerName = v;
    }));

    // keyboard shortcuts
    window.addEventListener('keydown', (e)=>{
      if((e.ctrlKey || e.metaKey) && e.key === 's'){ e.preventDefault(); toggleSideBySide(); }
      if((e.ctrlKey || e.metaKey) && e.key === 'f'){ e.preventDefault(); const el = document.querySelector(UI.searchInput); if(el) el.focus(); }
    });
  }

  function showHelp(){
    const msg = `EmbiggenEye — Tips:\n- Search by crater name or id\n- Click a marker to open details and Accept/Comment\n- Suggest loads precomputed suggestions.json or generates from features\n- Ctrl/Cmd+S toggles side-by-side compare (if alternate layer available)\n- Export annotations from left panel`;
    alert(msg);
  }

  function doSearch(query){
    if(!query || !String(query).trim()){ toast('Type a crater name or id'); return; }
    const q = String(query).trim().toLowerCase();
    const found = STATE.features.find(f => (f.name && String(f.name).toLowerCase().includes(q)) || (String(f.id).toLowerCase() === q));
    if(!found){ toast('No matching crater'); return; }
    const fm = STATE.featureMap.get(String(found.id));
    if(fm && fm.marker){ try{ fm.marker.fire('click'); fm.marker.openPopup(); }catch(e){} } else { showHighlight(found); populateRightPanel(found); }
  }

  // ---------- BOOTSTRAP / STARTUP ----------
  async function startApp(){
    try{
      await whenReady();
      initMap();
      wireTopbar();
      ensureRightPanel();

      const raw = await loadFeaturesRaw();
      if(!raw || raw.length === 0){ warn('No features loaded'); return; }

      // normalize and render
      STATE.features = normalizeAllFeatures(raw);
      renderFeatures(STATE.features);

      // apply permalink (if any) after a short delay so map exists
      setTimeout(()=> applyPermalinkHash(), 800);

      // load PSR metadata in background if present and compute overlap optionally only on demand
      (async ()=>{ const psr = await loadPSR(); if(psr){ log('PSR available'); } })();

      // restore annotations
      restoreAnnotationsOnMap();

      // final ready toast
      toast('EmbiggenEye ready — click a marker to inspect');
    }catch(e){ err('startApp error', e); toast('Initialization failed — see console'); }
  }

  // expose some utilities for console/debugging
  window.EMBIGEN.start = startApp;
  window.EMBIGEN.computePSROverlapBatch = computePSROverlapBatch;
  window.EMBIGEN.renderFeatures = renderFeatures;
  window.EMBIGEN.normalizeAllFeatures = normalizeAllFeatures;
  window.EMBIGEN.state = STATE;

  // auto-start
  startApp();

  // ---------- Extra: helper functions for offline generation, suggestions download ----------
  // generate suggestions file from current features and trigger download
  window.EMBIGEN.exportSuggestions = function exportSuggestions(topN = 200){
    try{
      const arr = STATE.features.map(f => ({ id: f.id, name: f.name, lon: f.lon, lat: f.lat, diameter_m: f.diameter_m, water_score: f.water_score, components: { psr: f.psr_overlap, spec: f.spectral_mean, hydro: f.hydrogen_mean, depth: f.depth_metric }, source_props: { psr_overlap: f.psr_overlap, spectral_mean: f.spectral_mean, hydrogen_mean: f.hydrogen_mean, depth_metric: f.depth_metric } }));
      arr.sort((a,b)=> ( (b.water_score||0) - (a.water_score||0) ));
      const top = arr.slice(0, topN);
      const blob = new Blob([JSON.stringify(top, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'suggestions_generated.json'; a.click(); URL.revokeObjectURL(url);
      toast('Downloaded suggestions_generated.json');
    }catch(e){ err('export suggestions error', e); toast('Failed to export suggestions'); }
  };

  // small helper to print a sample of features in console
  window.EMBIGEN.sample = function sample(n=6){ console.log('EMBIGEN sample', STATE.features.slice(0,n)); };

  // done
})();
