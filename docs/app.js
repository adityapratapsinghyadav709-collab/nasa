/*
  app.js — EmbiggenEye frontend logic
  - Loads feature parts, suggestions, PSR overlay
  - Uses visible tiles (./tiles/layer_vis/{z}/{x}/{y}.png). If missing, uses fallback image (./static/fallback.png) or plain empty map.
  - Renders crater overlay as clustered circle markers, color-coded by water_score (if available).
  - Search by name or id, Suggest button (shows precomputed suggestions), Accept -> annotation saved to localStorage and exportable to GeoJSON.
  - Permalink support via URL hash: #z/lat/lng/layer/selectedId  (example: #4/-89.5/0.5/vis/00-1-000018)
  - Robust error handling and graceful fallbacks.
*/

/* ------------- Configuration ------------- */
// Paths (relative to docs/)
const TILE_URL = './tiles/layer_vis/{z}/{x}/{y}.png';
const FEATURE_PARTS = ['./features_part1.json', './features_part2.json', './features_part3.json']; // adjust if you have different names
const SUGGESTIONS_URL = './suggestions.json';
const PSR_URL = './static/psr.geojson';
const FALLBACK_IMAGE = './static/fallback.png'; // optional

// Map initial view (if no permalink)
const DEFAULT_CENTER = [ -88.0, 0.0 ]; // lat, lon (approx southern lat)
const DEFAULT_ZOOM = 2;
const MIN_ZOOM = 0;
const MAX_ZOOM = 6;

// Local storage key
const LS_KEY = 'embiggen_annotations_v1';

// UI selectors (from index.html)
const SEARCH_INPUT_ID = 'searchInput';
const SEARCH_BTN_ID = 'searchBtn';
const SUGGEST_BTN_ID = 'suggestBtn';
const EXPORT_BTN_ID = 'exportBtn';
const ANNS_LIST_ID = 'annotationsList';
const FEATURE_DETAILS_ID = 'featureDetails';
const LOADER_ID = 'loader';
const TOAST_ID = 'toast';

/* ------------- Utility functions ------------- */
function $(id) { return document.getElementById(id); }
function toast(msg, timeout=2400) {
  const el = $(TOAST_ID);
  if (!el) return console.log('Toast:', msg);
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(()=> el.classList.remove('visible'), timeout);
}
function showLoader(text='Loading…') { const l=$(LOADER_ID); if(l){ l.style.display='block'; l.textContent=text; } }
function hideLoader(){ const l=$(LOADER_ID); if(l){ l.style.display='none'; } }
function safeJsonFetch(url) {
  return fetch(url).then(r => {
    if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
    return r.json();
  });
}

/* ------------- Color scale for water_score (0..1) ------------- */
function scoreToColor(s) {
  if (s === null || s === undefined || isNaN(s)) return '#888'; // unknown -> gray
  const v = Math.max(0, Math.min(1, +s));
  // blue -> yellow -> red
  const r = Math.round(255 * Math.min(1, Math.max(0, (v - 0.5) * 2)));
  const b = Math.round(255 * Math.min(1, Math.max(0, (0.5 - v) * 2)));
  const g = Math.round(255 * (1 - Math.abs(v - 0.5) * 2));
  return `rgb(${r},${g},${b})`;
}

