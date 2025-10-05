/* app.js — EmbiggenEye (robust version)
 - Requires: index.html contains correct IDs:
   searchInput, searchBtn, suggestBtn, exportBtn, annotationsList, featureDetails, loader, toast, map
 - Requires: add <script src="https://unpkg.com/@turf/turf@6/turf.min.js"></script> BEFORE this script in index.html
 - Behavior:
   - Loads features parts and suggestions
   - Loads PSR geojson and uses turf.booleanPointInPolygon for psr_overlap
   - Computes/normalizes water_score with fallbacks
   - Marker clustering, stable markers at all zooms (uses CircleMarker)
   - Suggest accept -> annotation, can add comment, save in localStorage
   - Export annotations -> GeoJSON (includes comments)
*/

const TILE_URL = './tiles/layer_vis/{z}/{x}/{y}.png';
const FEATURE_PARTS = ['./features_part1.json','./features_part2.json','./features_part3.json'];
const SUGGESTIONS_URL = './suggestions.json';
const PSR_URL = './static/psr.geojson';
const FALLBACK_IMAGE = './static/fallback.png';

const DEFAULT_CENTER = [-88.0, 0.0];
const DEFAULT_ZOOM = 2;
const MIN_ZOOM = 0;
const MAX_ZOOM = 5; // five demo levels: 0..5

const LS_KEY = 'embiggen_annotations_v1';

function $(id){ return document.getElementById(id); }
function toast(msg, t=2500){ const el=$('toast'); if(!el) return console.log(msg); el.textContent=msg; el.classList.add('visible'); setTimeout(()=>el.classList.remove('visible'), t); }
function showLoader(txt='Loading...'){ const l=$('loader'); if(l){ l.style.display='block'; l.textContent=txt; } }
function hideLoader(){ const l=$('loader'); if(l) l.style.display='none'; }
async function safeJsonFetch(url){ const res = await fetch(url); if(!res.ok) throw new Error(`${url} -> ${res.status}`); return res.json(); }

function scoreToColor(s){
  if (s===null || s===undefined || isNaN(s)) return '#7f8c8d'; // gray for unknown
  const v = Math.max(0, Math.min(1, +s));
  const r = Math.round(255 * Math.min(1, Math.max(0, (v-0.5)*2)));
  const b = Math.round(255 * Math.min(1, Math.max(0, (0.5-v)*2)));
  const g = Math.round(255 * (1 - Math.abs(v-0.5)*2));
  return `rgb(${r},${g},${b})`;
}

/* Permalink handling */
function setPermalink(map, layerName, selectedId){
  const c = map.getCenter();
  const z = map.getZoom();
  location.hash = [z.toString(), c.lat.toFixed(6), c.lng.toFixed(6), layerName||'vis', selectedId||''].join('/');
}
function readPermalink(){
  if(!location.hash) return null;
  const parts = location.hash.replace('#','').split('/');
  if(parts.length < 4) return null;
  return { z: parseInt(parts[0],10), lat: parseFloat(parts[1]), lng: parseFloat(parts[2]), layer: parts[3], selectedId: parts[4]||null };
}

/* globals and layers */
let map;
let tileLayer = null;
let fallbackOverlay = null;
let clusterLayer;
let suggestionsLayer;
let featureIndex = {}; // id -> feature obj
let featureLayerMap = {}; // id -> marker
let annotations = []; // persisted local annotations
let PSR_GEOJSON = null;
window._SUGGESTIONS = null;

