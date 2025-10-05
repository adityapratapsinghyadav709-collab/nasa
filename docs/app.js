/* app.js — EmbiggenEye final robust frontend
   - Paste this into docs/app.js
   - Requires: Leaflet + MarkerCluster (index.html already loads)
   - Optional but recommended: Turf loaded BEFORE this script for robust geo ops
   - Features:
     - robust tile init with maxNativeZoom and transparent error tile
     - loads features parts, suggestions, PSR
     - computes PSR overlap (turf.booleanPointInPolygon) or bbox fallback
     - compute normalized water_score with reweighted components & small floor
     - circle markers + clustering (visible at all zooms)
     - comment mode: toggle button -> click map to comment (attached to feature if near)
     - feature details panel with comments list & add-comment box
     - accept/annotate, annotation export with comments
     - search & permalink support
*/

///// ----------------- Configuration -----------------
const CONFIG = {
  TILE_URL: './tiles/layer_vis/{z}/{x}/{y}.png',
  FEATURE_PARTS: ['./features_part1.json','./features_part2.json','./features_part3.json'],
  SUGGESTIONS_URL: './suggestions.json',
  PSR_URL: './static/psr.geojson',
  FALLBACK_IMAGE: './static/fallback.png',
  TRANSPARENT_PNG: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  MAX_TILE_ZOOM: 5,      // change to highest zoom you generated (0..5 typical)
  MIN_TILE_ZOOM: 0,
  MAP_MAX_ZOOM: 5,
  COMMENT_NEARBY_KM: 10, // if click within this (km) attach to nearest crater (uses turf distance if available)
  ANNOTATIONS_LS_KEY: 'embiggen_annotations_v1',
  COMMENTS_LS_KEY: 'embiggen_comments_v1'
};

