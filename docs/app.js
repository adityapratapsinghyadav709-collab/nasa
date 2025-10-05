/* app.js — Clean, defensive, practical EmbiggenEye frontend
   Drop-in replacement. Robustly handles GeoJSON FeatureCollection input shapes,
   pulls coords from geometry if needed, computes fallback water_score,
   supports suggestions, PSR overlap computation (client-side using Turf),
   annotations (localStorage), export/import, search, permalink.
*/

/* eslint-disable */
(function(){
  'use strict';

  // ---------- CONFIG ----------
  const DEBUG = false;                        // set true to get verbose console logs
  const PAGE_BASE = (function(){              // auto-detect base path for GitHub Pages friendliness
    let p = window.location.pathname || '/';
    if(p.indexOf('.') !== -1) p = p.substring(0, p.lastIndexOf('/')+1);
    if(!p.endsWith('/')) p = p + '/';
    return p;
  })();
  const FEATURE_PARTS = ['features_part1.json','features_part2.json','features_part3.json'];
  const FEATURE_SINGLE = 'features.json';
  const SUGGESTIONS_FILE = 'suggestions.json';
  const PSR_FILE = 'psr.geojson';
  const BLANK_TILE = 'static/blank-tile.png';
  const MAX_Z = 5;
  const DEFAULT_VIEW = { lat: -89.6, lon: -45.0, z: 2 };
  const ANNOTATION_KEY = 'embiggen_annotations_v1';

  // default score weights (will be redistributed when components missing)
  const DEFAULT_WEIGHTS = { psr: 0.35, hydrogen: 0.30, spectral: 0.30, depth: 0.05 };

  // ---------- UTILITIES ----------
  function log(...args){ if(DEBUG) console.log('[EMB]', ...args); }
  function warn(...args){ console.warn('[EMB]', ...args); }
  function err(...args){ console.error('[EMB]', ...args); }
  function toast(msg, time=2200){ const el = document.getElementById('toast'); if(!el){ console.log('TOAST',msg); return; } el.textContent = msg; el.classList.add('visible'); clearTimeout(el._t); el._t = setTimeout(()=>el.classList.remove('visible'), time); }
  function setLoader(msg){ const el = document.getElementById('loader'); if(!el) return; if(msg){ el.style.display = 'block'; el.textContent = msg; } else { el.style.display = 'none'; el.textContent = ''; } }
  function safeNum(v){ if(v===undefined || v===null || v==='') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
  function clamp01(v){ if(v==null || Number.isNaN(v)) return 0; return Math.max(0, Math.min(1, v)); }
  function escapeHtml(s){ if(s==null) return ''; return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

  // ---------- STATE ----------
  const STATE = {
    map: null,
    tiles: {},
    markerCluster: null,
    suggestionLayer: null,
    annotationLayer: null,
    highlightLayer: null,
    featuresRaw: [],   // raw feature objects (GeoJSON Feature or props)
    features: [],      // normalized features used in map (id,name,lat,lon,diameter_m,spectral_mean,hydrogen_mean,depth_metric,psr_overlap,water_score)
    featureMap: new Map(), // id -> { feature, marker }
    suggestions: [],
    psrGeo: null,
    turfReady: false
  };

  window.EMBIGEN = window.EMBIGEN || {};
  window.EMBIGEN.STATE = STATE;

  // ---------- MAP INIT ----------
  function tileTemplate(name){
    return PAGE_BASE + `tiles/${name}/{z}/{x}/{y}.png`;
  }
  function makeTile(template){
    const errTile = PAGE_BASE + BLANK_TILE;
    return L.tileLayer(template, { maxZoom: MAX_Z, tileSize: 256, noWrap: true, errorTileUrl: errTile });
  }

  function initMap(){
    if(STATE.map) return STATE.map;
    const mapEl = document.getElementById('map');
    if(!mapEl) throw new Error('#map element missing in DOM');
    const map = L.map('map', { preferCanvas: true, maxZoom: MAX_Z }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.z);
    STATE.map = map;

    // create tile layers (vis, ir, elev, index)
    try{ STATE.tiles.vis = makeTile(tileTemplate('layer_vis')); STATE.tiles.vis.addTo(map); } catch(e){ warn('vis tiles missing'); }
    try{ STATE.tiles.ir = makeTile(tileTemplate('layer_ir')); } catch(e){}
    try{ STATE.tiles.elev = makeTile(tileTemplate('layer_elev')); } catch(e){}
    try{ STATE.tiles.index = makeTile(tileTemplate('layer_index')); } catch(e){}

    // layer control
    const bases = { 'Visible': STATE.tiles.vis || L.tileLayer(PAGE_BASE + BLANK_TILE) };
    const overlays = {};
    L.control.layers(bases, overlays, { collapsed: true }).addTo(map);

    // clustering
    STATE.markerCluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false });
    map.addLayer(STATE.markerCluster);

    // suggestion and annotation layers
    STATE.suggestionLayer = L.layerGroup().addTo(map);
    STATE.annotationLayer = L.layerGroup().addTo(map);

    // map events
    map.on('click', ()=> clearHighlight());
    map.on('moveend', updatePermalink);

    return map;
  }

  // ---------- FEATURE LOADING ----------
  async function fetchJSONTry(paths){
    for(const p of paths){
      try{
        const r = await fetch(p, { cache: 'no-cache' });
        if(r.ok) {
          const data = await r.json();
          log('fetch ok', p);
          return { data, path: p };
        }
      }catch(e){}
    }
    return null;
  }

  async function loadFeatures(){
    setLoader('Loading features.json...');
    // try parts first then single; allow both PAGE_BASE paths and bare names
    const tryPaths = [];
    FEATURE_PARTS.forEach(x => tryPaths.push(PAGE_BASE + x));
    tryPaths.push(PAGE_BASE + FEATURE_SINGLE);
    FEATURE_PARTS.forEach(x => tryPaths.push(x));
    tryPaths.push(FEATURE_SINGLE);
    // also docs/ folder fallback
    FEATURE_PARTS.forEach(x => tryPaths.push('docs/' + x));
    tryPaths.push('docs/' + FEATURE_SINGLE);

    const res = await fetchJSONTry(tryPaths);
    if(!res) { setLoader('No features found'); toast('features.json not found — upload it to docs/'); return []; }
    let raw = [];
    const obj = res.data;
    // normalize shapes: array | FeatureCollection | features array inside
    if(Array.isArray(obj)) raw = raw.concat(obj);
    else if(obj && obj.type && obj.type.toLowerCase()==='featurecollection' && Array.isArray(obj.features)) raw = raw.concat(obj.features);
    else if(obj && Array.isArray(obj.features)) raw = raw.concat(obj.features);
    else {
      // maybe it's an object with properties (single feature), push it
      raw.push(obj);
    }
    STATE.featuresRaw = raw;
    setLoader('');
    toast(`Loaded ${raw.length} features`);
    log('featuresRaw length', raw.length, 'from', res.path);
    return raw;
  }

  // ---------- NORMALIZATION ----------
  // Convert each raw feature (GeoJSON Feature or plain props) -> normalized {id,name,lat,lon,...}
  function normalizeRecord(rec){
    if(!rec) return null;
    // if a GeoJSON Feature object
    let props = null;
    let geom = null;
    if(rec.type && rec.type.toLowerCase()==='feature' && rec.properties){
      props = Object.assign({}, rec.properties);
      geom = rec.geometry;
    } else if(rec.properties && rec.geometry){
      props = Object.assign({}, rec.properties);
      geom = rec.geometry;
    } else {
      // maybe it's already a plain properties object
      props = Object.assign({}, rec);
      geom = rec.geometry || null;
    }

    // helper to obtain lat/lon
    function extractLatLon(){
      // prefer numeric props.lat / props.lon
      let lat = safeNum(props.lat ?? props.latitude ?? props.Lat ?? props.center_lat);
      let lon = safeNum(props.lon ?? props.longitude ?? props.Long ?? props.center_lon);
      if((lat == null || lon == null) && geom && Array.isArray(geom.coordinates)){
        // GeoJSON is [lon, lat]
        lon = lon == null ? safeNum(geom.coordinates[0]) : lon;
        lat = lat == null ? safeNum(geom.coordinates[1]) : lat;
      }
      if((lat == null || lon == null)){
        // other alt names
        lat = lat == null ? safeNum(props.Y ?? props.y ?? props.pixel_y ?? props.PIXEL_Y ?? props.latitude_deg) : lat;
        lon = lon == null ? safeNum(props.X ?? props.x ?? props.pixel_x ?? props.PIXEL_X ?? props.longitude_deg) : lon;
      }
      return { lat, lon };
    }

    const { lat, lon } = extractLatLon();

    // diameter conversion
    let diameter_m = safeNum(props.diameter_m ?? props.diam_m ?? props.DIAMETER_M);
    if(diameter_m == null){
      const km = safeNum(props.diameter_km ?? props.DIAMETER_KM);
      if(km != null) diameter_m = km * 1000;
      else {
        const d = safeNum(props.diameter ?? props.DIAMETER ?? props.diam);
        if(d != null){
          // ambiguous: if <100 maybe it's km; if >1000 probably meters; heuristic:
          diameter_m = (d < 100 ? d * 1000 : d);
        } else diameter_m = null;
      }
    }

    // science fields
    const spectral_mean = safeNum(props.spectral_mean ?? props.spec ?? props.m3 ?? props.SPECTRAL_MEAN);
    const hydrogen_mean = safeNum(props.hydrogen_mean ?? props.hydro ?? props.hydrogen ?? props.HYDROGEN_MEAN);
    const depth_metric = safeNum(props.depth_metric ?? props.depth ?? props.DEPTH_METRIC);

    // psr
    let psr_overlap = null;
    if(props.psr_overlap === true) psr_overlap = 1;
    else if(props.psr_overlap === false) psr_overlap = 0;
    else psr_overlap = safeNum(props.psr_overlap ?? props.PSR_OVERLAP);

    // water_score
    let water_score = safeNum(props.water_score ?? props.score ?? props.WATER_SCORE);

    // id & name
    const id = (props.id ?? props.ID ?? props.CRATER_ID ?? props.name ?? props.NAME) + '';
    const name = (props.name ?? props.NAME ?? id) + '';

    return {
      id: id || `f_${Math.random().toString(36).slice(2,9)}`,
      name: name || 'Unnamed',
      lat: lat,
      lon: lon,
      diameter_m: diameter_m,
      spectral_mean: spectral_mean,
      hydrogen_mean: hydrogen_mean,
      depth_metric: depth_metric,
      psr_overlap: psr_overlap,
      water_score: water_score,
      raw: rec,
      geometry: geom
    };
  }

  function normalizeAll(rawList){
    const arr = rawList.map(normalizeRecord).filter(x => x != null);
    // If many have missing lat/lon but geometry contains coords, fill them now
    let missingCoords = arr.filter(f => f.lat == null || f.lon == null).length;
    if(missingCoords > 0){
      // try to fill from geometry if available
      let filled = 0;
      for(const f of arr){
        if((f.lat==null || f.lon==null) && f.geometry && Array.isArray(f.geometry.coordinates)){
          const lon = safeNum(f.geometry.coordinates[0]);
          const lat = safeNum(f.geometry.coordinates[1]);
          if(lat != null && lon != null){ f.lat = lat; f.lon = lon; filled++; }
        }
      }
      if(filled) log('Filled coords from geometry for', filled, 'features');
    }
    // compute fallback water_score for ones missing it
    computeFallbackScores(arr);
    return arr;
  }

  function computeFallbackScores(arr){
    // collect numeric arrays
    const spec = arr.map(a=>a.spectral_mean).filter(v=>v!=null);
    const hyd = arr.map(a=>a.hydrogen_mean).filter(v=>v!=null);
    const dep = arr.map(a=>a.depth_metric).filter(v=>v!=null);
    const psr = arr.map(a=>a.psr_overlap).filter(v=>v!=null);

    function makeNorm(values){
      if(!values || values.length===0) return v => 0;
      const mn = Math.min(...values), mx = Math.max(...values), span = (mx - mn) || 1;
      return v => v==null ? 0 : ( (v - mn) / span );
    }
    const nSpec = makeNorm(spec);
    const nHyd = makeNorm(hyd);
    const nDep = makeNorm(dep);
    const nPsr = makeNorm(psr);

    for(const f of arr){
      if(f.water_score != null) continue; // keep precomputed if present
      const ns = nSpec(f.spectral_mean); const nh = nHyd(f.hydrogen_mean); const nd = nDep(f.depth_metric); const np = nPsr(f.psr_overlap);
      const w = Object.assign({}, DEFAULT_WEIGHTS);
      if(f.psr_overlap == null) w.psr = 0;
      if(f.hydrogen_mean == null) w.hydrogen = 0;
      if(f.spectral_mean == null) w.spectral = 0;
      if(f.depth_metric == null) w.depth = 0;
      const total = (w.psr + w.hydrogen + w.spectral + w.depth) || 1;
      w.psr /= total; w.hydrogen /= total; w.spectral /= total; w.depth /= total;
      const score = w.psr * np + w.hydrogen * nh + w.spectral * ns + w.depth * nd;
      f.water_score = Number.isFinite(score) ? Number(score.toFixed(6)) : 0;
    }
  }

  // ---------- RENDERING ----------

  function colorForScore(s){
    const v = clamp01(s || 0);
    // simple blue->green->orange->red gradient
    const r = Math.round(255 * Math.min(1, Math.max(0, (v-0.5)*2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5-v)*2)));
    const g = Math.round(255 * (1 - Math.abs(v-0.5)*2));
    return `rgb(${r},${g},${b})`;
  }

  function radiusForDiameter(d){
    if(!d) return 6;
    const km = Math.max(0.001, d/1000);
    return Math.min(48, Math.max(6, 6 + Math.log10(km + 1) * 14));
  }

  function clearHighlight(){
    if(STATE.highlightLayer){ try{ STATE.map.removeLayer(STATE.highlightLayer); }catch(e){} STATE.highlightLayer = null; }
  }

  function showHighlight(feature){
    clearHighlight();
    if(!feature || feature.lat==null || feature.lon==null) return;
    const r = feature.diameter_m ? feature.diameter_m/2 : 1000;
    STATE.highlightLayer = L.circle([feature.lat, feature.lon], { radius: r, color: '#00ffff', weight: 2.2, fillOpacity: 0.06 }).addTo(STATE.map);
    try{ STATE.map.setView([feature.lat, feature.lon], Math.min(MAX_Z, Math.max(3, STATE.map.getZoom()))); }catch(e){}
  }

  function popupHtml(feature){
    const diam = feature.diameter_m ? `${Math.round(feature.diameter_m)} m (${(feature.diameter_m/1000).toFixed(2)} km)` : '—';
    const score = feature.water_score != null ? feature.water_score.toFixed(4) : '—';
    const spec = feature.spectral_mean != null ? feature.spectral_mean.toFixed(4) : '—';
    const hydro = feature.hydrogen_mean != null ? feature.hydrogen_mean.toFixed(4) : '—';
    const depth = feature.depth_metric != null ? feature.depth_metric.toFixed(4) : '—';
    const psr = feature.psr_overlap != null ? (feature.psr_overlap > 0 ? (feature.psr_overlap*100).toFixed(1) + '%' : '0%') : '—';
    return `
      <div class="popup-card">
        <h4 style="margin:0 0 6px 0">${escapeHtml(feature.name)}</h4>
        <table class="popup-table" style="width:100%;font-size:13px">
          <tr><td>water_score</td><td style="text-align:right"><b>${escapeHtml(score)}</b></td></tr>
          <tr><td>PSR overlap</td><td style="text-align:right">${escapeHtml(psr)}</td></tr>
          <tr><td>diameter</td><td style="text-align:right">${escapeHtml(diam)}</td></tr>
          <tr><td>spectral_mean</td><td style="text-align:right">${escapeHtml(spec)}</td></tr>
          <tr><td>hydrogen_mean</td><td style="text-align:right">${escapeHtml(hydro)}</td></tr>
          <tr><td>depth_metric</td><td style="text-align:right">${escapeHtml(depth)}</td></tr>
        </table>
        <div style="margin-top:8px;text-align:right">
          <button class="btn small popup-accept">Accept</button>
          <button class="btn small ghost popup-comment" style="margin-left:6px">Comment</button>
          <button class="btn small ghost popup-perm" style="margin-left:6px">Permalink</button>
        </div>
      </div>
    `;
  }

  function createMarker(feature){
    if(feature.lat == null || feature.lon == null) return null;
    const color = colorForScore(feature.water_score || 0);
    const radius = radiusForDiameter(feature.diameter_m);
    const marker = L.circleMarker([feature.lat, feature.lon], { radius, color, weight:1.2, fillOpacity:0.8 });
    marker.featureId = feature.id;
    marker.feature = feature;
    marker.bindPopup(popupHtml(feature), { minWidth: 220 });
    marker.on('click', ()=> {
      try{ marker.openPopup(); }catch(e){} showHighlight(feature); fillRightPanel(feature);
    });
    marker.on('popupopen', (ev) => {
      const el = ev.popup.getElement();
      if(!el) return;
      const accept = el.querySelector('.popup-accept');
      const comment = el.querySelector('.popup-comment');
      const perm = el.querySelector('.popup-perm');
      if(accept) accept.onclick = ()=> { addAnnotation(feature); try{ ev.popup._source.closePopup(); }catch(e){} };
      if(comment) comment.onclick = ()=> promptComment(feature);
      if(perm) perm.onclick = ()=> { setPermalink(feature); toast('Permalink updated'); };
    });
    return marker;
  }

  function renderAllFeatures(features){
    if(!STATE.map) initMap();
    STATE.markerCluster.clearLayers();
    STATE.featureMap.clear();
    let placed = 0, skipped = 0;
    for(const f of features){
      if(f.lat == null || f.lon == null){ skipped++; continue; }
      const m = createMarker(f);
      if(m) { STATE.markerCluster.addLayer(m); STATE.featureMap.set(String(f.id), { feature: f, marker: m }); placed++; }
      else skipped++;
    }
    // show annotations too
    restoreAnnotationsOnMap();
    toast(`Rendered ${placed} features (skipped ${skipped})`);
    log('renderAllFeatures placed', placed, 'skipped', skipped);
  }

  // ---------- SUGGESTIONS ----------
  async function loadSuggestions(){
    // try PAGE_BASE + suggestions first, then bare paths
    const paths = [PAGE_BASE + SUGGESTIONS_FILE, SUGGESTIONS_FILE, 'docs/' + SUGGESTIONS_FILE];
    for(const p of paths){
      try{
        const r = await fetch(p, { cache: 'no-cache' });
        if(r.ok){ const json = await r.json(); log('loaded suggestions from', p); return json; }
      }catch(e){}
    }
    return null;
  }

  async function showSuggestions(n=100){
    let suggestions = await loadSuggestions();
    if(!suggestions){
      suggestions = generateSuggestionsFromFeatures(n);
      toast('Generated suggestions from features (no suggestions.json found)');
    } else {
      // support shape { suggestions: [...] } or array or FeatureCollection
      if(suggestions.suggestions && Array.isArray(suggestions.suggestions)) suggestions = suggestions.suggestions;
      else if(suggestions.type && suggestions.type.toLowerCase()==='featurecollection' && Array.isArray(suggestions.features)) suggestions = suggestions.features.map(f => (f.properties || f));
      else if(!Array.isArray(suggestions)) suggestions = [suggestions];
    }

    STATE.suggestions = suggestions;
    STATE.suggestionLayer.clearLayers();
    let shown = 0;
    for(const s of suggestions){
      const nf = normalizeRecordShape(s); // helper to read lat/lon from different shapes
      if(nf.lat == null || nf.lon == null) continue;
      const circ = L.circleMarker([nf.lat, nf.lon], { radius: 10, color: '#ff7a00', weight:2, fillOpacity:0.22 }).addTo(STATE.suggestionLayer);
      circ.bindPopup(`<b>${escapeHtml(nf.name)}</b><br/>score: ${(nf.water_score!=null?nf.water_score.toFixed(3):'—')}<br/><button class="btn small accept-sug">Accept</button>`);
      circ.on('popupopen', (ev)=> {
        const el = ev.popup.getElement(); if(!el) return;
        const btn = el.querySelector('.accept-sug'); if(btn) btn.onclick = ()=> { addAnnotation(nf); try{ ev.popup._source.closePopup(); }catch(e){} };
      });
      shown++;
    }
    toast(`${shown} suggestions shown`);
  }

  function generateSuggestionsFromFeatures(n=200){
    const arr = STATE.features.slice().map(f => Object.assign({}, f));
    arr.sort((a,b) => ( (b.water_score || 0) - (a.water_score || 0) ));
    return arr.slice(0, n).map(f => ({ id: f.id, name: f.name, lat: f.lat, lon: f.lon, diameter_m: f.diameter_m, water_score: f.water_score, components: { psr: f.psr_overlap, spec: f.spectral_mean, hydro: f.hydrogen_mean, depth: f.depth_metric }}));
  }

  function normalizeRecordShape(s){
    // accepts GeoJSON Feature or properties object
    if(!s) return null;
    if(s.type && s.type.toLowerCase()==='feature'){
      const props = s.properties || {};
      const geom = s.geometry;
      const lat = safeNum(props.lat ?? props.latitude) ?? (geom && Array.isArray(geom.coordinates) ? safeNum(geom.coordinates[1]) : null);
      const lon = safeNum(props.lon ?? props.longitude) ?? (geom && Array.isArray(geom.coordinates) ? safeNum(geom.coordinates[0]) : null);
      return { id: props.id || props.name, name: props.name || props.id, lat, lon, diameter_m: safeNum(props.diameter_m), water_score: safeNum(props.water_score) };
    } else {
      const lat = safeNum(s.lat ?? s.latitude ?? s.geometry?.coordinates?.[1]);
      const lon = safeNum(s.lon ?? s.longitude ?? s.geometry?.coordinates?.[0]);
      return { id: s.id || s.name, name: s.name || s.id, lat, lon, diameter_m: safeNum(s.diameter_m), water_score: safeNum(s.water_score) };
    }
  }

  // ---------- ANNOTATIONS ----------
  function loadAnnotations(){
    try{ return JSON.parse(localStorage.getItem(ANNOTATION_KEY) || '[]'); } catch(e){ return []; }
  }
  function saveAnnotations(a){ localStorage.setItem(ANNOTATION_KEY, JSON.stringify(a)); }

  function addAnnotation(feature){
    if(!feature || feature.lat==null || feature.lon==null){ toast('Cannot annotate (no coords)'); return; }
    const anns = loadAnnotations();
    if(anns.find(a => a.id && feature.id && String(a.id) === String(feature.id))){ toast('Already annotated'); return; }
    const ent = { id: feature.id, name: feature.name, lat: feature.lat, lon: feature.lon, water_score: feature.water_score || null, ts: new Date().toISOString(), comment: feature._comment || null };
    anns.push(ent); saveAnnotations(anns); restoreAnnotationsOnMap(); toast('Annotated (local)'); }

  function restoreAnnotationsOnMap(){
    try{
      STATE.annotationLayer.clearLayers();
    }catch(e){}
    const anns = loadAnnotations();
    for(const a of anns){
      try{
        const m = L.circleMarker([a.lat, a.lon], { radius: 8, color: '#2ee6a1', weight:1.4, fillOpacity:0.7 }).addTo(STATE.annotationLayer);
        m.bindPopup(`<b>${escapeHtml(a.name)}</b><br/>${escapeHtml(a.id || '')}<br/>${escapeHtml(a.comment || '')}`);
      }catch(e){}
    }
    updateAnnotationsListUI();
  }

  function updateAnnotationsListUI(){
    const el = document.getElementById('annotationsList');
    if(!el) return;
    const anns = loadAnnotations();
    if(!anns.length) { el.textContent = 'None yet'; return; }
    el.innerHTML = anns.map(a => `<div class="ann-row"><div><b>${escapeHtml(a.name)}</b><div style="font-size:12px;color:var(--color-muted)">${escapeHtml(a.id||'')}</div></div><div style="text-align:right;color:${colorForScore(a.water_score||0)}">${(a.water_score!=null? a.water_score.toFixed(3):'—')}</div></div>`).join('');
  }

  function exportAnnotations(){
    const anns = loadAnnotations();
    const fc = { type: 'FeatureCollection', features: anns.map(a => ({ type:'Feature', properties: { id: a.id, name: a.name, water_score: a.water_score, ts: a.ts, comment: a.comment }, geometry: { type:'Point', coordinates: [a.lon, a.lat] } })) };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'embiggen_annotations.geojson'; a.click(); URL.revokeObjectURL(url);
    toast('Annotations exported');
  }

  async function importAnnotationsFile(file){
    try{
      const text = await file.text();
      const obj = JSON.parse(text);
      let arr = [];
      if(Array.isArray(obj)) arr = obj;
      else if(obj.type && obj.type.toLowerCase()==='featurecollection' && Array.isArray(obj.features)) arr = obj.features.map(f => ({ id: f.properties.id, name: f.properties.name, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], water_score: f.properties.water_score, comment: f.properties.comment }));
      else { toast('Unrecognized import format'); return; }
      const cur = loadAnnotations();
      const merged = cur.concat(arr);
      saveAnnotations(merged); restoreAnnotationsOnMap(); toast('Imported annotations'); } catch(e){ err('import anns failed', e); toast('Import failed'); }
  }

  function promptComment(feature){
    const prev = feature._comment || '';
    const note = prompt('Add a comment (saved locally):', prev);
    if(note === null) return;
    feature._comment = note;
    // update annotation if it exists
    const anns = loadAnnotations();
    const idx = anns.findIndex(a => a.id && String(a.id) === String(feature.id));
    if(idx !== -1){ anns[idx].comment = note; anns[idx].ts = new Date().toISOString(); saveAnnotations(anns); restoreAnnotationsOnMap(); }
    toast('Comment stored locally');
  }

  // ---------- PSR overlap computation (client-side, optional) ----------
  async function loadPSRGeo(){
    // try multiple paths
    const paths = [PAGE_BASE + PSR_FILE, PSR_FILE, 'docs/' + PSR_FILE];
    for(const p of paths){
      try{
        const r = await fetch(p, { cache: 'no-cache' });
        if(r.ok){ const json = await r.json(); STATE.psrGeo = json; log('PSR loaded', p); return json; }
      }catch(e){}
    }
    log('No psr.geojson found');
    return null;
  }

  async function ensureTurf(){
    if(window.turf){ STATE.turfReady = true; return window.turf; }
    // load turf
    await new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s);
    }).catch(e => { warn('turf load failed', e); });
    STATE.turfReady = !!window.turf;
    return window.turf;
  }

  // batch compute PSR overlap to avoid blocking UI for 50k features
  async function computePSROverlap(batchSize=1000, yieldMs=10){
    const psr = STATE.psrGeo || await loadPSRGeo();
    if(!psr || !psr.features || psr.features.length === 0){ toast('No PSR data available'); return; }
    await ensureTurf();
    if(!window.turf){ toast('Turf not loaded; cannot compute PSR'); return; }
    setLoader('Computing PSR overlaps (client-side) — please wait...');
    const features = STATE.features;
    const psrGeoms = psr.features.map(f => f.geometry).filter(Boolean);
    let count = 0;
    for(let i=0;i<features.length;i++){
      const f = features[i];
      if(f.lat == null || f.lon == null) continue;
      const radius_m = f.diameter_m ? f.diameter_m / 2 : 200;
      try{
        const circle = turf.circle([f.lon, f.lat], radius_m/1000, { units: 'kilometers', steps: 32 });
        let ia = 0;
        for(const pg of psrGeoms){
          try{
            const inter = turf.intersect(circle, pg);
            if(inter) ia += turf.area(inter);
          }catch(e){}
        }
        const craterArea = turf.area(circle) || 1;
        f.psr_overlap = clamp01(ia / craterArea);
      }catch(e){
        f.psr_overlap = f.psr_overlap == null ? 0 : f.psr_overlap;
      }
      count++;
      if(count % batchSize === 0) await new Promise(r=>setTimeout(r, yieldMs));
    }
    computeFallbackScores(features);
    renderAllFeatures(features);
    setLoader('');
    toast('PSR overlaps computed');
  }

  // ---------- PERMALINKS ----------
  function updatePermalink(){
    if(!STATE.map) return;
    const c = STATE.map.getCenter();
    const z = STATE.map.getZoom();
    const layer = STATE.currentLayer || 'vis';
    const hash = `z=${z}&lat=${c.lat.toFixed(6)}&lon=${c.lng.toFixed(6)}&layer=${layer}`;
    location.hash = hash;
  }
  function applyPermalink(){
    if(!location.hash) return;
    const p = location.hash.replace('#','');
    const kv = {};
    p.split('&').forEach(x => { const [k,v] = x.split('='); if(k) kv[k]=v; });
    if(STATE.map && kv.lat && kv.lon){ STATE.map.setView([Number(kv.lat), Number(kv.lon)], Number(kv.z || STATE.map.getZoom())); }
    if(kv.id && STATE.featureMap.has(kv.id)){ const e = STATE.featureMap.get(kv.id); if(e && e.marker){ e.marker.fire('click'); e.marker.openPopup(); } }
  }

  function setPermalink(feature){
    if(!feature || feature.lat==null || feature.lon==null) return;
    const z = STATE.map ? STATE.map.getZoom() : DEFAULT_VIEW.z;
    location.hash = `z=${z}&lat=${feature.lat.toFixed(6)}&lon=${feature.lon.toFixed(6)}&id=${encodeURIComponent(feature.id)}`;
  }

  // ---------- RIGHT PANEL UI (details/suggestions/debug) ----------
  function initRightPanel(){
    const root = document.getElementById('featureDetails');
    if(!root) return;
    root.innerHTML = `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
        <button id="tab-details" class="btn small ghost">Details</button>
        <button id="tab-suggestions" class="btn small ghost">Suggestions</button>
        <button id="tab-debug" class="btn small ghost">Debug</button>
        <div style="flex:1"></div>
        <button id="btn-detect" class="btn small">Detect</button>
      </div>
      <div id="tab-content"><div class="empty">Click a crater to view details</div></div>
    `;
    document.getElementById('tab-details').addEventListener('click', ()=> showTab('details'));
    document.getElementById('tab-suggestions').addEventListener('click', ()=> showTab('suggestions'));
    document.getElementById('tab-debug').addEventListener('click', ()=> showTab('debug'));
    document.getElementById('btn-detect').addEventListener('click', ()=> showSuggestions(200));
    showTab('details');
  }

  function showTab(name){
    const content = document.getElementById('tab-content');
    if(!content) return;
    document.getElementById('tab-details').classList.toggle('active', name==='details');
    document.getElementById('tab-suggestions').classList.toggle('active', name==='suggestions');
    document.getElementById('tab-debug').classList.toggle('active', name==='debug');

    if(name === 'details') content.innerHTML = `<div class="empty">Click a crater to view details</div>`;
    else if(name === 'suggestions') content.innerHTML = `<div style="color:var(--color-muted)">Use Suggest to show precomputed candidates or Detect to compute top candidates here.</div>`;
    else if(name === 'debug'){
      const total = STATE.features.length;
      const missingCoords = STATE.features.filter(f=> f.lat==null || f.lon==null).length;
      const missSpec = STATE.features.filter(f=> f.spectral_mean==null).length;
      const missHyd = STATE.features.filter(f=> f.hydrogen_mean==null).length;
      const missDepth = STATE.features.filter(f=> f.depth_metric==null).length;
      content.innerHTML = `
        <div style="font-size:13px;color:var(--color-muted);padding:6px">
          <div>Total features: <b>${total}</b></div>
          <div>Missing coords: <b>${missingCoords}</b></div>
          <div>Missing spectral_mean: <b>${missSpec}</b></div>
          <div>Missing hydrogen_mean: <b>${missHyd}</b></div>
          <div>Missing depth_metric: <b>${missDepth}</b></div>
          <div style="margin-top:8px">
            <button id="dbg-console" class="btn small ghost">Print sample to console</button>
            <button id="dbg-recompute" class="btn small">Recompute scores</button>
            <button id="dbg-psr" class="btn small">Compute PSR overlaps (client)</button>
          </div>
        </div>
      `;
      document.getElementById('dbg-console').onclick = ()=> console.log('sample feature:', STATE.features[0] || null);
      document.getElementById('dbg-recompute').onclick = ()=> { computeFallbackScores(STATE.features); renderAllFeatures(STATE.features); toast('Scores recomputed'); };
      document.getElementById('dbg-psr').onclick = ()=> computePSROverlap(1000, 20);
    }
  }

  function fillRightPanel(feature){
    const content = document.getElementById('tab-content');
    if(!content) return;
    if(!feature){ content.innerHTML = `<div class="empty">Click a crater to view details</div>`; return; }
    content.innerHTML = `
      <div style="padding:6px">
        <h3 style="margin:6px 0;color:var(--color-accent)">${escapeHtml(feature.name)}</h3>
        <div>id: ${escapeHtml(String(feature.id))}</div>
        <div style="margin-top:8px">Water score: <b style="color:${colorForScore(feature.water_score||0)}">${(feature.water_score!=null? feature.water_score.toFixed(4):'—')}</b></div>
        <div>PSR overlap: ${(feature.psr_overlap!=null? ((feature.psr_overlap*100).toFixed(1)+'%') : '—')}</div>
        <div>Diameter: ${(feature.diameter_m? Math.round(feature.diameter_m)+' m':'—')}</div>
        <div>Spectral: ${(feature.spectral_mean!=null? feature.spectral_mean.toFixed(4):'—')}</div>
        <div>Hydrogen: ${(feature.hydrogen_mean!=null? feature.hydrogen_mean.toFixed(4):'—')}</div>
        <div>Depth metric: ${(feature.depth_metric!=null? feature.depth_metric.toFixed(4):'—')}</div>
        <div style="margin-top:8px">
          <button id="detailAccept" class="btn small">Accept</button>
          <button id="detailComment" class="btn small ghost">Comment</button>
          <button id="detailPermalink" class="btn small ghost">Permalink</button>
        </div>
      </div>
    `;
    document.getElementById('detailAccept').onclick = ()=> addAnnotation(feature);
    document.getElementById('detailComment').onclick = ()=> promptComment(feature);
    document.getElementById('detailPermalink').onclick = ()=> { setPermalink(feature); toast('Permalink set'); };
  }

  // ---------- SEARCH, UI wiring ----------
  function wireTopbar(){
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    const suggestBtn = document.getElementById('suggestBtn');
    const exportBtn = document.getElementById('exportBtn');
    const helpBtn = document.getElementById('helpBtn');

    if(searchBtn) searchBtn.addEventListener('click', ()=> doSearch(searchInput && searchInput.value));
    if(searchInput) searchInput.addEventListener('keydown', e=>{ if(e.key === 'Enter') doSearch(searchInput.value); });
    if(suggestBtn) suggestBtn.addEventListener('click', ()=> showSuggestions(200));
    if(exportBtn) exportBtn.addEventListener('click', ()=> exportAnnotations());
    if(helpBtn) helpBtn.addEventListener('click', ()=> helpDialog());
    // layer radios
    document.querySelectorAll('input[name="layer"]').forEach(r => r.addEventListener('change', (e)=> {
      const v = e.target.value;
      Object.values(STATE.tiles).forEach(t => { try{ STATE.map.removeLayer(t); }catch(e){} });
      if(v === 'vis' && STATE.tiles.vis) STATE.tiles.vis.addTo(STATE.map);
      if(v === 'ir' && STATE.tiles.ir) STATE.tiles.ir.addTo(STATE.map);
      if(v === 'elev' && STATE.tiles.elev) STATE.tiles.elev.addTo(STATE.map);
      if(v === 'index' && STATE.tiles.index) STATE.tiles.index.addTo(STATE.map);
      STATE.currentLayer = v;
    }));
  }

  function doSearch(q){
    if(!q || !String(q).trim()){ toast('Type a crater name or id'); return; }
    const s = String(q).trim().toLowerCase();
    const found = STATE.features.find(f => (f.name && f.name.toLowerCase().includes(s)) || (String(f.id).toLowerCase() === s));
    if(!found){ toast('No matching crater'); return; }
    const entry = STATE.featureMap.get(String(found.id));
    if(entry && entry.marker){ try{ entry.marker.fire('click'); entry.marker.openPopup(); }catch(e){} } else { showHighlight(found); fillRightPanel(found); }
  }

  function helpDialog(){
    alert('EmbiggenEye — Tips:\\n- Search crater by name/id.\\n- Click markers to inspect and Accept/Comment.\\n- Suggest loads precomputed suggestions.json or generates from features.\\n- Export annotations to GeoJSON to include in submission.');
  }

  // ---------- BOOTSTRAP START ----------
  async function start(){
    try{
      await new Promise(r => { if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', r); else r(); });
      // ensure leaflet available
      if(!window.L) { err('Leaflet not loaded'); toast('Leaflet missing — check scripts'); return; }
      initMap(); wireTopbar(); initRightPanel();
      setLoader('Loading features...');
      const raw = await loadFeatures();
      if(!raw || raw.length === 0){ setLoader('No features'); return; }
      // normalize and render
      STATE.features = normalizeAll(raw);
      log('STATE.features sample', STATE.features.slice(0,3));
      // Debug: print sample feature to console for you to paste back if something wrong
      console.log('Sample feature:', STATE.features[0] || null);
      // render
      renderAllFeatures(STATE.features);
      // restore annotations and UI
      restoreAnnotationsOnMap();
      applyPermalink();
      setLoader('');
      toast('EmbiggenEye ready — click a marker to inspect');
    }catch(e){ err('start error', e); setLoader('Initialization error'); toast('Initialization error — check console'); }
  }

  // expose some helper methods to console for debugging
  window.EMBIGEN.loadPSRGeo = loadPSRGeo;
  window.EMBIGEN.computePSROverlap = computePSROverlap;
  window.EMBIGEN.renderAllFeatures = renderAllFeatures;
  window.EMBIGEN.normalizeAll = normalizeAll;
  window.EMBIGEN.exportSuggestions = function(topN=200){
    try{
      const arr = STATE.features.map(f => ({ id: f.id, name: f.name, lon: f.lon, lat: f.lat, diameter_m: f.diameter_m, water_score: f.water_score, components: { psr: f.psr_overlap, spec: f.spectral_mean, hydro: f.hydrogen_mean, depth: f.depth_metric }, source_props: { psr_overlap: f.psr_overlap, spectral_mean: f.spectral_mean, hydrogen_mean: f.hydrogen_mean, depth_metric: f.depth_metric } }));
      arr.sort((a,b)=> ( (b.water_score||0) - (a.water_score||0) ));
      const top = arr.slice(0, topN);
      const blob = new Blob([JSON.stringify(top, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'suggestions_generated.json'; a.click(); URL.revokeObjectURL(url);
      toast('Downloaded suggestions_generated.json');
    }catch(e){ err('export suggestions', e); toast('Failed to export suggestions'); }
  };
  window.EMBIGEN.sample = function(n=6){ console.log('sample features', STATE.features.slice(0,n)); };
  window.EMBIGEN.setDEBUG = function(v){ DEBUG = !!v; };

  // start
  start();

})();