/* Init map and dataset loads */
async function init(){
  showLoader('Initializing map...');
  map = L.map('map', { preferCanvas:true, worldCopyJump:false, minZoom:MIN_ZOOM, maxZoom:MAX_ZOOM }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  // Defensive tile availability test
  let tilesAvailable = false;
  try {
    const testUrl = TILE_URL.replace('{z}','0').replace('{x}','0').replace('{y}','0');
    const r = await fetch(testUrl, { method:'HEAD' });
    if (r.ok) tilesAvailable = true;
    else {
      // try GET
      const r2 = await fetch(testUrl);
      tilesAvailable = r2.ok;
    }
  } catch(e){ tilesAvailable = false; }

  if(tilesAvailable){
    tileLayer = L.tileLayer(TILE_URL, { minZoom:MIN_ZOOM, maxZoom:MAX_ZOOM, errorTileUrl:'' });
    tileLayer.addTo(map);
  } else {
    // try fallback image
    try {
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = resolve; img.onerror = reject;
        img.src = FALLBACK_IMAGE;
      });
      const bounds = [[-180,-180],[180,180]];
      fallbackOverlay = L.imageOverlay(FALLBACK_IMAGE, bounds).addTo(map);
      map.fitBounds(bounds);
      toast('Tiles missing — using fallback image.');
    } catch(e) {
      // show a basic grey background rectangle to make markers visible
      const bounds = [[-180,-180],[180,180]];
      L.rectangle(bounds, { color:'#0b1726', weight:0, fillOpacity:1 }).addTo(map);
      map.fitBounds(bounds);
      toast('Tiles & fallback missing — map usable, markers visible.');
    }
  }

  clusterLayer = L.markerClusterGroup({ chunkedLoading:true, spiderfyOnMaxZoom:true });
  suggestionsLayer = L.layerGroup();
  map.addLayer(clusterLayer);
  map.addLayer(suggestionsLayer);

  // load PSR
  try {
    PSR_GEOJSON = await safeJsonFetch(PSR_URL);
    L.geoJSON(PSR_GEOJSON, { style:{ color:'#7fd', weight:1, fillOpacity:0.06 } }).addTo(map);
    console.log('PSR loaded.');
  } catch(e){
    console.warn('PSR not loaded:', e);
    PSR_GEOJSON = null;
  }

  // load features
  let features = [];
  for(const p of FEATURE_PARTS){
    try {
      const part = await safeJsonFetch(p);
      // Accept either FeatureCollection, array of Features, or plain array of objects with properties
      if (part.type === 'FeatureCollection' && Array.isArray(part.features)) features.push(...part.features);
      else if (Array.isArray(part)) features.push(...part);
      else console.warn('Unknown features part format:', p);
    } catch(e){
      console.warn('Feature part missing:', p, e);
    }
  }
  if(!features.length) toast('No features loaded — check features_part files.');
  indexAndRenderFeatures(features);

  // suggestions
  try {
    window._SUGGESTIONS = await safeJsonFetch(SUGGESTIONS_URL);
    console.log('Suggestions loaded:', window._SUGGESTIONS);
  } catch(e){
    window._SUGGESTIONS = null;
    console.warn('No suggestions file or failed to load.');
  }

  // load annotations from storage
  loadAnnotations();
  renderAnnotationsList();

  // wire UI actions
  wireUI();

  // apply permalink if present
  const pl = readPermalink();
  if(pl){
    try { map.setView([pl.lat, pl.lng], pl.z || DEFAULT_ZOOM); if(pl.selectedId) setTimeout(()=>openFeature(pl.selectedId),800); } catch(e){}
  }

  hideLoader();
  // compute water_score for any entries without it (fallbacks)
  normalizeAndComputeScores();
}

/* Load and render features */
function indexAndRenderFeatures(featuresArray){
  featureIndex = {};
  featureLayerMap = {};
  clusterLayer.clearLayers();

  for(const f of featuresArray){
    let props = null, geom = null;
    if(f.type === 'Feature' && f.properties){
      props = f.properties; geom = f.geometry;
    } else if (f.properties){
      props = f.properties; geom = f.geometry;
    } else {
      props = f; geom = null;
    }

    // resolve coords
    let lon = null, lat = null;
    if(geom && geom.type === 'Point' && Array.isArray(geom.coordinates)){
      [lon, lat] = geom.coordinates;
    } else if (props.lon !== undefined && props.lat !== undefined){
      lon = +props.lon; lat = +props.lat;
    } else if (props.LON && props.LAT){
      lon = +props.LON; lat = +props.LAT;
    } else {
      // skip feature without coordinates
      continue;
    }

    const id = props.id || props.CRATER_ID || props.name || (`f_${Object.keys(featureIndex).length+1}`);
    const diameter_m = (props.diameter_m || (props.diameter_km ? +props.diameter_km*1000 : null)) || null;
    const water_score = (props.water_score === null || props.water_score === undefined) ? null : +props.water_score;
    const spectral_mean = (props.spectral_mean === null || props.spectral_mean === undefined) ? null : +props.spectral_mean;
    const hydrogen_mean = (props.hydrogen_mean === null || props.hydrogen_mean === undefined) ? null : +props.hydrogen_mean;
    const depth_metric = (props.depth_metric === null || props.depth_metric === undefined) ? null : +props.depth_metric;
    const psr_overlap = !!props.psr_overlap || !!props.PSR || !!props.psr;

    // store
    const fo = { id, name: props.name||id, lon:+lon, lat:+lat, diameter_m, water_score, spectral_mean, hydrogen_mean, depth_metric, psr_overlap, raw:props };
    featureIndex[id] = fo;
  }

  // create markers
  Object.values(featureIndex).forEach(f => addFeatureMarker(f));
  toast(`Loaded ${Object.keys(featureIndex).length} features`);
}