///// ----------------- Utilities -----------------
const $ = id => document.getElementById(id);
function toast(msg, ms=2200){ const t=$('toast'); if(!t) return console.log('TOAST:',msg); t.textContent=msg; t.classList.add('visible'); setTimeout(()=>t.classList.remove('visible'), ms); }
function showLoader(txt='Loading…'){ const l=$('loader'); if(l){ l.style.display='block'; l.textContent=txt; } }
function hideLoader(){ const l=$('loader'); if(l) l.style.display='none'; }
async function safeJsonFetch(url){
  const r = await fetch(url); if(!r.ok) throw new Error(`${url} -> ${r.status}`); return r.json();
}
function escapeHtml(s){ if(!s && s!==0) return ''; return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function formatDiameter(d_m){
  if(d_m === null || d_m === undefined) return '—';
  d_m = +d_m;
  if (d_m >= 1000) return `${(d_m/1000).toFixed(2)} km`;
  return `${Math.round(d_m)} m`;
}
function formatScore(s){
  if (s === null || s === undefined || isNaN(s)) return '—';
  // show percent-like or 0.xx
  return Number(s).toFixed(3);
}

///// ----------------- Globals -----------------
let map;
let baseTileLayer = null;
let cluster;
let suggestionsLayer;
let featureIndex = {};   // id -> feature object
let markerMap = {};      // id -> circleMarker
let annotations = [];    // saved annotation objects
let commentsStore = { featureComments: {}, freeComments: [] };
let PSR_GEOJSON = null;
let SUGGESTIONS = null;
let commentModeActive = false;
let commentModeButton = null;

///// ----------------- Init -----------------
document.addEventListener('DOMContentLoaded', async () => {
  showLoader('Starting map…');
  try {
    setupMap();
    await loadPSR();
    const features = await loadFeaturesParts(CONFIG.FEATURE_PARTS);
    indexFeatures(features);
    await loadSuggestions();
    loadLocalAnnotations();
    loadCommentsFromStorage();
    renderAnnotationsList();
    createCommentModeButton(); // adds UI button for comment mode
    wireUI();
    normalizeAndComputeWaterScores(); // compute scores immediately (with fallbacks)
    hideLoader();
    toast('EmbiggenEye ready');
  } catch(err){
    console.error('Init failed', err);
    hideLoader();
    toast('Initialization error — check console');
  }
});

///// ----------------- Map + Tiles -----------------
function setupMap(){
  // sensible defaults
  map = L.map('map', { preferCanvas: true, worldCopyJump: false, minZoom: CONFIG.MIN_TILE_ZOOM, maxZoom: CONFIG.MAP_MAX_ZOOM })
          .setView([-88.0, 0.0], 2);

  // robust tile init: detect tile availability (best-effort)
  const testUrl = CONFIG.TILE_URL.replace('{z}','0').replace('{x}','0').replace('{y}','0');
  fetch(testUrl, { method:'HEAD' }).then(res => {
    const tilesAvailable = res.ok;
    initTileLayer(tilesAvailable);
  }).catch(_ => {
    // fallback: attempt GET to check
    fetch(testUrl).then(r => {
      initTileLayer(r.ok);
    }).catch(_=>{
      initTileLayer(false);
    });
  });

  // clustering layers
  cluster = L.markerClusterGroup({ chunkedLoading:true, spiderfyOnMaxZoom:true });
  suggestionsLayer = L.layerGroup();
  map.addLayer(cluster);
  map.addLayer(suggestionsLayer);

  // keep permalink updated on moveend (debounced)
  let t = null;
  map.on('moveend', ()=> { if(t) clearTimeout(t); t = setTimeout(()=>setPermalink(null), 400); });
}

function initTileLayer(tilesAvailable){
  // clamp map zoom to match tiles
  map.setMaxZoom(CONFIG.MAP_MAX_ZOOM);

  if(tilesAvailable){
    baseTileLayer = L.tileLayer(CONFIG.TILE_URL, {
      minZoom: CONFIG.MIN_TILE_ZOOM,
      maxZoom: CONFIG.MAP_MAX_ZOOM,
      maxNativeZoom: CONFIG.MAX_TILE_ZOOM,
      errorTileUrl: CONFIG.TRANSPARENT_PNG,
      noWrap: true,
      keepBuffer: 2
    });
    baseTileLayer.addTo(map);

    // detect tile errors and show a single toast once
    let hadError = false;
    baseTileLayer.on('tileerror', function(e){
      if(!hadError){ hadError = true; toast('Some tiles failed to load — using available tiles.'); }
      console.warn('Tile error', e);
    });

    // ensure zoom snapping when user tries to exceed
    map.on('zoomend', ()=> {
      if(map.getZoom() > CONFIG.MAX_TILE_ZOOM){
        map.setZoom(CONFIG.MAX_TILE_ZOOM);
        toast(`Max zoom is ${CONFIG.MAX_TILE_ZOOM} (tiles available up to that).`);
      }
    });

  } else {
    // attempt fallback image overlay
    const fallback = CONFIG.FALLBACK_IMAGE;
    const img = new Image();
    img.onload = ()=> {
      // assume generic bounds — markers use lat/lon so this is just a background
      const bounds = [[-180,-180],[180,180]];
      L.imageOverlay(fallback, bounds).addTo(map);
      map.fitBounds(bounds);
      toast('Tiles not found — using fallback image.');
    };
    img.onerror = ()=> {
      // fallback to a plain background rectangle so markers show
      const bounds = [[-180,-180],[180,180]];
      L.rectangle(bounds, { color:'#071426', weight:0, fillOpacity:1 }).addTo(map);
      map.fitBounds(bounds);
      toast('No tiles or fallback; map usable with markers only.');
    };
    img.src = fallback;
  }
}

///// ----------------- Load PSR -----------------
async function loadPSR(){
  try {
    const data = await safeJsonFetch(CONFIG.PSR_URL);
    PSR_GEOJSON = data;
    L.geoJSON(PSR_GEOJSON, { style: { color: '#7fd', weight:1, fillOpacity:0.06 } }).addTo(map);
    console.log('PSR loaded');
  } catch(err){
    PSR_GEOJSON = null;
    console.warn('PSR not found or failed to load', err);
  }
}

///// ----------------- Features load / index -----------------
async function loadFeaturesParts(parts){
  showLoader('Loading crater catalog...');
  const collected = [];
  for(const p of parts){
    try {
      const json = await safeJsonFetch(p);
      if(json.type === 'FeatureCollection' && Array.isArray(json.features)) collected.push(...json.features);
      else if(Array.isArray(json)) collected.push(...json);
      else if(json.type === 'Feature' && json.properties) collected.push(json);
      else {
        console.warn('Unknown feature part format for', p);
      }
    } catch(err){
      console.warn('Feature part missing or invalid:', p, err);
    }
  }
  hideLoader();
  return collected;
}

function indexFeatures(features){
  featureIndex = {};
  cluster.clearLayers();
  markerMap = {};

  for(const item of features){
    // accept either GeoJSON Feature or plain object with lon/lat in props
    let props = null, geom = null;
    if(item.type === 'Feature' && item.properties){
      props = item.properties;
      geom = item.geometry;
    } else {
      props = item;
      geom = item.geometry || null;
    }

    // find coords
    let lon = null, lat = null;
    if(geom && geom.type === 'Point' && Array.isArray(geom.coordinates)){
      [lon, lat] = geom.coordinates;
    } else if (props.lon !== undefined && props.lat !== undefined){
      lon = +props.lon; lat = +props.lat;
    } else if (props.LON && props.LAT){
      lon = +props.LON; lat = +props.LAT;
    } else {
      // skip if no coords
      continue;
    }

    // id and fields
    const id = (props.id || props.CRATER_ID || props.name || `fid_${Object.keys(featureIndex).length+1}`).toString();
    const diameter_m = props.diameter_m || (props.diameter_km ? +props.diameter_km * 1000 : (props.DIAMETER ? +props.DIAMETER : null)) || null;
    // parse numeric components if provided
    const spectral_mean = (props.spectral_mean === null || props.spectral_mean === undefined) ? null : +props.spectral_mean;
    const hydrogen_mean = (props.hydrogen_mean === null || props.hydrogen_mean === undefined) ? null : +props.hydrogen_mean;
    const depth_metric = (props.depth_metric === null || props.depth_metric === undefined) ? null : +props.depth_metric;
    // psr_overlap property maybe present but we'll recompute properly later
    const psr_overlap_prop = !!props.psr_overlap || !!props.PSR || !!props.psr;

    const fo = { id, name: props.name || id, lon:+lon, lat:+lat, diameter_m, spectral_mean, hydrogen_mean, depth_metric, psr_overlap: psr_overlap_prop, water_score: (props.water_score===undefined?null:(props.water_score===null?null:+props.water_score)), raw: props };
    featureIndex[id] = fo;
  }

  // create markers for all features
  Object.values(featureIndex).forEach(f => addFeatureMarker(f));
  toast(`Loaded ${Object.keys(featureIndex).length} features.`);
}

function addFeatureMarker(f){
  const latlng = [f.lat, f.lon];
  // radius: depends on diameter but keep in pixel space (circleMarker)
  const radius = f.diameter_m ? Math.max(6, Math.min(36, Math.log10(f.diameter_m + 1) * 3.5)) : 8;
  const color = scoreToColor(f.water_score);
  const marker = L.circleMarker(latlng, { radius, color, weight:1.6, fillOpacity:0.72 });
  marker.featureId = f.id;
  marker.on('click', () => { openFeature(f.id); setPermalink(f.id); });
  marker.bindPopup(popupHtml(f), { maxWidth: 320 });
  cluster.addLayer(marker);
  markerMap[f.id] = marker;
}

function popupHtml(f){
  return `
    <div class="popup-card">
      <h4>${escapeHtml(f.name)}</h4>
      <table class="popup-table">
        <tr><td><b>ID</b></td><td>${escapeHtml(f.id)}</td></tr>
        <tr><td><b>Lat / Lon</b></td><td>${f.lat.toFixed(6)} / ${f.lon.toFixed(6)}</td></tr>
        <tr><td><b>Diameter</b></td><td>${formatDiameter(f.diameter_m)}</td></tr>
        <tr><td><b>PSR</b></td><td>${f.psr_overlap ? 'Yes' : 'No'}</td></tr>
        <tr><td><b>Spectral</b></td><td>${f.spectral_mean===null? '—' : Number(f.spectral_mean).toFixed(3)}</td></tr>
        <tr><td><b>Hydrogen</b></td><td>${f.hydrogen_mean===null? '—' : Number(f.hydrogen_mean).toFixed(3)}</td></tr>
        <tr><td><b>Depth</b></td><td>${f.depth_metric===null? '—' : Number(f.depth_metric).toFixed(3)}</td></tr>
        <tr><td><b>Water score</b></td><td>${formatScore(f.water_score)}</td></tr>
      </table>
    </div>
  `;
}

///// ----------------- PSR overlap check (turf or bbox fallback) -----------------
function featurePointInPsr(f){
  if(!PSR_GEOJSON) return false;
  try {
    if(window.turf && typeof turf.booleanPointInPolygon === 'function'){
      const pt = turf.point([f.lon, f.lat]);
      for(const feat of (PSR_GEOJSON.features||[])){
        if(turf.booleanPointInPolygon(pt, feat)) return true;
      }
      return false;
    } else {
      // fallback bbox containment: compute feature bbox if necessary
      const p_lon = f.lon, p_lat = f.lat;
      for(const feat of (PSR_GEOJSON.features||[])){
        if(feat.bbox){
          const [minx,miny,maxx,maxy] = feat.bbox;
          if(p_lon >= minx && p_lon <= maxx && p_lat >= miny && p_lat <= maxy) return true;
        } else if (feat.geometry){
          // compute bbox from geometry coords
          const coordsFlat = [];
          const collect = (arr) => {
            if(typeof arr[0] === 'number') coordsFlat.push(arr);
            else arr.forEach(a=>collect(a));
          };
          collect(feat.geometry.coordinates);
          const xs = coordsFlat.map(c=>c[0]), ys = coordsFlat.map(c=>c[1]);
          const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
          if(p_lon >= minx && p_lon <= maxx && p_lat >= miny && p_lat <= maxy) return true;
        }
      }
      return false;
    }
  } catch(e){
    console.warn('PSR check error: ', e);
    return false;
  }
}

///// ----------------- Water-score computation & normalization -----------------
function normalizeAndComputeWaterScores(){
  // gather arrays for normalization
  const features = Object.values(featureIndex);
  if(!features.length) return;

  // ensure psr_overlap recomputed from PSR file if present
  features.forEach(f => {
    if(PSR_GEOJSON) {
      try { f.psr_overlap = featurePointInPsr(f); } catch(e){ /* ignore */ }
    }
  });

  const specVals = features.map(f => f.spectral_mean).filter(v => v !== null && v !== undefined);
  const hydroVals = features.map(f => f.hydrogen_mean).filter(v => v !== null && v !== undefined);
  const depthVals = features.map(f => f.depth_metric).filter(v => v !== null && v !== undefined);

  const specMin = specVals.length ? Math.min(...specVals) : 0;
  const specMax = specVals.length ? Math.max(...specVals) : 1;
  const hydroMin = hydroVals.length ? Math.min(...hydroVals) : 0;
  const hydroMax = hydroVals.length ? Math.max(...hydroVals) : 1;
  const depthMin = depthVals.length ? Math.min(...depthVals) : 0;
  const depthMax = depthVals.length ? Math.max(...depthVals) : 1;

  const baseWeights = { psr: 0.4, spec: 0.3, hydro: 0.2, depth: 0.1 };
  const SCORE_FLOOR = 0.02; // small floor — never show zero

  for(const f of features){
    // if already has a valid water_score (non-null), keep it but update color
    if(f.water_score !== null && f.water_score !== undefined && !isNaN(f.water_score)){
      const m = markerMap[f.id];
      if(m) m.setStyle({ color: scoreToColor(f.water_score) });
      continue;
    }

    // compute normalized component values
    const comps = [];
    // PSR is always available (we computed above), value 0 or 1
    comps.push({k:'psr', avail:true, val: f.psr_overlap ? 1 : 0, w: baseWeights.psr});
    // spectral
    if(f.spectral_mean !== null && f.spectral_mean !== undefined){
      const v = (f.spectral_mean - specMin) / (specMax - specMin + 1e-12);
      comps.push({k:'spec', avail:true, val: v, w: baseWeights.spec});
    } else {
      comps.push({k:'spec', avail:false, val: 0, w: baseWeights.spec});
    }
    // hydrogen
    if(f.hydrogen_mean !== null && f.hydrogen_mean !== undefined){
      const v = (f.hydrogen_mean - hydroMin) / (hydroMax - hydroMin + 1e-12);
      comps.push({k:'hydro', avail:true, val: v, w: baseWeights.hydro});
    } else {
      comps.push({k:'hydro', avail:false, val: 0, w: baseWeights.hydro});
    }
    // depth
    if(f.depth_metric !== null && f.depth_metric !== undefined){
      const v = (f.depth_metric - depthMin) / (depthMax - depthMin + 1e-12);
      comps.push({k:'depth', avail:true, val: v, w: baseWeights.depth});
    } else {
      comps.push({k:'depth', avail:false, val: 0, w: baseWeights.depth});
    }

    // reweight to available comps
    let totalW = 0;
    comps.forEach(c => { if(c.avail || c.k === 'psr') totalW += c.w; else c.w = 0; });
    if(totalW <= 0) {
      f.water_score = SCORE_FLOOR;
    } else {
      comps.forEach(c => c.w = c.w / totalW);
      const score = comps.reduce((sum, c) => sum + (c.val * c.w), 0);
      f.water_score = Number(Math.max(score, SCORE_FLOOR).toFixed(4));
    }

    // update marker color
    const m = markerMap[f.id];
    if(m) m.setStyle({ color: scoreToColor(f.water_score) });
  }

  // one more pass to update popups content if open
  Object.keys(markerMap).forEach(id => {
    try {
      const marker = markerMap[id];
      if(marker && marker.getPopup && marker.isPopupOpen && marker.isPopupOpen()){
        marker.setPopupContent(popupHtml(featureIndex[id]));
      }
    } catch(e){ /* ignore */ }
  });
}

///// ----------------- Suggestions -----------------
async function loadSuggestions(){
  try {
    const s = await safeJsonFetch(CONFIG.SUGGESTIONS_URL);
    SUGGESTIONS = s;
    console.log('Suggestions loaded');
  } catch(e){
    SUGGESTIONS = null;
    console.warn('No suggestions.json or failed to load');
  }
}

function showSuggestions(){
  suggestionsLayer.clearLayers();
  if(!SUGGESTIONS) { toast('No suggestions available.'); return; }
  const list = Array.isArray(SUGGESTIONS.suggestions) ? SUGGESTIONS.suggestions : (Array.isArray(SUGGESTIONS) ? SUGGESTIONS : []);
  if(!list.length){ toast('No suggestions present'); return; }
  for(const s of list){
    const latlng = [s.lat, s.lon];
    const m = L.circleMarker(latlng, { radius: 12, color: '#ff7a00', weight:2, fillOpacity:0.35 });
    m.bindPopup(`<b>${escapeHtml(s.name || s.id)}</b><br/>score: ${formatScore(s.water_score)}<br/><button class="accept-sugg btn small">Accept</button>`);
    m.on('popupopen', e => {
      setTimeout(()=> {
        const el = e.popup.getElement();
        if(!el) return;
        const btn = el.querySelector('.accept-sugg');
        if(btn) btn.onclick = ()=> { acceptSuggestion(s); e.popup.remove(); };
      }, 20);
    });
    suggestionsLayer.addLayer(m);
  }
  toast(`Displayed ${list.length} suggestions`);
}

function acceptSuggestion(s){
  const ann = {
    id: s.id || `sugg_${Date.now()}`,
    name: s.name || s.id || 'candidate',
    lon: +s.lon, lat: +s.lat,
    water_score: (s.water_score===undefined?null:s.water_score),
    source: 'suggestion',
    timestamp: new Date().toISOString(),
    comments: []
  };
  addAnnotation(ann);
}

///// ----------------- Annotations (localStorage) -----------------
function loadLocalAnnotations(){
  try { annotations = JSON.parse(localStorage.getItem(CONFIG.ANNOTATIONS_LS_KEY) || '[]'); } catch(e){ annotations = []; }
}
function saveLocalAnnotations(){ localStorage.setItem(CONFIG.ANNOTATIONS_LS_KEY, JSON.stringify(annotations)); renderAnnotationsList(); }
function addAnnotation(a){
  if(annotations.find(x => x.id === a.id)){ toast('Annotation already exists'); return; }
  annotations.push(a); saveLocalAnnotations(); toast('Annotation saved locally');
}
function deleteAnnotation(id){
  annotations = annotations.filter(x => x.id !== id); saveLocalAnnotations(); toast('Annotation removed');
}
function renderAnnotationsList(){
  const el = $('annotationsList');
  if(!el) return;
  if(!annotations.length){ el.innerHTML = '<div class="muted">None yet</div>'; return; }
  el.innerHTML = annotations.map(a => `
    <div style="padding:6px;border-radius:8px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:700">${escapeHtml(a.name)}</div>
        <div class="muted" style="font-size:12px">${a.lat? a.lat.toFixed(4):''}, ${a.lon? a.lon.toFixed(4):''} • ${formatScore(a.water_score)}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn small" data-act="zoom" data-id="${escapeHtml(a.id)}">Zoom</button>
        <button class="btn small ghost" data-act="del" data-id="${escapeHtml(a.id)}">Delete</button>
      </div>
    </div>`).join('');
  el.querySelectorAll('button[data-act]').forEach(b => {
    const act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    b.onclick = () => {
      if(act === 'zoom'){ const a = annotations.find(x => x.id === id); if(a && a.lat && a.lon) map.setView([a.lat, a.lon], Math.max(4, map.getZoom())); }
      if(act === 'del'){ deleteAnnotation(id); }
    };
  });
}

///// ----------------- Export (annotations + comments) -----------------
function exportAnnotations(){
  if(!annotations.length){ toast('No annotations to export'); return; }
  const features = annotations.map(a => ({
    type:'Feature',
    properties: { id: a.id, name: a.name, water_score: a.water_score, source: a.source, timestamp: a.timestamp, comments: a.comments || [] },
    geometry: { type:'Point', coordinates: [a.lon, a.lat] }
  }));
  const fc = { type:'FeatureCollection', features };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type:'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'annotations.geojson'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('Exported annotations.geojson');
}

///// ----------------- Comments storage & functions -----------------
function loadCommentsFromStorage(){
  try { commentsStore = JSON.parse(localStorage.getItem(CONFIG.COMMENTS_LS_KEY) || '{"featureComments":{},"freeComments":[]}'); } catch(e){ commentsStore = { featureComments:{}, freeComments:[] }; }
}
function saveCommentsToStorage(){ localStorage.setItem(CONFIG.COMMENTS_LS_KEY, JSON.stringify(commentsStore)); }
function addCommentToFeature(featureId, text){
  if(!featureId) return;
  commentsStore.featureComments[featureId] = commentsStore.featureComments[featureId] || [];
  commentsStore.featureComments[featureId].push({ text, ts: new Date().toISOString() });
  saveCommentsToStorage();
  toast('Comment added (local)');
  renderCommentsForFeature(featureId);
}
function addFreeComment(lat, lon, text){
  commentsStore.freeComments.push({ id: `fc_${Date.now()}`, lat, lon, text, ts: new Date().toISOString() });
  saveCommentsToStorage();
  toast('Map comment saved (local)');
}
function renderCommentsForFeature(featureId){
  const node = $('commentsList');
  if(!node) return;
  const list = commentsStore.featureComments[featureId] || [];
  if(!list.length) { node.innerHTML = '<div class="muted">No comments yet</div>'; return; }
  node.innerHTML = list.map(c => `<div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.01);margin-bottom:6px"><div>${escapeHtml(c.text)}</div><div class="muted" style="font-size:12px;margin-top:6px">${new Date(c.ts).toLocaleString()}</div></div>`).join('');
}

///// ----------------- Comment Mode (UI button + map click handling) -----------------
function createCommentModeButton(){
  // create a small floating button top-right
  commentModeButton = document.createElement('button');
  commentModeButton.id = 'commentModeBtn';
  commentModeButton.className = 'btn ghost';
  commentModeButton.style.position = 'absolute';
  commentModeButton.style.right = '18px';
  commentModeButton.style.top = '86px';
  commentModeButton.style.zIndex = 2000;
  commentModeButton.textContent = 'Comment';
  document.body.appendChild(commentModeButton);

  commentModeButton.onclick = () => {
    commentModeActive = !commentModeActive;
    commentModeButton.textContent = commentModeActive ? 'Comment: ON (click map)' : 'Comment';
    commentModeButton.style.background = commentModeActive ? 'rgba(255,122,0,0.95)' : '';
    map.getContainer().style.cursor = commentModeActive ? 'crosshair' : '';
    if(commentModeActive) toast('Comment mode: click on map to leave a comment (click marker to attach to crater).');
  };

  // map click handler (only active when commentModeActive)
  map.on('click', async (e) => {
    if(!commentModeActive) return;
    const { lat, lng } = e.latlng;
    // find nearest feature using turf if available
    let nearest = null;
    let minKm = Infinity;
    Object.values(featureIndex).forEach(f => {
      try {
        if(window.turf && typeof turf.distance === 'function'){
          const d = turf.distance(turf.point([f.lon, f.lat]), turf.point([lng, lat]), { units: 'kilometers' });
          if(d < minKm) { minKm = d; nearest = f; }
        } else {
          // simple haversine approximation not implemented — use euclidean degree approx
          const ddeg = Math.hypot(f.lat - lat, f.lon - lng);
          if(ddeg < minKm){ minKm = ddeg; nearest = f; }
        }
      } catch(e){ /* ignore */ }
    });

    // threshold to attach to crater
    const thresholdKm = CONFIG.COMMENT_NEARBY_KM;
    if(minKm !== Infinity && minKm <= thresholdKm && nearest){
      // open feature and open comment box in details
      openFeature(nearest.id);
      // prefill comment textarea if possible
      const ta = $('commentText');
      if(ta){ ta.focus(); }
      // also add suggestion to toggle off comment mode
      commentModeActive = false; commentModeButton.textContent = 'Comment'; map.getContainer().style.cursor = '';
      return;
    }

    // otherwise show a small popup at clicked location to enter comment
    const popup = L.popup({ closeOnClick:false, autoClose:false, maxWidth:320 })
      .setLatLng([lat, lng])
      .setContent(`<div style="min-width:220px">
        <div style="font-weight:700;margin-bottom:6px">Map comment</div>
        <textarea id="pm_text" rows="3" style="width:100%;padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);border:none;color:#e8f4ff"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="pm_save" class="btn small">Save</button>
          <button id="pm_cancel" class="btn small ghost">Cancel</button>
        </div>
      </div>`).openOn(map);

    // wire buttons after DOM insertion
    setTimeout(()=> {
      const btnSave = document.getElementById('pm_save'), btnCancel = document.getElementById('pm_cancel'), ta = document.getElementById('pm_text');
      if(btnSave) btnSave.onclick = () => {
        const txt = (ta && ta.value || '').trim();
        if(!txt){ toast('Type a comment'); return; }
        addFreeComment(lat, lng, txt);
        map.closePopup(popup);
        commentModeActive = false; commentModeButton.textContent = 'Comment'; map.getContainer().style.cursor = '';
      };
      if(btnCancel) btnCancel.onclick = () => { map.closePopup(popup); commentModeActive = false; commentModeButton.textContent = 'Comment'; map.getContainer().style.cursor = ''; };
      if(ta) ta.focus();
    }, 50);
  });
}

///// ----------------- Open feature details panel & comment posting -----------------
function openFeature(id){
  const f = featureIndex[id];
  if(!f) return;
  const el = $('featureDetails');
  if(!el) return;
  el.innerHTML = `
    <div class="popup-card">
      <h4>${escapeHtml(f.name)}</h4>
      <table class="details-table">
        <tr><td><b>ID</b></td><td>${escapeHtml(f.id)}</td></tr>
        <tr><td><b>Lat / Lon</b></td><td>${f.lat.toFixed(6)} / ${f.lon.toFixed(6)}</td></tr>
        <tr><td><b>Diameter</b></td><td>${formatDiameter(f.diameter_m)}</td></tr>
        <tr><td><b>PSR</b></td><td>${f.psr_overlap ? 'Yes' : 'No'}</td></tr>
        <tr><td><b>Spectral</b></td><td>${f.spectral_mean===null? '—' : Number(f.spectral_mean).toFixed(3)}</td></tr>
        <tr><td><b>Hydrogen</b></td><td>${f.hydrogen_mean===null? '—' : Number(f.hydrogen_mean).toFixed(3)}</td></tr>
        <tr><td><b>Depth</b></td><td>${f.depth_metric===null? '—' : Number(f.depth_metric).toFixed(3)}</td></tr>
        <tr><td><b>Water score</b></td><td>${formatScore(f.water_score)}</td></tr>
      </table>

      <div style="margin-top:10px;display:flex;gap:8px">
        <button id="acceptBtn" class="btn">Accept as annotation</button>
        <button id="zoomBtn" class="btn ghost">Zoom to</button>
      </div>

      <div style="margin-top:12px">
        <label style="font-weight:700;display:block;margin-bottom:6px">Comments</label>
        <textarea id="commentText" rows="3" style="width:100%;padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);border:none;color:#e8f4ff" placeholder="Add a comment or observation..."></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="postComment" class="btn small">Post comment</button>
          <div class="muted" style="align-self:center">Comments are saved locally</div>
        </div>
        <div id="commentsList" style="margin-top:10px"></div>
      </div>
    </div>
  `;
  // wire
  $('zoomBtn').onclick = () => map.setView([f.lat, f.lon], Math.max(4, map.getZoom()));
  $('acceptBtn').onclick = () => acceptFeatureAsAnnotation(f);
  $('postComment').onclick = () => {
    const txt = $('commentText').value.trim();
    if(!txt) { toast('Type a comment first'); return; }
    addCommentToFeature(f.id, txt);
    $('commentText').value = '';
    renderCommentsForFeature(f.id);
  };
  renderCommentsForFeature(f.id);
  // open popup on marker if exists
  const m = markerMap[f.id];
  if(m) { m.openPopup(); }
  // highlight marker visually
  highlightFeatureMarker(f.id);
}

function acceptFeatureAsAnnotation(f){
  const ann = {
    id: f.id,
    name: f.name,
    lat: f.lat,
    lon: f.lon,
    water_score: f.water_score,
    source: 'feature',
    timestamp: new Date().toISOString(),
    comments: commentsStore.featureComments[f.id] ? [...commentsStore.featureComments[f.id]] : []
  };
  addAnnotation(ann);
}

function highlightFeatureMarker(id){
  // briefly change marker style
  try {
    Object.values(markerMap).forEach(m => m.setStyle({ weight:1.6 }));
    const m = markerMap[id];
    if(m) {
      m.setStyle({ weight:3, fillOpacity:0.9 });
      setTimeout(()=> { if(markerMap[id]) markerMap[id].setStyle({ weight:1.6, fillOpacity:0.72 }); }, 2500);
    }
  } catch(e){ /* ignore */ }
}

///// ----------------- Search & Permalink -----------------
function doSearch(){
  const q = ($('searchInput') && $('searchInput').value || '').trim().toLowerCase();
  if(!q){ toast('Enter crater name or id'); return; }
  let f = featureIndex[q] || Object.values(featureIndex).find(x => x.name && x.name.toLowerCase().includes(q));
  if(!f){ toast('No match'); return; }
  openFeature(f.id);
  map.setView([f.lat, f.lon], Math.max(4, map.getZoom()));
  setPermalink(f.id);
}

function setPermalink(selectedId){
  const c = map.getCenter();
  const z = map.getZoom();
  const parts = [z, c.lat.toFixed(6), c.lng.toFixed(6), 'vis', selectedId || ''];
  location.hash = parts.join('/');
}
function readPermalink(){
  if(!location.hash) return null;
  const parts = location.hash.replace('#','').split('/');
  if(parts.length < 4) return null;
  return { z:+parts[0], lat:+parts[1], lon:+parts[2], layer:parts[3], selectedId: parts[4] || null };
}

///// ----------------- UI wiring -----------------
function wireUI(){
  // topbar buttons
  const searchBtn = $('searchBtn');
  if(searchBtn) searchBtn.onclick = doSearch;
  const suggestBtn = $('suggestBtn');
  if(suggestBtn) suggestBtn.onclick = showSuggestions;
  const exportBtn = $('exportBtn');
  if(exportBtn) exportBtn.onclick = exportAnnotations;

  // search enter
  const sI = $('searchInput');
  if(sI) sI.addEventListener('keydown', e => { if(e.key === 'Enter') doSearch(); });

  // layer radios (we only have vis tiles now)
  document.querySelectorAll('input[name="layer"]').forEach(r => r.addEventListener('change', e => {
    const v = e.target.value;
    if(v !== 'vis'){ toast('Layer not available — add tiles for IR/Elevation/Index to enable.'); const visRadio = document.querySelector('input[name="layer"][value="vis"]'); if(visRadio) visRadio.checked = true; }
  }));

  // open permalink selected feature if present
  const pl = readPermalink();
  if(pl && pl.selectedId) {
    setTimeout(()=> {
      if(featureIndex[pl.selectedId]) openFeature(pl.selectedId);
    }, 700);
  }
}

///// ----------------- Misc helpers -----------------
function scoreToColor(s){
  if(s === null || s === undefined || isNaN(s)) return '#7f8c8d';
  const v = Math.max(0, Math.min(1, +s));
  const r = Math.round(255 * Math.min(1, Math.max(0, (v - 0.5) * 2)));
  const b = Math.round(255 * Math.min(1, Math.max(0, (0.5 - v) * 2)));
  const g = Math.round(255 * (1 - Math.abs(v - 0.5) * 2));
  return `rgb(${r},${g},${b})`;
}
function formatScore(s){ return (s === null || s === undefined) ? '—' : Number(s).toFixed(3); }

///// End of app.js