/* ------------- Permalink helpers -------------
Hash format: #z/lat/lng/layer/selectedId
example: #4/-89.45/0.5/vis/00-1-000018
--------------------------------------------*/
function setPermalink(map, layerName, selectedId) {
  const c = map.getCenter();
  const z = map.getZoom();
  const parts = [z.toString(), c.lat.toFixed(6), c.lng.toFixed(6), layerName || 'vis', selectedId || ''];
  location.hash = parts.join('/');
}
function readPermalink() {
  if (!location.hash) return null;
  const raw = location.hash.replace(/^#/, '');
  const parts = raw.split('/');
  if (parts.length < 4) return null;
  const [z, lat, lng, layer, sel] = parts;
  return { z: parseInt(z,10), lat: parseFloat(lat), lng: parseFloat(lng), layer, selectedId: sel || null };
}

/* ------------- Map & layers ------------- */
let map;
let baseTileLayer = null;
let fallbackImageOverlay = null;
let currentLayerName = 'vis';

// marker management
let clusterLayer; // L.markerClusterGroup()
let featureIndex = {}; // id -> feature object
let featureLayerMap = {}; // id -> circle/marker layer
let suggestionsLayerGroup = L.layerGroup();
let annotations = []; // accepted suggestions (objects saved to localStorage)

/* ------------- Load & init ------------- */
async function init() {
  showLoader('Initialising map…');

  // create map (use EPSG:4326 geographic coords)
  map = L.map('map', { preferCanvas: true, worldCopyJump: false, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  // detect permalink and set view later after tile test
  const permalink = readPermalink();

  // try to load a sample tile (z0/x0/y0) to check if tiles exist
  const testTileUrl = TILE_URL.replace('{z}','0').replace('{x}','0').replace('{y}','0');

  let tileAvailable = false;
  try {
    // Use HEAD to check small; some servers disallow HEAD => fallback to GET of image as blob
    const res = await fetch(testTileUrl, { method: 'HEAD' });
    if (res.ok) tileAvailable = true;
    else {
      // try GET but only check content-type
      const r2 = await fetch(testTileUrl, { method: 'GET' });
      if (r2.ok) tileAvailable = true;
    }
  } catch (e) {
    tileAvailable = false;
  }

  try {
    if (tileAvailable) {
      baseTileLayer = L.tileLayer(TILE_URL, { maxZoom: MAX_ZOOM, minZoom: MIN_ZOOM, noWrap: true, errorTileUrl: '' });
      baseTileLayer.addTo(map);
    } else {
      // tiles missing: try fallback image
      try {
        // attempt to load fallback image by creating Image
        await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => reject();
          img.src = FALLBACK_IMAGE;
        });
        // fallback bounds: we don't know real bounds; choose reasonable square and allow zoom
        const imgBounds = [[-180, -180], [180, 180]];
        fallbackImageOverlay = L.imageOverlay(FALLBACK_IMAGE, imgBounds).addTo(map);
        map.fitBounds(imgBounds);
        toast('Tiles not found — using fallback image.');
      } catch (err) {
        // No tiles, no fallback - create a simple OSM-like gray background using a rectangle
        const bounds = [[-180,-180],[180,180]];
        const bg = L.rectangle(bounds, { color: '#111', weight: 0, fillOpacity: 1 }).addTo(map);
        map.fitBounds(bounds);
        toast('Tiles & fallback missing — map initialized with empty background.');
      }
    }
  } catch (err) {
    console.warn('Tile init error', err);
    toast('Failed to init base layer — proceeding.');
  }

  // marker cluster
  clusterLayer = L.markerClusterGroup({ chunkedLoading: true, spiderfyOnMaxZoom: true });
  map.addLayer(clusterLayer);

  // add suggestions layer group (separate so we can clear)
  map.addLayer(suggestionsLayerGroup);

  // add PSR overlay if present
  try {
    await loadPSR();
    // PSR loaded and added
  } catch (e) {
    console.warn('PSR load failed:', e);
  }

  // load features (multiple parts)
  try {
    const features = await loadFeatureParts(FEATURE_PARTS);
    indexAndRenderFeatures(features);
  } catch (e) {
    console.error('Failed to load features:', e);
    toast('Could not load features.json — check console.');
  }

  // load suggestions but don't show until user clicks Suggest
  try {
    window._SUGGESTIONS = await safeJsonFetch(SUGGESTIONS_URL);
  } catch (e) {
    window._SUGGESTIONS = null;
    console.warn('No suggestions.json found or failed to load.', e);
  }

  // load annotations from localStorage
  loadAnnotationsFromStorage();
  renderAnnotationsList();

  // wire UI
  wireUI();

  // if permalink exists, set view
  if (permalink) {
    try {
      map.setView([permalink.lat, permalink.lng], permalink.z || DEFAULT_ZOOM);
      currentLayerName = permalink.layer || 'vis';
      if (permalink.selectedId) setTimeout(()=> { openFeature(permalink.selectedId); }, 800);
    } catch (e) { /* ignore */ }
  }

  hideLoader();
}

/* ------------- Load PSR ------------- */
async function loadPSR() {
  try {
    const data = await safeJsonFetch(PSR_URL);
    const psrLayer = L.geoJSON(data, {
      style: { color: '#9ee', fillOpacity: 0.06, weight: 1 }
    }).addTo(map);
    // add to layer control if needed - index.html uses simple radios; we won't wire them for PSR now
    return psrLayer;
  } catch (e) {
    throw e;
  }
}

/* ------------- Load feature parts & merge ------------- */
async function loadFeatureParts(parts) {
  showLoader('Loading features…');
  const results = [];
  for (const url of parts) {
    try {
      const p = await safeJsonFetch(url);
      // p may be array (GeoJSON FeatureCollection features or plain array)
      if (Array.isArray(p)) {
        // check if features in FeatureCollection or array of Features
        if (p.length && p[0].type === 'FeatureCollection' && Array.isArray(p[0].features)) {
          // weird packaging: wrap
          p[0].features.forEach(f=>results.push(f));
        } else {
          p.forEach(f => results.push(f));
        }
      } else if (p && p.type === 'FeatureCollection' && Array.isArray(p.features)) {
        p.features.forEach(f => results.push(f));
      } else {
        console.warn('Unknown features part format for', url);
      }
    } catch (e) {
      console.warn('Failed to load feature part', url, e);
      // continue - allow missing parts
    }
  }
  hideLoader();
  return results;
}

/* ------------- Index & render features ------------- */
function indexAndRenderFeatures(featuresArray) {
  // featuresArray elements might be GeoJSON Feature with properties and geometry
  featureIndex = {};
  featureLayerMap = {};
  clusterLayer.clearLayers();

  const added = [];
  for (const f of featuresArray) {
    let props = f;
    let geom = null;
    if (f.type === 'Feature' && f.properties) {
      props = f.properties;
      geom = f.geometry;
    } else if (f.properties) {
      props = f.properties;
      geom = f.geometry;
    }

    if (!props) continue;
    // try to resolve lon/lat from props or geometry
    let lon = null, lat = null;
    if (geom && geom.type === 'Point' && Array.isArray(geom.coordinates)) {
      [lon, lat] = geom.coordinates;
    } else if (typeof props.lon !== 'undefined' && typeof props.lat !== 'undefined') {
      lon = +props.lon; lat = +props.lat;
    } else if (props.LON && props.LAT) {
      lon = +props.LON; lat = +props.LAT;
    } else {
      // skip if no coords
      continue;
    }

    const id = props.id || props.CRATER_ID || props.name || (`feat_${Object.keys(featureIndex).length+1}`);
    // normalize numeric fields
    const diameter_m = (props.diameter_m || props.diameter_km && +props.diameter_km*1000 || props.DIAMETER && +props.DIAMETER) || null;
    const water_score = (props.water_score === null || typeof props.water_score === 'undefined') ? null : +props.water_score;
    const spectral_mean = (props.spectral_mean === null || typeof props.spectral_mean === 'undefined') ? null : +props.spectral_mean;
    const hydrogen_mean = (props.hydrogen_mean === null || typeof props.hydrogen_mean === 'undefined') ? null : +props.hydrogen_mean;
    const depth_metric = (props.depth_metric === null || typeof props.depth_metric === 'undefined') ? null : +props.depth_metric;
    const psr_overlap = !!props.psr_overlap || !!props.PSR || !!props.psr;

    const featureObj = {
      id, name: props.name || id, lon: +lon, lat: +lat, diameter_m, water_score,
      spectral_mean, hydrogen_mean, depth_metric, psr_overlap,
      raw: props
    };
    featureIndex[id] = featureObj;
    added.push(featureObj);
  }

  // sort? not necessary
  // render markers
  for (const id in featureIndex) {
    const f = featureIndex[id];
    addFeatureMarker(f);
  }

  toast(`Loaded ${Object.keys(featureIndex).length} features`);
}

/* ------------- create marker for feature ------------- */
function addFeatureMarker(f) {
  // marker position
  const latlng = [f.lat, f.lon];
  const ws = (f.water_score === null || f.water_score === undefined) ? null : +f.water_score;
  const color = scoreToColor(ws);
  // radius scale: if diameter_m present, scale nicely, else fixed
  const radius = f.diameter_m ? Math.max(6, Math.min(40, Math.log10(f.diameter_m+1) * 4)) : 8;

  // circle marker (using CircleMarker to keep constant pixel radius regardless of zoom - better for clustering)
  const marker = L.circleMarker(latlng, { radius, color, weight: 1.6, fillOpacity: 0.6 });
  marker.featureId = f.id;

  const popupHtml = renderPopupHtml(f);
  marker.bindPopup(popupHtml, { maxWidth: 320, minWidth: 220 });

  marker.on('click', (e) => {
    openFeature(f.id);
    // update permalink (selected)
    setPermalink(map, currentLayerName, f.id);
  });

  clusterLayer.addLayer(marker);
  featureLayerMap[f.id] = marker;
}

/* ------------- popup / details rendering ------------- */
function renderPopupHtml(f) {
  const ws = (f.water_score === null || f.water_score === undefined) ? 'N/A' : (''+Number(f.water_score).toFixed(3));
  const html = `
    <div class="popup-card">
      <h4>${escapeHtml(f.name)}</h4>
      <table class="popup-table">
        <tr><td><b>id</b></td><td>${escapeHtml(f.id)}</td></tr>
        <tr><td><b>water_score</b></td><td>${ws}</td></tr>
        <tr><td><b>PSR overlap</b></td><td>${f.psr_overlap ? 'yes' : 'no'}</td></tr>
        <tr><td><b>spectral_mean</b></td><td>${nullableNum(f.spectral_mean)}</td></tr>
        <tr><td><b>hydrogen_mean</b></td><td>${nullableNum(f.hydrogen_mean)}</td></tr>
        <tr><td><b>depth_metric</b></td><td>${nullableNum(f.depth_metric)}</td></tr>
      </table>
    </div>
  `;
  return html;
}
function nullableNum(v) { return (v===null||v===undefined) ? '<span class="empty">N/A</span>' : (''+Number(v)); }
function escapeHtml(s) { if (!s && s!==0) return ''; return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

/* ------------- open feature (show details in right panel and popup on map) ------------- */
function openFeature(id) {
  const f = featureIndex[id];
  if (!f) {
    console.warn('openFeature: unknown id', id);
    return;
  }
  // open popup if layer exists
  const layer = featureLayerMap[id];
  if (layer) {
    layer.openPopup();
    map.setView([f.lat, f.lon], Math.max(3, map.getZoom()));
  }
  // render right-panel details
  const el = $(FEATURE_DETAILS_ID);
  if (!el) return;
  el.innerHTML = `
    <div class="card popup-card">
      <h4>${escapeHtml(f.name)}</h4>
      <table class="popup-table">
        <tr><td><b>ID</b></td><td>${escapeHtml(f.id)}</td></tr>
        <tr><td><b>Lat / Lon</b></td><td>${f.lat.toFixed(6)} / ${f.lon.toFixed(6)}</td></tr>
        <tr><td><b>Diameter (m)</b></td><td>${f.diameter_m ? Math.round(f.diameter_m) : 'N/A'}</td></tr>
        <tr><td><b>Water score</b></td><td>${(f.water_score===null||f.water_score===undefined) ? 'N/A' : Number(f.water_score).toFixed(3)}</td></tr>
        <tr><td><b>PSR</b></td><td>${f.psr_overlap ? 'Yes' : 'No'}</td></tr>
        <tr><td><b>Spectral</b></td><td>${nullableNum(f.spectral_mean)}</td></tr>
        <tr><td><b>Hydrogen</b></td><td>${nullableNum(f.hydrogen_mean)}</td></tr>
        <tr><td><b>Depth metric</b></td><td>${nullableNum(f.depth_metric)}</td></tr>
      </table>
      <div style="margin-top:8px;display:flex;gap:8px;">
        <button id="acceptBtn" class="btn">Accept as Annotation</button>
        <button id="zoomBtn" class="btn ghost">Zoom to</button>
      </div>
    </div>
  `;
  // wire accept & zoom
  const acceptBtn = document.getElementById('acceptBtn');
  if (acceptBtn) acceptBtn.onclick = ()=> { acceptAnnotation(f); };
  const zoomBtn = document.getElementById('zoomBtn');
  if (zoomBtn) zoomBtn.onclick = ()=> { map.setView([f.lat,f.lon], Math.max(4, map.getZoom())); };
}

/* ------------- Suggestion handling ------------- */
function showSuggestions() {
  if (!window._SUGGESTIONS) {
    toast('No suggestions.json found.');
    return;
  }
  suggestionsLayerGroup.clearLayers();

  const list = (Array.isArray(window._SUGGESTIONS.suggestions) ? window._SUGGESTIONS.suggestions : (Array.isArray(window._SUGGESTIONS) ? window._SUGGESTIONS : []));
  if (!list.length) {
    toast('Suggestions file empty.');
    return;
  }

  for (const s of list) {
    const latlng = [s.lat, s.lon];
    const marker = L.circleMarker(latlng, { radius: 12, color: '#ff7a00', fillOpacity: 0.35, weight: 2 });
    marker.bindPopup(`<b>${escapeHtml(s.name || s.id || 'candidate')}</b><br/>water_score: ${s.water_score===null? 'N/A': Number(s.water_score).toFixed(3)}<br/><button class="btn accept-sugg">Accept</button>`);
    marker.on('popupopen', (e)=> {
      // attempt to wire the Accept button; popup content is auto-inserted into DOM - need to query it
      setTimeout(()=> {
        const popupEl = e.popup.getElement();
        if (!popupEl) return;
        const btn = popupEl.querySelector('.accept-sugg');
        if (btn) btn.onclick = () => {
          acceptAnnotation(s);
          e.popup.remove();
        };
      }, 20);
    });
    // animate visually by adding pulse class to underlying element after add
    suggestionsLayerGroup.addLayer(marker);
  }
  toast(`Showing ${list.length} suggestions — click marker and Accept to add annotation.`);
}

/* ------------- Accept annotation (save to localStorage) ------------- */
function acceptAnnotation(obj) {
  // Normalize stored annotation object with lat/lon and id/name/water_score and timestamp
  const annotation = {
    id: obj.id || (obj.name ? obj.name.replace(/\s+/g,'_') : `ann_${Date.now()}`),
    name: obj.name || obj.id || 'candidate',
    lon: (obj.lon !== undefined ? +obj.lon : (obj.longitude || obj.lng || null)),
    lat: (obj.lat !== undefined ? +obj.lat : (obj.latitude || obj.lat || null)),
    water_score: (obj.water_score !== undefined ? obj.water_score : (obj.water_score === null ? null : obj.water_score)),
    source: obj.source_props || obj.raw || null,
    timestamp: new Date().toISOString()
  };
  // append if not duplicate id
  const existing = annotations.find(a => a.id === annotation.id);
  if (existing) {
    toast('Annotation already exists (id match).');
    return;
  }
  annotations.push(annotation);
  saveAnnotationsToStorage();
  renderAnnotationsList();
  toast('Annotation saved locally.');
}

/* ------------- Annotations persistence ------------- */
function loadAnnotationsFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) { annotations = []; return; }
    annotations = JSON.parse(raw) || [];
  } catch (e) { annotations = []; console.warn('Failed to parse annotations from localStorage', e); }
}
function saveAnnotationsToStorage() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(annotations));
  } catch (e) { console.warn('Failed to save annotations', e); }
}