function addFeatureMarker(f){
  const latlng = [f.lat, f.lon];
  // pixel-sized marker scaling: CircleMarker keeps pixel radius constant across zooms
  const baseRadius = f.diameter_m ? Math.max(6, Math.min(34, Math.log10(f.diameter_m + 1) * 3.5)) : 8;
  const color = scoreToColor(f.water_score);
  const marker = L.circleMarker(latlng, { radius: baseRadius, color, weight:1.6, fillOpacity:0.7 });
  marker.featureId = f.id;
  marker.on('click', ()=> {
    openFeature(f.id);
    setPermalink(map, 'vis', f.id);
  });
  marker.bindPopup(popupHtml(f), { maxWidth:320 });
  clusterLayer.addLayer(marker);
  featureLayerMap[f.id] = marker;
}

/* Popup html */
function nullable(v){ return (v===null||v===undefined)?'<span class="empty">N/A</span>': Number(v).toFixed(3); }
function popupHtml(f){
  return `<div class="popup-card">
    <h4>${escapeHtml(f.name)}</h4>
    <table class="popup-table">
      <tr><td><b>ID</b></td><td>${escapeHtml(f.id)}</td></tr>
      <tr><td><b>Lat/Lon</b></td><td>${f.lat.toFixed(6)} / ${f.lon.toFixed(6)}</td></tr>
      <tr><td><b>Diameter (m)</b></td><td>${f.diameter_m?Math.round(f.diameter_m):'N/A'}</td></tr>
      <tr><td><b>PSR</b></td><td>${f.psr_overlap? 'Yes' : 'No'}</td></tr>
      <tr><td><b>Spectral</b></td><td>${nullable(f.spectral_mean)}</td></tr>
      <tr><td><b>Hydrogen</b></td><td>${nullable(f.hydrogen_mean)}</td></tr>
      <tr><td><b>Depth metric</b></td><td>${nullable(f.depth_metric)}</td></tr>
      <tr><td><b>Water score</b></td><td>${(f.water_score===null||f.water_score===undefined)?'<span class="empty">N/A</span>':Number(f.water_score).toFixed(3)}</td></tr>
    </table>
  </div>`;
}
function escapeHtml(s){ if(!s && s!==0) return ''; return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

/* Open feature details in right panel and allow comments / accept annotation */
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
        <tr><td><b>Diameter (m)</b></td><td>${f.diameter_m?Math.round(f.diameter_m):'N/A'}</td></tr>
        <tr><td><b>PSR</b></td><td>${f.psr_overlap? 'Yes':'No'}</td></tr>
        <tr><td><b>Spectral mean</b></td><td>${nullable(f.spectral_mean)}</td></tr>
        <tr><td><b>Hydrogen mean</b></td><td>${nullable(f.hydrogen_mean)}</td></tr>
        <tr><td><b>Depth metric</b></td><td>${nullable(f.depth_metric)}</td></tr>
        <tr><td><b>Water score</b></td><td>${(f.water_score===null||f.water_score===undefined)?'<span class="empty">N/A</span>':Number(f.water_score).toFixed(3)}</td></tr>
      </table>

      <div style="margin-top:10px;display:flex;gap:8px">
        <button id="acceptBtn" class="btn">Accept as annotation</button>
        <button id="zoomBtn" class="btn ghost">Zoom to</button>
      </div>

      <div style="margin-top:12px">
        <label style="font-weight:700;margin-bottom:6px;display:block">Comments & discussion</label>
        <textarea id="commentText" rows="3" style="width:100%;padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);border:none;color:#e8f4ff"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="postComment" class="btn small">Post comment</button>
          <div class="muted" style="align-self:center">Comments saved locally</div>
        </div>
        <div id="commentsList" style="margin-top:8px"></div>
      </div>
    </div>
  `;

  // wire buttons
  $('zoomBtn').onclick = ()=> map.setView([f.lat,f.lon], Math.max(4, map.getZoom()));
  $('acceptBtn').onclick = ()=> acceptAnnotationFromFeature(f);
  $('postComment').onclick = ()=> {
    const txt = $('commentText').value.trim();
    if(!txt) { toast('Type a comment first'); return; }
    addCommentToFeature(f.id, txt);
    $('commentText').value = '';
    renderCommentsForFeature(f.id);
  };
  renderCommentsForFeature(f.id);
}

/* Comments storage: stored per feature id in localStorage under LS_KEY_comments */
function getCommentsStorageKey(){ return LS_KEY + '_comments'; }
function loadComments(){ try { return JSON.parse(localStorage.getItem(getCommentsStorageKey())||'{}'); } catch(e){ return {}; } }
function saveComments(obj){ localStorage.setItem(getCommentsStorageKey(), JSON.stringify(obj)); }
function addCommentToFeature(fid, text){
  const obj = loadComments();
  obj[fid] = obj[fid] || [];
  obj[fid].push({ text, ts: new Date().toISOString() });
  saveComments(obj);
  toast('Comment added (local only).');
}
function renderCommentsForFeature(fid){
  const list = loadComments()[fid] || [];
  const el = $('commentsList');
  if(!el) return;
  if(!list.length){ el.innerHTML = '<div class="muted">No comments yet</div>'; return; }
  el.innerHTML = list.map(c => `<div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.01);margin-bottom:6px"><div style="font-size:13px">${escapeHtml(c.text)}</div><div class="muted" style="font-size:12px;margin-top:6px">${new Date(c.ts).toLocaleString()}</div></div>`).join('');
}

