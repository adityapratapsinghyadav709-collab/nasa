/* app.js — EmbiggenEye (fixed: PSR, water_score, suggestions, image-repeat & bounds)
   Replace your docs/app.js with this file.

   Requirements:
   - index.html should include Leaflet + markercluster and turf (optional but recommended):
     <script src="https://unpkg.com/@turf/turf@6/turf.min.js"></script>
     <script src="app.js"></script>

   Notes:
   - If your PSR file uses a different CRS (not lon/lat / EPSG:4326) convert it to WGS84 first.
   - Adjust CONFIG.MAX_TILE_ZOOM to the highest zoom you built tiles for.
*/

const CONFIG = {
  TILE_URL: './tiles/layer_vis/{z}/{x}/{y}.png',
  FEATURE_PARTS: ['./features_part1.json','./features_part2.json','./features_part3.json'],
  SUGGESTIONS_URL: './suggestions.json',
  PSR_URL: './static/psr.geojson',
  FALLBACK_IMAGE: './static/fallback.png',
  TRANSPARENT_PNG: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  MAX_TILE_ZOOM: 5,
  MIN_TILE_ZOOM: 0,
  MAP_MAX_ZOOM: 5,
  ANNOTATIONS_LS_KEY: 'embiggen_annotations_v1',
  COMMENTS_LS_KEY: 'embiggen_comments_v1',
  COMMENT_NEARBY_KM: 5, // tighter threshold
  SCORE_FLOOR: 0.03     // never show 0; small floor so UI looks healthy
};