/* ------------- render annotations in left panel ------------- */
function renderAnnotationsList() {
  const el = $(ANNS_LIST_ID);
  if (!el) return;
  if (!annotations.length) { el.innerHTML = 'None yet'; return; }
  // show list with small controls
  const rows = annotations.map(a => {
    return `<div style="padding:6px 4px;border-bottom:1px solid rgba(255,255,255,0.02);display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:700">${escapeHtml(a.name)}</div>
        <div style="font-size:12px;color:#9fb">${a.lat ? a.lat.toFixed(4):''}, ${a.lon ? a.lon.toFixed(4):''} • ${a.water_score===null?'N/A':Number(a.water_score).toFixed(3)}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn ghost" data-action="zoom" data-id="${escapeHtml(a.id)}">Zoom</button>
        <button class="btn ghost" data-action="delete" data-id="${escapeHtml(a.id)}">Delete</button>
      </div>
    </div>`;
  }).join('');
  el.innerHTML = rows;
  // wire buttons
  el.querySelectorAll('button[data-action]').forEach(btn => {
    const act = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    btn.onclick = () => {
      if (act === 'zoom') {
        const ann = annotations.find(x => x.id === id);
        if (ann && ann.lat && ann.lon) map.setView([ann.lat, ann.lon], Math.max(4, map.getZoom()));
      } else if (act === 'delete') {
        annotations = annotations.filter(x => x.id !== id);
        saveAnnotationsToStorage();
        renderAnnotationsList();
      }
    };
  });
}