/* Suggestions handling */
function showSuggestions(){
  suggestionsLayer.clearLayers();
  if(!window._SUGGESTIONS){
    toast('No suggestions available.');
    return;
  }
  const list = Array.isArray(window._SUGGESTIONS.suggestions) ? window._SUGGESTIONS.suggestions : (Array.isArray(window._SUGGESTIONS) ? window._SUGGESTIONS : []);
  if(!list.length){ toast('Suggestions file empty.'); return; }
  for(const s of list){
    const m = L.circleMarker([s.lat, s.lon], { radius:12, color:'#ff7a00', weight:2, fillOpacity:0.35 });
    m.bindPopup(`<b>${escapeHtml(s.name || s.id || 'candidate')}</b><br/>score: ${s.water_score===null?'N/A':Number(s.water_score).toFixed(3)}<br/><button class="accept-sugg btn small">Accept</button>`);
    m.on('popupopen', e => {
      setTimeout(()=> {
        const el = e.popup.getElement();
        if(!el) return;
        const btn = el.querySelector('.accept-sugg');
        if(btn) btn.onclick = ()=> {
          acceptAnnotationFromSuggestion(s);
          e.popup.remove();
        };
      }, 40);
    });
    suggestionsLayer.addLayer(m);
  }
  toast(`Showing ${list.length} suggestions. Accept to annotate.`);
}

/* Accept flows */
function acceptAnnotationFromSuggestion(s){
  const ann = {
    id: s.id || `cand_${Date.now()}`,
    name: s.name || s.id || 'candidate',
    lat: +s.lat,
    lon: +s.lon,
    water_score: s.water_score===undefined?null:s.water_score,
    source:'suggestion',
    timestamp: new Date().toISOString(),
    comments: []
  };
  addAnnotation(ann);
}
function acceptAnnotationFromFeature(f){
  const ann = {
    id: f.id,
    name: f.name,
    lat: f.lat,
    lon: f.lon,
    water_score: f.water_score===undefined?null:f.water_score,
    source:'feature',
    timestamp: new Date().toISOString(),
    comments: loadComments()[f.id] || []
  };
  addAnnotation(ann);
}