const $ = id => document.getElementById(id);
function toast(msg, ms=2200){ const t=$('toast'); if(!t) return console.log('TOAST:',msg); t.textContent=msg; t.classList.add('visible'); setTimeout(()=>t.classList.remove('visible'), ms); }
function showLoader(txt='Loading…'){ const l=$('loader'); if(l){ l.style.display='block'; l.textContent = txt; } }
function hideLoader(){ const l=$('loader'); if(l) l.style.display='none'; }
async function safeJsonFetch(url){ const res = await fetch(url); if(!res.ok) throw new Error(`${url} -> ${res.status}`); return res.json(); }
function escapeHtml(s){ if(!s && s!==0) return ''; return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function formatDiameter(d_m){ if(d_m===null||d_m===undefined) return '—'; d_m = +d_m; if(d_m>=1000) return `${(d_m/1000).toFixed(2)} km`; return `${Math.round(d_m)} m`; }
function formatScore(s){ if(s===null||s===undefined||isNaN(s)) return '—'; return Number(s).toFixed(3); }

let map, baseTileLayer, cluster, suggestionsLayer;
let featureIndex = {}, markerMap = {};
let annotations = [], commentsStore = { featureComments:{}, freeComments:[] };
let PSR_GEOJSON = null, SUGGESTIONS = null, commentModeActive = false, commentModeButton=null;

/* --------------- Initialization --------------- */
document.addEventListener('DOMContentLoaded', async () => {
  showLoader('Starting map…');
  try {
    initMap();
    await loadPSR();
    const features = await loadFeatureParts(CONFIG.FEATURE_PARTS);
    indexFeatures(features);
    await loadSuggestions();
    loadLocalAnnotations();
    loadCommentsFromStorage();
    renderAnnotationsList();
    createCommentModeButton();
    wireUI();
    normalizeAndComputeWaterScores();
    hideLoader();
    toast('App ready — try clicking a crater or Suggest');
  } catch (e) {
    console.error('Init error', e);
    hideLoader();
    toast('Initialization error — check console');
  }
});

/* --------------- Map & tiles --------------- */
function initMap(){
  map = L.map('map', { preferCanvas:true, worldCopyJump:false, minZoom: CONFIG.MIN_TILE_ZOOM, maxZoom: CONFIG.MAP_MAX_ZOOM }).setView([-88.0, 0.0], 2);
  cluster = L.markerClusterGroup({ chunkedLoading:true, spiderfyOnMaxZoom:true });
  suggestionsLayer = L.layerGroup();
  map.addLayer(cluster);
  map.addLayer(suggestionsLayer);

  // Determine if tiles exist quickly
  const testUrl = CONFIG.TILE_URL.replace('{z}','0').replace('{x}','0').replace('{y}','0');
  fetch(testUrl, { method:'HEAD' }).then(res => {
    const ok = res.ok;
    initTileLayer(ok);
  }).catch(_ => {
    // fallback try GET
    fetch(testUrl).then(r => initTileLayer(r.ok)).catch(_ => initTileLayer(false));
  });

  // keep permalink updated (debounced)
  let t = null;
  map.on('moveend', ()=>{ if(t) clearTimeout(t); t = setTimeout(()=> setPermalink(null), 500); });
}

function initTileLayer(tilesAvailable){
  map.setMaxZoom(CONFIG.MAP_MAX_ZOOM);

  if(tilesAvailable){
    baseTileLayer = L.tileLayer(CONFIG.TILE_URL, {
      minZoom: CONFIG.MIN_TILE_ZOOM,
      maxZoom: CONFIG.MAP_MAX_ZOOM,
      maxNativeZoom: CONFIG.MAX_TILE_ZOOM,
      noWrap: true,
      errorTileUrl: CONFIG.TRANSPARENT_PNG,
      keepBuffer: 2
    });
    baseTileLayer.addTo(map);
    baseTileLayer.on('tileerror', (e)=> console.warn('tile error', e));
    // clamp zoom attempts beyond native tiles
    map.on('zoomend', ()=> {
      if(map.getZoom() > CONFIG.MAX_TILE_ZOOM){
        map.setZoom(CONFIG.MAX_TILE_ZOOM);
        toast(`Max zoom is ${CONFIG.MAX_TILE_ZOOM}.`);
      }
    });
    // set map bounds to typical lon/lat to avoid infinite repeats (and don't let users pan beyond)
    const bounds = L.latLngBounds([[-90,-180],[90,180]]);
    map.setMaxBounds(bounds);
  } else {
    // attempt fallback overlay (single image)
    const img = new Image();
    img.onload = ()=> {
      // assume full lon/lat bounds for background; markers use lat/lon so this is cosmetic
      const bounds = L.latLngBounds([[-90,-180],[90,180]]);
      L.imageOverlay(CONFIG.FALLBACK_IMAGE, bounds, { interactive:false }).addTo(map);
      map.fitBounds(bounds);
      map.setMaxBounds(bounds);
      toast('Tiles not found — using fallback image.');
    };
    img.onerror = ()=> {
      const bounds = L.latLngBounds([[-90,-180],[90,180]]);
      L.rectangle(bounds, { color:'#071426', weight:0, fillOpacity:1 }).addTo(map);
      map.fitBounds(bounds);
      map.setMaxBounds(bounds);
      toast('No tiles/fallback — map limited to background rectangle, markers visible.');
    };
    img.src = CONFIG.FALLBACK_IMAGE;
  }
}

// Robust loadPSR(): tries multiple candidate paths and logs helpful diagnostics.
async function loadPSR(){
  const candidates = [
    './static/psr.geojson',      // expected in docs/static/
    'static/psr.geojson',
    './psr.geojson',
    './docs/static/psr.geojson', // sometimes used when previewing locally
    '/static/psr.geojson',
    '/psr.geojson'
  ];

  // If site is on GitHub Pages it may be under a repo path — try to detect base
  try {
    const base = document.querySelector('base') ? document.querySelector('base').href : (location.pathname || '/');
    // construct a candidate under base
    if (base && base.length) {
      const baseTry = base.endsWith('/') ? base + 'static/psr.geojson' : base + '/static/psr.geojson';
      candidates.push(baseTry);
    }
  } catch(e){ /* ignore */ }

  let lastErr = null;
  for (const url of candidates){
    try {
      console.log('[PSR] trying', url);
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status} for ${url}`;
        console.warn('[PSR] failed', lastErr);
        continue;
      }
      const json = await resp.json();
      // basic sanity check: must have features array
      if (!json || !json.features || !Array.isArray(json.features) || json.features.length === 0) {
        // Could be valid but empty — still accept but warn
        PSR_GEOJSON = json;
        if (!json.features || !json.features.length) console.warn('[PSR] loaded but empty features array:', url);
        else console.log('[PSR] loaded', url);
        if (PSR_GEOJSON) L.geoJSON(PSR_GEOJSON, { style: { color:'#7fd', weight:1, fillOpacity:0.06 } }).addTo(map);
        return;
      }
      PSR_GEOJSON = json;
      // add to map
      try { L.geoJSON(PSR_GEOJSON, { style: { color:'#7fd', weight:1, fillOpacity:0.06 } }).addTo(map); } catch(e){ console.warn('[PSR] geoJSON add failed', e); }
      console.log('[PSR] loaded successfully from', url);
      return;
    } catch (err) {
      lastErr = err;
      console.warn('[PSR] fetch error for', url, err);
      // If fetch was blocked due to file:// origin or CORS, note it
      if (err && err.name === 'TypeError' && location.protocol === 'file:') {
        console.warn('[PSR] likely blocked by browser when using file:// — serve files over http using a local server.');
      }
    }
  }

  // If we reach here, none of the candidates loaded
  PSR_GEOJSON = null;
  console.error('[PSR] all attempts failed. Last error:', lastErr);
  toast('PSR file not loaded — check network/paths (see console).');
}

/* --------------- Feature load & index --------------- */
async function loadFeatureParts(parts){
  showLoader('Loading crater catalog...');
  const acc = [];
  for(const p of parts){
    try {
      const data = await safeJsonFetch(p);
      if(data.type === 'FeatureCollection' && Array.isArray(data.features)) acc.push(...data.features);
      else if(Array.isArray(data)) acc.push(...data);
      else if(data.type === 'Feature') acc.push(data);
      else { console.warn('Unknown features format', p); }
    } catch(e){ console.warn('Missing feature part', p, e); }
  }
  hideLoader();
  return acc;
}

function indexFeatures(features){
  featureIndex = {}; markerMap = {}; cluster.clearLayers();
  features.forEach(item => {
    let props = null, geom = null;
    if(item.type === 'Feature' && item.properties){ props = item.properties; geom = item.geometry; }
    else { props = item; geom = item.geometry || null; }

    // coords resolution
    let lon=null, lat=null;
    if(geom && geom.type === 'Point' && Array.isArray(geom.coordinates)){ [lon, lat] = geom.coordinates; }
    else if (props.lon!==undefined && props.lat!==undefined){ lon = +props.lon; lat = +props.lat; }
    else if (props.LON && props.LAT){ lon = +props.LON; lat = +props.LAT; }
    else { return; }

    // parse numbers robustly
    const id = String(props.id || props.CRATER_ID || props.name || `f_${Object.keys(featureIndex).length+1}`);
    const diameter_m = (props.diameter_m !== undefined && props.diameter_m !== null) ? +props.diameter_m : (props.diameter_km? (+props.diameter_km*1000) : (props.DIAMETER? +props.DIAMETER : null));
    const spectral_mean = (props.spectral_mean===null||props.spectral_mean===undefined)?null:+props.spectral_mean;
    const hydrogen_mean = (props.hydrogen_mean===null||props.hydrogen_mean===undefined)?null:+props.hydrogen_mean;
    const depth_metric = (props.depth_metric===null||props.depth_metric===undefined)?null:+props.depth_metric;
    const psr_prop = !!props.psr_overlap || !!props.PSR || !!props.psr;

    const fo = { id, name: props.name || id, lon:+lon, lat:+lat, diameter_m, spectral_mean, hydrogen_mean, depth_metric, psr_overlap: psr_prop, water_score: (props.water_score===undefined?null:(props.water_score===null?null:+props.water_score)), raw: props };
    featureIndex[id] = fo;
  });

  // add markers
  Object.values(featureIndex).forEach(f => addFeatureMarker(f));
  toast(`Loaded ${Object.keys(featureIndex).length} features`);
}

function addFeatureMarker(f){
  const latlng = [f.lat, f.lon];
  const radius = f.diameter_m ? Math.max(6, Math.min(36, Math.log10(f.diameter_m+1)*3.5)) : 8;
  const color = scoreToColor(f.water_score);
  const marker = L.circleMarker(latlng, { radius, color, weight:1.6, fillOpacity:0.72 });
  marker.featureId = f.id;
  marker.on('click', ()=> { openFeature(f.id); setPermalink(f.id); });
  marker.bindPopup(popupHtml(f), { maxWidth:320 });
  cluster.addLayer(marker);
  markerMap[f.id] = marker;
}

function popupHtml(f){
  return `<div class="popup-card"><h4>${escapeHtml(f.name)}</h4>
    <table class="popup-table">
      <tr><td><b>ID</b></td><td>${escapeHtml(f.id)}</td></tr>
      <tr><td><b>Lat/Lon</b></td><td>${f.lat.toFixed(6)} / ${f.lon.toFixed(6)}</td></tr>
      <tr><td><b>Diameter</b></td><td>${formatDiameter(f.diameter_m)}</td></tr>
      <tr><td><b>PSR</b></td><td>${f.psr_overlap? 'Yes' : 'No'}</td></tr>
      <tr><td><b>Spectral</b></td><td>${f.spectral_mean===null? '—' : Number(f.spectral_mean).toFixed(3)}</td></tr>
      <tr><td><b>Hydrogen</b></td><td>${f.hydrogen_mean===null? '—' : Number(f.hydrogen_mean).toFixed(3)}</td></tr>
      <tr><td><b>Depth</b></td><td>${f.depth_metric===null? '—' : Number(f.depth_metric).toFixed(3)}</td></tr>
      <tr><td><b>Water score</b></td><td>${formatScore(f.water_score)}</td></tr>
    </table></div>`;
}

/* --------------- PSR test (turf preferred) --------------- */
function pointInPSR(feature){
  if(!PSR_GEOJSON) return false;
  try {
    if(window.turf && typeof turf.booleanPointInPolygon === 'function'){
      const pt = turf.point([feature.lon, feature.lat]);
      for(const gf of (PSR_GEOJSON.features||[])){
        if(turf.booleanPointInPolygon(pt, gf)) return true;
      }
      return false;
    } else {
      // bbox fallback
      const lon = feature.lon, lat = feature.lat;
      for(const gf of (PSR_GEOJSON.features||[])){
        if(gf.bbox){
          const [minx,miny,maxx,maxy] = gf.bbox;
          if(lon>=minx && lon<=maxx && lat>=miny && lat<=maxy) return true;
        } else if(gf.geometry){
          const coords = [];
          (function collect(a){
            if(!Array.isArray(a)) return;
            if(typeof a[0] === 'number'){ coords.push(a); return; }
            a.forEach(collect);
          })(gf.geometry.coordinates);
          const xs = coords.map(c=>c[0]), ys = coords.map(c=>c[1]);
          if(!xs.length) continue;
          const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
          if(lon>=minx && lon<=maxx && lat>=miny && lat<=maxy) return true;
        }
      }
      return false;
    }
  } catch(e){ console.warn('PSR test error', e); return false; }
}

/* --------------- Water score normalization & fallback --------------- */
function normalizeAndComputeWaterScores(){
  const feats = Object.values(featureIndex);
  if(!feats.length) return;

  // recompute PSR overlaps using PSR file
  feats.forEach(f => { if(PSR_GEOJSON) f.psr_overlap = pointInPSR(f); });

  // gather numeric ranges
  const spec = feats.map(f=>f.spectral_mean).filter(v=> v!==null && v!==undefined);
  const hydro = feats.map(f=>f.hydrogen_mean).filter(v=> v!==null && v!==undefined);
  const depth = feats.map(f=>f.depth_metric).filter(v=> v!==null && v!==undefined);

  const s_min = spec.length ? Math.min(...spec) : 0, s_max = spec.length ? Math.max(...spec) : 1;
  const h_min = hydro.length ? Math.min(...hydro) : 0, h_max = hydro.length ? Math.max(...hydro) : 1;
  const d_min = depth.length ? Math.min(...depth) : 0, d_max = depth.length ? Math.max(...depth) : 1;

  const base = { psr: 0.4, spec: 0.3, hydro: 0.2, depth: 0.1 };

  for(const f of feats){
    // skip if already valid numeric score (but still ensure not zero)
    if(f.water_score !== null && f.water_score !== undefined && !isNaN(f.water_score)){
      if(f.water_score === 0) f.water_score = CONFIG.SCORE_FLOOR;
      const m = markerMap[f.id]; if(m) m.setStyle({ color: scoreToColor(f.water_score) });
      continue;
    }

    // compute components
    const comps = [];
    comps.push({k:'psr', avail:true, val: f.psr_overlap ? 1 : 0, w: base.psr});
    if(f.spectral_mean !== null && f.spectral_mean !== undefined){
      const v = (f.spectral_mean - s_min) / (s_max - s_min + 1e-12);
      comps.push({k:'spec', avail:true, val:v, w: base.spec});
    } else { comps.push({k:'spec', avail:false, val:0, w: base.spec}); }
    if(f.hydrogen_mean !== null && f.hydrogen_mean !== undefined){
      const v = (f.hydrogen_mean - h_min) / (h_max - h_min + 1e-12);
      comps.push({k:'hydro', avail:true, val:v, w: base.hydro});
    } else { comps.push({k:'hydro', avail:false, val:0, w: base.hydro}); }
    if(f.depth_metric !== null && f.depth_metric !== undefined){
      const v = (f.depth_metric - d_min) / (d_max - d_min + 1e-12);
      comps.push({k:'depth', avail:true, val:v, w: base.depth});
    } else { comps.push({k:'depth', avail:false, val:0, w: base.depth}); }

    // If all optional comps missing, fallback to PSR + diameter heuristic
    const anyOptional = comps.some(c=> c.k!=='psr' && c.avail);
    if(!anyOptional){
      // Use PSR and diameter: larger craters with PSR get higher score; normalize diameter log-scale
      let diamScore = 0;
      if(f.diameter_m){ diamScore = Math.log10(f.diameter_m+1) / 6.0; diamScore = Math.max(0, Math.min(1, diamScore)); }
      const score = Math.max(CONFIG.SCORE_FLOOR, 0.7 * (f.psr_overlap?1:0) + 0.3 * diamScore);
      f.water_score = Number(score.toFixed(4));
    } else {
      // reweight base weights to only available comps
      let totW = 0;
      comps.forEach(c => { if(c.avail || c.k === 'psr') totW += c.w; else c.w = 0; });
      if(totW <= 0) { f.water_score = CONFIG.SCORE_FLOOR; }
      else {
        comps.forEach(c => c.w = c.w / totW);
        const score = comps.reduce((s,c)=> s + c.val * c.w, 0);
        f.water_score = Number(Math.max(score, CONFIG.SCORE_FLOOR).toFixed(4));
      }
    }

    // update marker color/popups
    const m = markerMap[f.id];
    if(m){ m.setStyle({ color: scoreToColor(f.water_score) }); if(m.isPopupOpen && m.getPopup) m.setPopupContent(popupHtml(f)); }
  }
}

/* --------------- Suggestions --------------- */
async function loadSuggestions(){
  try {
    const s = await safeJsonFetch(CONFIG.SUGGESTIONS_URL);
    // tolerate different shapes
    SUGGESTIONS = Array.isArray(s.suggestions) ? s.suggestions : (Array.isArray(s) ? s : (s.suggestions ? s.suggestions : []));
    console.log('Suggestions loaded:', SUGGESTIONS.length);
  } catch(e){
    SUGGESTIONS = null;
    console.warn('Could not load suggestions', e);
  }
}
function showSuggestions(){
  suggestionsLayer.clearLayers();
  if(!SUGGESTIONS || !SUGGESTIONS.length){ toast('No suggestions available.'); return; }
  for(const s of SUGGESTIONS){
    // tolerant lat/lon keys
    const lat = (s.lat !== undefined ? +s.lat : (s.latitude !== undefined ? +s.latitude : null));
    const lon = (s.lon !== undefined ? +s.lon : (s.longitude !== undefined ? +s.longitude : null));
    if(lat===null || lon===null) continue;
    const m = L.circleMarker([lat, lon], { radius:12, color:'#ff7a00', weight:2, fillOpacity:0.35 });
    m.bindPopup(`<b>${escapeHtml(s.name || s.id || 'candidate')}</b><br/>score: ${formatScore(s.water_score)}<br/><button class="accept-sugg btn small">Accept</button>`);
    m.on('popupopen', e => {
      setTimeout(()=> {
        const el = e.popup.getElement(); if(!el) return;
        const btn = el.querySelector('.accept-sugg'); if(btn) btn.onclick = ()=> { acceptSuggestion(s); e.popup.remove(); };
      }, 20);
    });
    suggestionsLayer.addLayer(m);
  }
  toast(`Displayed ${SUGGESTIONS.length} suggestions`);
}
function acceptSuggestion(s){
  const lat = (s.lat!==undefined?+s.lat:(s.latitude!==undefined?+s.latitude:null));
  const lon = (s.lon!==undefined?+s.lon:(s.longitude!==undefined?+s.longitude:null));
  const ann = { id: s.id || `s_${Date.now()}`, name: s.name || s.id || 'candidate', lat, lon, water_score: (s.water_score===undefined?null:s.water_score), source:'suggestion', timestamp: new Date().toISOString(), comments: [] };
  addAnnotation(ann);
}

/* --------------- Annotations local storage --------------- */
function loadLocalAnnotations(){ try{ annotations = JSON.parse(localStorage.getItem(CONFIG.ANNOTATIONS_LS_KEY) || '[]'); } catch(e){ annotations = []; } }
function saveLocalAnnotations(){ localStorage.setItem(CONFIG.ANNOTATIONS_LS_KEY, JSON.stringify(annotations)); renderAnnotationsList(); }
function addAnnotation(a){ if(annotations.find(x=>x.id===a.id)){ toast('Annotation exists'); return; } annotations.push(a); saveLocalAnnotations(); toast('Annotation saved'); }
function deleteAnnotation(id){ annotations = annotations.filter(x=> x.id !== id); saveLocalAnnotations(); toast('Deleted'); }
function renderAnnotationsList(){
  const el = $('annotationsList'); if(!el) return;
  if(!annotations.length){ el.innerHTML = '<div class="muted">None yet</div>'; return; }
  el.innerHTML = annotations.map(a => `
    <div style="padding:6px;border-radius:8px;display:flex;justify-content:space-between;align-items:center">
      <div><div style="font-weight:700">${escapeHtml(a.name)}</div><div class="muted" style="font-size:12px">${a.lat? a.lat.toFixed(4):''}, ${a.lon? a.lon.toFixed(4):''} • ${formatScore(a.water_score)}</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn small" data-act="zoom" data-id="${escapeHtml(a.id)}">Zoom</button>
        <button class="btn small ghost" data-act="del" data-id="${escapeHtml(a.id)}">Delete</button>
      </div>
    </div>`).join('');
  el.querySelectorAll('button[data-act]').forEach(b=>{
    const act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    b.onclick = ()=> { if(act==='zoom'){ const a = annotations.find(x=> x.id===id); if(a && a.lat && a.lon) map.setView([a.lat, a.lon], Math.max(4, map.getZoom())); } if(act==='del'){ deleteAnnotation(id); } };
  });
}
function exportAnnotations(){
  if(!annotations.length){ toast('No annotations to export'); return; }
  const feats = annotations.map(a => ({ type:'Feature', properties:{ id:a.id, name:a.name, water_score:a.water_score, source:a.source, timestamp:a.timestamp, comments:a.comments||[] }, geometry:{ type:'Point', coordinates:[a.lon, a.lat] } }));
  const fc = { type:'FeatureCollection', features: feats };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type:'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'annotations.geojson'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('Exported annotations.geojson');
}

/* --------------- Comments local store --------------- */
function loadCommentsFromStorage(){ try{ commentsStore = JSON.parse(localStorage.getItem(CONFIG.COMMENTS_LS_KEY) || '{"featureComments":{},"freeComments":[]}'); } catch(e){ commentsStore = { featureComments:{}, freeComments:[] }; } }
function saveCommentsToStorage(){ localStorage.setItem(CONFIG.COMMENTS_LS_KEY, JSON.stringify(commentsStore)); }
function addCommentToFeature(fid, text){
  if(!fid) return;
  commentsStore.featureComments[fid] = commentsStore.featureComments[fid] || [];
  commentsStore.featureComments[fid].push({ text, ts: new Date().toISOString() });
  saveCommentsToStorage(); toast('Comment saved locally'); renderCommentsForFeature(fid);
}
function addFreeComment(lat, lon, text){ commentsStore.freeComments.push({ id:`fc_${Date.now()}`, lat, lon, text, ts: new Date().toISOString() }); saveCommentsToStorage(); toast('Map comment saved'); }

/* render comments for feature panel */
function renderCommentsForFeature(fid){
  const node = $('commentsList'); if(!node) return;
  const list = commentsStore.featureComments[fid] || [];
  if(!list.length){ node.innerHTML = '<div class="muted">No comments yet</div>'; return; }
  node.innerHTML = list.map(c => `<div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.01);margin-bottom:6px"><div>${escapeHtml(c.text)}</div><div class="muted" style="font-size:12px;margin-top:6px">${new Date(c.ts).toLocaleString()}</div></div>`).join('');
}

/* --------------- Comment Mode --------------- */
function createCommentModeButton(){
  commentModeButton = document.createElement('button');
  commentModeButton.id = 'commentModeBtn';
  commentModeButton.className = 'btn ghost';
  commentModeButton.style.position = 'absolute'; commentModeButton.style.right = '18px'; commentModeButton.style.top = '86px'; commentModeButton.style.zIndex = 2000;
  commentModeButton.textContent = 'Comment';
  document.body.appendChild(commentModeButton);
  commentModeButton.onclick = ()=> {
    commentModeActive = !commentModeActive;
    commentModeButton.textContent = commentModeActive ? 'Comment: ON' : 'Comment';
    commentModeButton.style.background = commentModeActive ? 'rgba(255,122,0,0.95)' : '';
    map.getContainer().style.cursor = commentModeActive ? 'crosshair' : '';
    if(commentModeActive) toast('Comment mode ON: click map or crater to comment.');
  };

  map.on('click', e => {
    if(!commentModeActive) return;
    const { lat, lng } = e.latlng;
    // find nearest crater using turf if available
    let nearest = null, minKm = Infinity;
    Object.values(featureIndex).forEach(f => {
      try {
        if(window.turf && typeof turf.distance === 'function'){
          const d = turf.distance(turf.point([f.lon, f.lat]), turf.point([lng, lat]), { units:'kilometers' });
          if(d < minKm){ minKm = d; nearest = f; }
        } else {
          // degree-based fallback distance (approx)
          const ddeg = Math.hypot(f.lat - lat, f.lon - lng);
          if(ddeg < minKm){ minKm = ddeg; nearest = f; }
        }
      } catch(e){}
    });

    if(minKm !== Infinity && minKm <= CONFIG.COMMENT_NEARBY_KM && nearest){
      // open feature panel and focus comment box
      openFeature(nearest.id);
      commentModeActive = false; commentModeButton.textContent = 'Comment'; map.getContainer().style.cursor = '';
      return;
    }

    // else create popup to write free comment
    const popup = L.popup({ closeOnClick:false, autoClose:false, maxWidth:320 }).setLatLng([lat, lng]).setContent(`
      <div style="min-width:220px">
        <div style="font-weight:700;margin-bottom:6px">Map comment</div>
        <textarea id="pm_text" rows="3" style="width:100%;padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);border:none;color:#e8f4ff"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="pm_save" class="btn small">Save</button>
          <button id="pm_cancel" class="btn small ghost">Cancel</button>
        </div>
      </div>
    `).openOn(map);

    setTimeout(()=> {
      const bs = document.getElementById('pm_save'), bc = document.getElementById('pm_cancel'), ta = document.getElementById('pm_text');
      if(bs) bs.onclick = ()=> { const t = ta.value.trim(); if(!t){ toast('Type a comment'); return; } addFreeComment(lat, lng, t); map.closePopup(popup); commentModeActive=false; commentModeButton.textContent='Comment'; map.getContainer().style.cursor=''; };
      if(bc) bc.onclick = ()=> { map.closePopup(popup); commentModeActive=false; commentModeButton.textContent='Comment'; map.getContainer().style.cursor=''; };
      if(ta) ta.focus();
    }, 50);
  });
}

/* --------------- Feature panel & comments --------------- */
function openFeature(id){
  const f = featureIndex[id]; if(!f) return;
  const el = $('featureDetails'); if(!el) return;
  el.innerHTML = `
    <div class="popup-card">
      <h4>${escapeHtml(f.name)}</h4>
      <table class="details-table">
        <tr><td><b>ID</b></td><td>${escapeHtml(f.id)}</td></tr>
        <tr><td><b>Lat / Lon</b></td><td>${f.lat.toFixed(6)} / ${f.lon.toFixed(6)}</td></tr>
        <tr><td><b>Diameter</b></td><td>${formatDiameter(f.diameter_m)}</td></tr>
        <tr><td><b>PSR</b></td><td>${f.psr_overlap ? 'Yes' : 'No'}</td></tr>
        <tr><td><b>Spectral</b></td><td>${f.spectral_mean===null? '—': Number(f.spectral_mean).toFixed(3)}</td></tr>
        <tr><td><b>Hydrogen</b></td><td>${f.hydrogen_mean===null? '—' : Number(f.hydrogen_mean).toFixed(3)}</td></tr>
        <tr><td><b>Depth</b></td><td>${f.depth_metric===null? '—' : Number(f.depth_metric).toFixed(3)}</td></tr>
        <tr><td><b>Water score</b></td><td>${formatScore(f.water_score)}</td></tr>
      </table>

      <div style="margin-top:10px;display:flex;gap:8px">
        <button id="acceptBtn" class="btn">Accept as annotation</button>
        <button id="zoomBtn" class="btn ghost">Zoom to</button>
      </div>

      <div style="margin-top:12px">
        <label style="font-weight:700;margin-bottom:6px;display:block">Comments</label>
        <textarea id="commentText" rows="3" style="width:100%;padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);border:none;color:#e8f4ff" placeholder="Add a comment or observation..."></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="postComment" class="btn small">Post comment</button>
          <div class="muted" style="align-self:center">Comments are saved locally</div>
        </div>
        <div id="commentsList" style="margin-top:10px"></div>
      </div>
    </div>
  `;
  $('zoomBtn').onclick = ()=> map.setView([f.lat, f.lon], Math.max(4, map.getZoom()));
  $('acceptBtn').onclick = ()=> acceptFeatureAsAnnotation(f);
  $('postComment').onclick = ()=> { const txt = $('commentText').value.trim(); if(!txt){ toast('Type a comment'); return; } addCommentToFeature(f.id, txt); $('commentText').value=''; renderCommentsForFeature(f.id); };
  renderCommentsForFeature(f.id);
  // open popup for marker (if present)
  const m = markerMap[f.id]; if(m && m.openPopup) m.openPopup();
  highlightMarker(f.id);
}

function acceptFeatureAsAnnotation(f){
  const ann = { id: f.id, name: f.name, lat: f.lat, lon: f.lon, water_score: f.water_score, source:'feature', timestamp: new Date().toISOString(), comments: (commentsStore.featureComments[f.id] || []) };
  addAnnotation(ann);
}
function highlightMarker(id){
  try {
    Object.values(markerMap).forEach(m => m.setStyle({ weight:1.6 }));
    const m = markerMap[id];
    if(m){ m.setStyle({ weight:3, fillOpacity:0.95 }); setTimeout(()=> { if(markerMap[id]) markerMap[id].setStyle({ weight:1.6, fillOpacity:0.72 }); }, 2000); }
  } catch(e){ /* ignore */ }
}

/* --------------- Suggestions / UI / Search --------------- */
function wireUI(){
  const sBtn = $('searchBtn'); if(sBtn) sBtn.onclick = doSearch;
  const sug = $('suggestBtn'); if(sug) sug.onclick = showSuggestions;
  const exp = $('exportBtn'); if(exp) exp.onclick = exportAnnotations;
  const sI = $('searchInput'); if(sI) sI.addEventListener('keydown', e => { if(e.key==='Enter') doSearch(); } );

  // handle layer radios (warn for missing)
  document.querySelectorAll('input[name="layer"]').forEach(r => r.addEventListener('change', e => {
    if(e.target.value !== 'vis'){ toast('Layer not available — add tiles for IR/Elevation/Index to enable'); const vis = document.querySelector('input[name="layer"][value="vis"]'); if(vis) vis.checked=true; }
  }));

  // open permalink selection
  const pl = readPermalink();
  if(pl && pl.selectedId && featureIndex[pl.selectedId]) setTimeout(()=> openFeature(pl.selectedId), 600);
}

function doSearch(){
  const q = ($('searchInput') && $('searchInput').value || '').trim().toLowerCase();
  if(!q){ toast('Type a crater name or id'); return; }
  const exact = featureIndex[q];
  let found = exact || Object.values(featureIndex).find(f => f.name && f.name.toLowerCase().includes(q));
  if(!found){ toast('No match'); return; }
  openFeature(found.id);
  map.setView([found.lat, found.lon], Math.max(4, map.getZoom()));
  setPermalink(found.id);
}

function setPermalink(selectedId){
  const c = map.getCenter(); const z = map.getZoom();
  location.hash = [z, c.lat.toFixed(6), c.lng.toFixed(6), 'vis', selectedId || ''].join('/');
}
function readPermalink(){ if(!location.hash) return null; const parts = location.hash.replace('#','').split('/'); if(parts.length < 4) return null; return { z:+parts[0], lat:+parts[1], lon:+parts[2], layer:parts[3], selectedId: parts[4]||null }; }

/* --------------- Helper color/format --------------- */
function scoreToColor(s){
  if(s===null||s===undefined||isNaN(s)) return '#7f8c8d';
  const v = Math.max(0, Math.min(1, +s));
  const r = Math.round(255 * Math.min(1, Math.max(0, (v-0.5)*2)));
  const b = Math.round(255 * Math.min(1, Math.max(0, (0.5-v)*2)));
  const g = Math.round(255 * (1 - Math.abs(v-0.5)*2));
  return `rgb(${r},${g},${b})`;
}

/* End of file */