/* ------------- Export annotations as GeoJSON ------------- */
function exportAnnotations() {
  if (!annotations.length) {
    toast('No annotations to export.');
    return;
  }
  const features = annotations.map(a => ({
    type: 'Feature',
    properties: { id: a.id, name: a.name, water_score: a.water_score, timestamp: a.timestamp },
    geometry: { type: 'Point', coordinates: [a.lon, a.lat] }
  }));
  const fc = { type: 'FeatureCollection', features };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'annotations.geojson'; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
  toast('Annotations exported.');
}

/* ------------- Search ------------- */
function doSearch() {
  const q = ($(SEARCH_INPUT_ID) && $(SEARCH_INPUT_ID).value || '').trim().toLowerCase();
  if (!q) { toast('Type a crater name or ID to search.'); return; }
  // try exact id first
  let found = featureIndex[q] || null;
  if (!found) {
    // search by name substring
    found = Object.values(featureIndex).find(f => f.name && f.name.toLowerCase().includes(q));
  }
  if (!found) {
    toast('No crater matched your query.');
    return;
  }
  openFeature(found.id);
  setPermalink(map, currentLayerName, found.id);
}

/* ------------- Wire UI controls ------------- */
function wireUI() {
  // search
  const si = $(SEARCH_INPUT_ID), sb = $(SEARCH_BTN_ID);
  if (sb) sb.onclick = doSearch;
  if (si) si.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // suggest
  const sug = $(SUGGEST_BTN_ID);
  if (sug) sug.onclick = () => { showSuggestions(); };

  // export
  const exp = $(EXPORT_BTN_ID);
  if (exp) exp.onclick = () => { exportAnnotations(); };

  // layer radio buttons (index.html has radios named 'layer')
  document.querySelectorAll('input[name="layer"]').forEach(r => {
    r.addEventListener('change', (e) => {
      const newLayer = e.target.value;
      currentLayerName = newLayer;
      // For now only visible tiles exist; other layers can be added to tile urls pattern and toggled here.
      if (newLayer === 'vis') {
        if (baseTileLayer && !map.hasLayer(baseTileLayer)) baseTileLayer.addTo(map);
        if (fallbackImageOverlay && map.hasLayer(fallbackImageOverlay)) map.removeLayer(fallbackImageOverlay);
      } else {
        // For IR/elev/index we don't have tiles yet. Display toast and disable selection if attempted.
        toast('Layer not available in this build. Add tiles for IR / Elevation / Index to enable.');
        // revert to vis radio
        const visRadio = document.querySelector('input[name="layer"][value="vis"]');
        if (visRadio) visRadio.checked = true;
      }
      // update permalink
      setPermalink(map, currentLayerName, null);
    });
  });

  // map move -> update permalink (debounced)
  let permTimer = null;
  map.on('moveend', ()=> {
    if (permTimer) clearTimeout(permTimer);
    permTimer = setTimeout(()=> { setPermalink(map, currentLayerName, null); }, 500);
  });

  // when popup opens, update details panel if it's a feature marker
  map.on('popupopen', (e) => {
    const src = e.popup._source;
    if (src && src.featureId) {
      openFeature(src.featureId);
    }
  });

  // keyboard shortcuts (optional)
  window.addEventListener('keydown', (e) => {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); exportAnnotations(); }
  });
}