/* Annotations management */
function loadAnnotations(){
  try { annotations = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch(e){ annotations = []; }
}
function saveAnnotations(){ localStorage.setItem(LS_KEY, JSON.stringify(annotations)); renderAnnotationsList(); }
function addAnnotation(a){
  if(annotations.find(x=> x.id === a.id)){ toast('Annotation already saved'); return; }
  annotations.push(a); saveAnnotations(); toast('Annotation saved (local).'); renderAnnotationsList();
}
function deleteAnnotation(id){
  annotations = annotations.filter(a=> a.id !== id); saveAnnotations(); toast('Annotation removed'); }

/* Render annotation list */
function renderAnnotationsList(){
  const el = $('annotationsList');
  if(!el) return;
  if(!annotations.length){ el.innerHTML = '<div class="muted">None yet</div>'; return; }
  el.innerHTML = annotations.map(a => {
    return `<div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-weight:700">${escapeHtml(a.name)}</div>
          <div class="muted" style="font-size:12px">${a.lat? a.lat.toFixed(4):''}, ${a.lon? a.lon.toFixed(4):''} • ${a.water_score===null?'N/A':Number(a.water_score).toFixed(3)}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn small" data-act="zoom" data-id="${escapeHtml(a.id)}">Zoom</button>
          <button class="btn small ghost" data-act="del" data-id="${escapeHtml(a.id)}">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
  // wire buttons
  el.querySelectorAll('button[data-act]').forEach(b=>{
    const act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    b.onclick = ()=> {
      if(act==='zoom'){ const a = annotations.find(x=> x.id===id); if(a && a.lat && a.lon) map.setView([a.lat,a.lon], Math.max(4,map.getZoom())); }
      if(act==='del'){ deleteAnnotation(id); }
    };
  });
}

/* Export annotations as GeoJSON (includes comments) */
function exportAnnotations(){
  if(!annotations.length){ toast('No annotations to export.'); return; }
  const features = annotations.map(a => ({
    type:'Feature',
    properties: { id: a.id, name:a.name, water_score: a.water_score, source: a.source, timestamp: a.timestamp, comments: a.comments||[] },
    geometry: { type:'Point', coordinates: [a.lon, a.lat] }
  }));
  const fc = { type:'FeatureCollection', features };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type:'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'annotations.geojson'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('Exported annotations.geojson');
}

/* Search */
function doSearch(){
  const q = ($('searchInput') && $('searchInput').value || '').trim().toLowerCase();
  if(!q){ toast('Enter crater name or id to search'); return; }
  let found = featureIndex[q] || Object.values(featureIndex).find(f => f.name && f.name.toLowerCase().includes(q));
  if(!found){ toast('No match'); return; }
  openFeature(found.id);
  map.setView([found.lat, found.lon], Math.max(4, map.getZoom()));
  setPermalink(map, 'vis', found.id);
}

/* Compute PSR overlap using Turf if available, otherwise bbox fallback */
function checkPSROverlapForFeature(f){
  if(!PSR_GEOJSON) return false;
  try {
    if(window.turf && typeof window.turf.booleanPointInPolygon === 'function'){
      const pt = turf.point([f.lon, f.lat]);
      for(const feat of PSR_GEOJSON.features || []){
        if(turf.booleanPointInPolygon(pt, feat)) return true;
      }
      return false;
    } else {
      // fallback: bounding box check (less accurate)
      const ptlon = f.lon, ptlat = f.lat;
      for(const feat of PSR_GEOJSON.features || []){
        if(!feat.bbox && feat.geometry){
          const coords = feat.geometry.coordinates.flat(Infinity);
          // derive a bbox
          const xs = [], ys = [];
          const iter = (arr) => {
            if(typeof arr[0] === 'number'){ xs.push(arr[0]); ys.push(arr[1]); return; }
            for(const el of arr) iter(el);
          };
          iter(feat.geometry.coordinates);
          const minx = Math.min(...xs), maxx=Math.max(...xs), miny=Math.min(...ys), maxy=Math.max(...ys);
          if(ptlon >= minx && ptlon <= maxx && ptlat >= miny && ptlat <= maxy) return true;
        } else if (feat.bbox) {
          const [minx,miny,maxx,maxy] = feat.bbox;
          if(ptlon >= minx && ptlon <= maxx && ptlat >= miny && ptlat <= maxy) return true;
        }
      }
      return false;
    }
  } catch(e){
    console.warn('PSR check failed:', e);
    return false;
  }
}

/* Normalize & compute fallback water_score for features that lack it */
function normalizeAndComputeScores(){
  const arr = Object.values(featureIndex);
  if(!arr.length) return;

  // compute ranges for numeric components
  const specVals = arr.map(f => f.spectral_mean).filter(v=>v!==null && v!==undefined);
  const hydroVals = arr.map(f => f.hydrogen_mean).filter(v=>v!==null && v!==undefined);
  const depthVals = arr.map(f => f.depth_metric).filter(v=>v!==null && v!==undefined);
  const diamVals = arr.map(f => f.diameter_m).filter(v=>v!==null && v!==undefined);

  const specMin = specVals.length?Math.min(...specVals):0, specMax = specVals.length?Math.max(...specVals):1;
  const hydroMin = hydroVals.length?Math.min(...hydroVals):0, hydroMax = hydroVals.length?Math.max(...hydroVals):1;
  const depthMin = depthVals.length?Math.min(...depthVals):0, depthMax = depthVals.length?Math.max(...depthVals):1;
  const diamMin = diamVals.length?Math.min(...diamVals):0, diamMax = diamVals.length?Math.max(...diamVals):1;

  for(const f of arr){
    // ensure psr_overlap is accurate: recompute using PSR if data present and not already true
    if(PSR_GEOJSON) {
      try { f.psr_overlap = checkPSROverlapForFeature(f); } catch(e){ /* ignore */ }
    }

    if(f.water_score === null || f.water_score === undefined){
      // compute component scores with available components
      const components = [];
      // psr
      components.push({k:'psr', avail:true, val: f.psr_overlap?1:0, w:0.4});
      // spectral
      if(f.spectral_mean !== null && f.spectral_mean !== undefined){
        const v = (f.spectral_mean - specMin) / (specMax - specMin + 1e-12);
        components.push({k:'spec', avail:true, val:v, w:0.35});
      } else { components.push({k:'spec', avail:false, val:0, w:0.35}); }
      // hydrogen
      if(f.hydrogen_mean !== null && f.hydrogen_mean !== undefined){
        const v = (f.hydrogen_mean - hydroMin) / (hydroMax - hydroMin + 1e-12);
        components.push({k:'hydro', avail:true, val:v, w:0.2});
      } else { components.push({k:'hydro', avail:false, val:0, w:0.2}); }
      // depth
      if(f.depth_metric !== null && f.depth_metric !== undefined){
        const v = (f.depth_metric - depthMin) / (depthMax - depthMin + 1e-12);
        components.push({k:'depth', avail:true, val:v, w:0.05});
      } else { components.push({k:'depth', avail:false, val:0, w:0.05}); }

      // Rebalance weights to only available comps (psr always avail)
      let totalW = 0;
      components.forEach(c => { if(c.avail || c.k==='psr') totalW += c.w; else c.w = 0; });
      if(totalW <= 0) { f.water_score = null; continue; }
      components.forEach(c => c.w = c.w / totalW);

      const score = components.reduce((s,c) => s + (c.val * c.w), 0);
      f.water_score = Number(score.toFixed(4));

      // update marker color if exists
      const layer = featureLayerMap[f.id];
      if(layer) layer.setStyle({ color: scoreToColor(f.water_score) });
    }
  }
}

/* Wire UI controls */
function wireUI(){
  const si = $('searchInput'), sb = $('searchBtn'), sug = $('suggestBtn'), exp = $('exportBtn'), help = $('helpBtn');
  if(sb) sb.onclick = doSearch;
  if(si) si.addEventListener('keydown', (e)=> { if(e.key==='Enter') doSearch(); });
  if(sug) sug.onclick = showSuggestions;
  if(exp) exp.onclick = exportAnnotations;
  if(help) help.onclick = ()=> {
    alert('Tips:\\n- Click a crater to view details.\\n- Use Suggest to show precomputed candidates.\\n- Accept to annotate.\\n- Export saves all local annotations as GeoJSON.');
  };

  // layer toggles (we only have vis tiles now)
  document.querySelectorAll('input[name="layer"]').forEach(r => r.addEventListener('change', e => {
    const v = e.target.value;
    if(v !== 'vis') {
      toast('Layer not available. Add tiles for that layer to enable.');
      // reset to vis
      const visRadio = document.querySelector('input[name="layer"][value="vis"]');
      if(visRadio) visRadio.checked = true;
      return;
    }
  }));

  // update permalink on moveend (debounced)
  let timer = null;
  map.on('moveend', ()=> {
    if(timer) clearTimeout(timer);
    timer = setTimeout(()=> setPermalink(map, 'vis', null), 400);
  });
}

/* Export annotations helper reused above */
function exportAnnotations(){ /* defined earlier inside file scope? ensure wrapper available */
  // Use the same implementation as add/export above
  if(!annotations.length){ toast('No annotations to export.'); return; }
  const features = annotations.map(a => ({
    type:'Feature',
    properties: { id: a.id, name:a.name, water_score: a.water_score, source:a.source, timestamp:a.timestamp, comments: a.comments || [] },
    geometry: { type:'Point', coordinates:[a.lon, a.lat] }
  }));
  const fc = { type:'FeatureCollection', features };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type:'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'annotations.geojson'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('Exported annotations.geojson');
}

/* addAnnotation, deleteAnnotation, renderAnnotationsList defined earlier in file — ensure they exist */
function addAnnotation(a){
  if(annotations.find(x=> x.id === a.id)){ toast('Annotation already exists'); return; }
  annotations.push(a); localStorage.setItem(LS_KEY, JSON.stringify(annotations)); renderAnnotationsList(); toast('Annotation saved');
}
function deleteAnnotation(id){ annotations = annotations.filter(x=> x.id !== id); localStorage.setItem(LS_KEY, JSON.stringify(annotations)); renderAnnotationsList(); }
function renderAnnotationsList(){
  const el = $('annotationsList');
  if(!el) return;
  if(!annotations.length){ el.innerHTML = '<div class="muted">None yet</div>'; return; }
  el.innerHTML = annotations.map(a => {
    return `<div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><div style="font-weight:700">${escapeHtml(a.name)}</div><div class="muted" style="font-size:12px">${a.lat? a.lat.toFixed(4):''}, ${a.lon? a.lon.toFixed(4):''} • ${a.water_score===null?'N/A':Number(a.water_score).toFixed(3)}</div></div>
        <div style="display:flex;gap:6px">
          <button class="btn small" data-act="zoom" data-id="${escapeHtml(a.id)}">Zoom</button>
          <button class="btn small ghost" data-act="del" data-id="${escapeHtml(a.id)}">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('button[data-act]').forEach(b=>{
    const act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    b.onclick = ()=> { if(act==='zoom'){ const a = annotations.find(x=> x.id===id); if(a && a.lat && a.lon) map.setView([a.lat,a.lon], Math.max(4,map.getZoom())); } if(act==='del'){ deleteAnnotation(id); } };
  });
}

/* helper escape */
function escapeHtml(s){ if(!s && s!==0) return ''; return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

/* Search implementation */
function doSearch(){
  const q = ($('searchInput') && $('searchInput').value || '').trim().toLowerCase();
  if(!q){ toast('Type a crater name or id'); return; }
  let found = featureIndex[q] || Object.values(featureIndex).find(f => f.name && f.name.toLowerCase().includes(q));
  if(!found){ toast('No match'); return; }
  openFeature(found.id);
  map.setView([found.lat, found.lon], Math.max(4, map.getZoom()));
  setPermalink(map, 'vis', found.id);
}

/* Init sequence */
document.addEventListener('DOMContentLoaded', async ()=>{
  // load annotations from storage
  try { annotations = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch(e){ annotations = []; }
  await init();
  renderAnnotationsList();
});