/* ------------- Helpers ------------- */
function normalizeFeatureScores() {
  // optional: if water_score missing but components exist, compute a fallback. Not overriding existing non-null scores.
  // This is conservative: if spectral/hydrogen/depth/psr exist, compute normalized weighted score.
  const arr = Object.values(featureIndex);
  // decide which fields exist
  const hasSpectral = arr.some(f=> f.spectral_mean !== null && f.spectral_mean !== undefined);
  const hasHydro = arr.some(f=> f.hydrogen_mean !== null && f.hydrogen_mean !== undefined);
  const hasDepth = arr.some(f=> f.depth_metric !== null && f.depth_metric !== undefined);
  const hasPSR = arr.some(f=> f.psr_overlap);

  // compute component ranges for normalization
  const specVals = arr.map(f=>f.spectral_mean).filter(v=> v!==null && v!==undefined);
  const hydroVals = arr.map(f=>f.hydrogen_mean).filter(v=> v!==null && v!==undefined);
  const depthVals = arr.map(f=>f.depth_metric).filter(v=> v!==null && v!==undefined);

  const specMin = specVals.length ? Math.min(...specVals) : 0;
  const specMax = specVals.length ? Math.max(...specVals) : 1;
  const hydroMin = hydroVals.length ? Math.min(...hydroVals) : 0;
  const hydroMax = hydroVals.length ? Math.max(...hydroVals) : 1;
  const depthMin = depthVals.length ? Math.min(...depthVals) : 0;
  const depthMax = depthVals.length ? Math.max(...depthVals) : 1;

  for (const id in featureIndex) {
    const f = featureIndex[id];
    if (f.water_score === null || f.water_score === undefined) {
      // compute components normalized
      const psr_c = f.psr_overlap ? 1 : 0;
      const spec_c = (f.spectral_mean !== null && f.spectral_mean !== undefined) ? ((f.spectral_mean - specMin) / (specMax - specMin + 1e-12)) : 0;
      const hydro_c = (f.hydrogen_mean !== null && f.hydrogen_mean !== undefined) ? ((f.hydrogen_mean - hydroMin) / (hydroMax - hydroMin + 1e-12)) : 0;
      const depth_c = (f.depth_metric !== null && f.depth_metric !== undefined) ? ((f.depth_metric - depthMin) / (depthMax - depthMin + 1e-12)) : 0;

      // choose weights depending on availability
      let w_psr=0.35, w_hydro=0.30, w_spec=0.30, w_depth=0.05;
      // If hydro or spec missing, reassign weights
      const comps = [
        {k:'psr', v:psr_c, w:w_psr},
        {k:'hydro', v:hydro_c, w:w_hydro, avail: hasHydro},
        {k:'spec', v:spec_c, w:w_spec, avail: hasSpectral},
        {k:'depth', v:depth_c, w:w_depth, avail: hasDepth}
      ];
      // normalize weights to only available comps
      let totalW = 0;
      comps.forEach(c => { if (c.avail===false) c.w = 0; totalW += c.w; });
      if (totalW <= 0) {
        f.water_score = null;
        continue;
      }
      comps.forEach(c => { c.w = c.w/totalW; });
      const score = comps.reduce((sum,c)=> sum + (c.v * c.w), 0);
      f.water_score = Number(score.toFixed(4));
      // update marker color if exists
      const layer = featureLayerMap[f.id];
      if (layer) {
        const col = scoreToColor(f.water_score);
        layer.setStyle({ color: col });
        // update popup content if open
        if (layer.getPopup && layer.getPopup() && layer.isPopupOpen && layer.isPopupOpen()) {
          layer.setPopupContent(renderPopupHtml(f));
        }
      }
    }
  }
}

/* ------------- Init app on DOM ready ------------- */
document.addEventListener('DOMContentLoaded', async () => {
  await init();
  // after features loaded, compute fallback water_score if missing
  try {
    normalizeFeatureScores();
  } catch (e) {
    console.warn('normalizeFeatureScores error', e);
  }
});
