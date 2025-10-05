// app.js — EmbiggenEye (enhanced UX, features, and robustness)
// Drop into your docs/ (or repo root if your index.html loads it).
// Assumes index.html already contains the UI elements you provided (searchInput, searchBtn, suggestBtn, exportBtn, radios, annotationsList, featureDetails).
// Uses FEATURE_PARTS or features.json; loads suggestions.json when requested.
// Permalink: encoded in URL hash as #z=<zoom>&lat=<lat>&lon=<lon>&layer=<layer>&id=<featureId>
(() => {
  'use strict';

  // ---------- CONFIG ----------
  const DEBUG = false;
  const MAX_MAP_ZOOM = 5;                 // matches tile generation
  const FEATURE_PARTS = ['features_part1.json','features_part2.json','features_part3.json'];
  const FEATURE_SINGLE = 'features.json';
  const SUGGESTIONS_FILE = 'suggestions.json';
  const BLANK_TILE = 'static/blank-tile.png'; // tiny fallback PNG in docs/static/
  const PAGE_BASE = (function(){
    let p = window.location.pathname || '/';
    if(p.indexOf('.') !== -1) p = p.substring(0, p.lastIndexOf('/')+1);
    if(!p.endsWith('/')) p += '/';
    return p;
  })();

  // tile URL templates (relative to PAGE_BASE)
  const TILE_PATHS = {
    vis: PAGE_BASE + 'tiles/layer_vis/{z}/{x}/{y}.png',
    ir:  PAGE_BASE + 'tiles/layer_ir/{z}/{x}/{y}.png',
    elev:PAGE_BASE + 'tiles/layer_elev/{z}/{x}/{y}.png',
    index:PAGE_BASE + 'tiles/layer_index/{z}/{x}/{y}.png'
  };

  // ---------- small helpers ----------
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const toast = (msg, t=2400) => {
    const el = document.getElementById('toast');
    if(!el){ if(DEBUG) console.log('[toast]', msg); return; }
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(el._timer);
    el._timer = setTimeout(()=> el.classList.remove('visible'), t);
  };
  const safeFetchJSON = async (url) => {
    try {
      const r = await fetch(url, {cache:'no-cache'});
      if(!r.ok) throw new Error(`${url} -> ${r.status}`);
      return await r.json();
    } catch(e) {
      if(DEBUG) console.warn('fetch failed', url, e);
      throw e;
    }
  };

  function clamp01(v){ return Math.max(0, Math.min(1, (v==null?0:+v))); }
  function scoreToColor(s){
    s = clamp01(s);
    const r = Math.round(255 * Math.min(1, Math.max(0, (s-0.5)*2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5-s)*2)));
    const g = Math.round(255 * (1 - Math.abs(s-0.5)*2));
    return `rgb(${r},${g},${b})`;
  }
  function diameterMetersToRadiusPx(d){
    if(!d||isNaN(d)) return 6;
    const km = Math.max(0.001, d/1000);
    return Math.min(48, Math.max(6, 6 + Math.log10(km + 1)*14));
  }
  function escapeHtml(s){ if(s==null) return ''; return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

  // normalize common feature shapes to expected fields
  function normalizeFeature(raw){
    const f = Object.assign({}, raw);
    f.id = f.id !== undefined ? String(f.id) : (f.name ? String(f.name) : ('f_'+Math.random().toString(36).slice(2,8)));
    f.name = f.name || f.id;
    f.lat = (f.lat!==undefined? +f.lat : (f.latitude!==undefined? +f.latitude : null));
    f.lon = (f.lon!==undefined? +f.lon : (f.longitude!==undefined? +f.longitude : null));
    f.x = (f.x!==undefined? +f.x : (f.pixel_x!==undefined? +f.pixel_x : null));
    f.y = (f.y!==undefined? +f.y : (f.pixel_y!==undefined? +f.pixel_y : null));
    // diameter meters tolerant
    if(f.diameter_m===undefined){
      if(f.diameter_km!==undefined) f.diameter_m = +f.diameter_km * 1000;
      else if(f.diameter!==undefined) f.diameter_m = +f.diameter;
      else f.diameter_m = null;
    }
    f.water_score = (f.water_score!==undefined? +f.water_score : (f.score!==undefined? +f.score : 0));
    f.psr_overlap = f.psr_overlap!==undefined ? f.psr_overlap : (f.psr!==undefined? f.psr : 0);
    f.spectral_mean = f.spectral_mean!==undefined ? f.spectral_mean : (f.spectral!==undefined? f.spectral : null);
    f.hydrogen_mean = f.hydrogen_mean!==undefined ? f.hydrogen_mean : (f.hydrogen!==undefined? f.hydrogen : null);
    f.depth_metric = f.depth_metric!==undefined ? f.depth_metric : (f.depth!==undefined? f.depth : null);
    return f;
  }

  // convert map state -> permalink hash and apply it
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
    try {
      const h = location.hash.replace(/^#/, '');
      if(!h) return null;
      const o = {};
      h.split('&').forEach(p=>{
        const [k,v] = p.split('=');
        if(!k) return;
        o[k] = decodeURIComponent(v || '');
      });
      if(o.z) o.z = +o.z;
      if(o.lat) o.lat = +o.lat;
      if(o.lon) o.lon = +o.lon;
      return o;
    } catch(e){ return null; }
  }

  // ---------- main app ----------
  async function init(){
    // wait for DOM & Leaflet
    if(!window.L) {
      toast('Leaflet not found — check scripts');
      return;
    }

    // UI elements
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    const suggestBtn = document.getElementById('suggestBtn');
    const exportBtn = document.getElementById('exportBtn');
    const helpBtn = document.getElementById('helpBtn');
    const annotationsListEl = document.getElementById('annotationsList');
    const featureDetailsEl = document.getElementById('featureDetails');

    // Map
    const map = L.map('map', { preferCanvas:true, maxZoom: MAX_MAP_ZOOM }).setView([-89.6, -45.0], 2);
    window.map = map;

    // tile layers with safe fallback
    function makeTileLayer(template){
      return L.tileLayer(template, { maxZoom: MAX_MAP_ZOOM, tileSize:256, noWrap:true, errorTileUrl: PAGE_BASE + BLANK_TILE });
    }
    const layerVis = makeTileLayer(TILE_PATHS.vis);
    const layerIR = makeTileLayer(TILE_PATHS.ir);
    const layerElev = makeTileLayer(TILE_PATHS.elev);
    const layerIndex = makeTileLayer(TILE_PATHS.index);

    // put visible first
    layerVis.addTo(map);

    // layer control (we will wire radios to control instead of using built-in control)
    const baseLayers = { 'Visible': layerVis };
    L.control.layers(baseLayers, {}, { collapsed: true }).addTo(map);

    // marker clustering
    const markerCluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false, spiderfyOnMaxZoom: true });
    map.addLayer(markerCluster);

    // suggestion & annotation layers
    const suggestionLayer = L.layerGroup().addTo(map);
    const annotationLayer = L.layerGroup().addTo(map);

    // highlight single circle
    let highlightCircle = null;
    function clearHighlight(){ if(highlightCircle){ map.removeLayer(highlightCircle); highlightCircle = null; } }
    function showHighlight(f, opts={}){
      clearHighlight();
      const color = opts.color || '#00ffff';
      const radius = (f.diameter_m? Math.max(400, f.diameter_m/4) : 6000);
      highlightCircle = L.circle([f.lat, f.lon], { radius, color, weight:2.4, fillOpacity: 0.08 }).addTo(map);
      map.setView([f.lat, f.lon], Math.min(map.getMaxZoom(), Math.max(3, map.getZoom())));
    }

    // load features (try parts then fallback single)
    let rawFeatures = [];
    let loaded = 0;
    for(const part of FEATURE_PARTS){
      try{
        const data = await safeFetchJSON(PAGE_BASE + part);
        if(Array.isArray(data)) { rawFeatures = rawFeatures.concat(data); loaded += data.length; if(DEBUG) console.log('loaded part', part, data.length); }
      } catch(e){ /* ignore missing parts */ }
    }
    if(loaded === 0){
      try {
        const single = await safeFetchJSON(PAGE_BASE + FEATURE_SINGLE);
        if(Array.isArray(single)) { rawFeatures = rawFeatures.concat(single); loaded += single.length; }
        else if(single && Array.isArray(single.features)) { rawFeatures = rawFeatures.concat(single.features); loaded += single.features.length; }
      } catch(e){ /* no features found */ }
    }
    if(loaded === 0){
      toast('No features.json found — UI will still load (fallback)');
      rawFeatures = [];
    } else {
      toast(`Loaded ${loaded} features`);
    }

    // normalize
    let features = rawFeatures.map(normalizeFeature);

    // if many features have no lat/lon but x/y exist, auto-spread them across the map bounds (useful for pixel-indexed dumps)
    (function pixelSpreadIfNeeded(){
      const hasLat = features.filter(f=> f.lat!=null && f.lon!=null).length;
      const hasXY = rawFeatures.filter(f=> f.x!=null && f.y!=null).length;
      if(hasLat/Math.max(1,features.length) < 0.2 && hasXY > Math.max(10, features.length*0.05)){
        // spread across current bounds
        const xs = rawFeatures.map(f=> +f.x).filter(n=> !isNaN(n));
        const ys = rawFeatures.map(f=> +f.y).filter(n=> !isNaN(n));
        if(xs.length && ys.length){
          const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
          const b = map.getBounds();
          const minLat = b.getSouth(), maxLat = b.getNorth(), minLon = b.getWest(), maxLon = b.getEast();
          features = rawFeatures.map(r => {
            const f = normalizeFeature(r);
            if(f.lat==null || f.lon==null){
              const x = +r.x || +r.pixel_x, y = +r.y || +r.pixel_y;
              if(!isNaN(x) && !isNaN(y)){
                const lon = minLon + ((x - minX) / (maxX - minX || 1)) * (maxLon - minLon);
                const lat = maxLat - ((y - minY) / (maxY - minY || 1)) * (maxLat - minLat);
                f.lat = lat; f.lon = lon; f._pixel_spread = true;
              }
            }
            return f;
          });
          toast('Applied pixel-spread heuristic to features for inspection');
        }
      }
    })();

    // build markers & feature map
    const featureMap = new Map();
    function makeMarker(f){
      const marker = L.circleMarker([f.lat, f.lon], {
        radius: 6,
        color: '#059',
        weight: 1.2,
        fillOpacity: 0.7
      });
      marker.featureId = f.id;
      marker.on('click', () => {
        // open popup & highlight + populate details pane
        const popupHtml = buildPopupHtml(f);
        marker.bindPopup(popupHtml, { minWidth: 260 }).openPopup();
        showHighlight(f);
        populateFeatureDetails(f);
      });
      return marker;
    }

    function buildPopupHtml(f){
      const diam = f.diameter_m? `${Math.round(f.diameter_m)} m (${(f.diameter_m/1000).toFixed(2)} km)` : '—';
      const score = (f.water_score!=null? f.water_score.toFixed(3) : '—');
      const spectral = f.spectral_mean!=null? f.spectral_mean.toFixed(3) : '—';
      const hydrogen = f.hydrogen_mean!=null? f.hydrogen_mean.toFixed(3) : '—';
      const depth = f.depth_metric!=null? f.depth_metric.toFixed(3) : '—';
      const psr = f.psr_overlap? 'Yes' : 'No';
      return `
        <div class="popup-card">
          <h4 style="margin:0 0 6px 0;">${escapeHtml(f.name)}</h4>
          <table class="popup-table" style="width:100%;font-size:13px">
            <tr><td>water_score</td><td style="text-align:right"><b>${score}</b></td></tr>
            <tr><td>PSR</td><td style="text-align:right">${psr}</td></tr>
            <tr><td>diameter</td><td style="text-align:right">${diam}</td></tr>
            <tr><td>spectral</td><td style="text-align:right">${spectral}</td></tr>
            <tr><td>hydrogen</td><td style="text-align:right">${hydrogen}</td></tr>
            <tr><td>depth</td><td style="text-align:right">${depth}</td></tr>
          </table>
          <div style="text-align:right;margin-top:8px">
            <button class="popup-accept btn small">Accept</button>
            <button class="popup-permalink btn small ghost" style="margin-left:6px">Permalink</button>
          </div>
        </div>
      `;
    }

    function populateFeatureDetails(f){
      if(!featureDetailsEl) return;
      featureDetailsEl.innerHTML = `
        <div class="feature-header">
          <h3>${escapeHtml(f.name)}</h3>
          <div class="meta">id: ${escapeHtml(f.id)}</div>
        </div>
        <div class="feature-body">
          <div class="score-row">Water score: <b style="color:${scoreToColor(f.water_score)}">${(f.water_score||0).toFixed(3)}</b></div>
          <div>PSR overlap: ${(f.psr_overlap? 'Yes':'No')}</div>
          <div>Diameter: ${(f.diameter_m? Math.round(f.diameter_m)+' m':'—')}</div>
          <div>Spectral mean: ${(f.spectral_mean!=null? f.spectral_mean.toFixed(3):'—')}</div>
          <div>Hydrogen mean: ${(f.hydrogen_mean!=null? f.hydrogen_mean.toFixed(3):'—')}</div>
          <div>Depth metric: ${(f.depth_metric!=null? f.depth_metric.toFixed(3):'—')}</div>
          <div style="margin-top:10px"><button id="detailAccept" class="btn">Accept</button> <button id="detailPermalink" class="btn ghost">Permalink</button></div>
        </div>
      `;
      // wire detail accept/permalink
      const btnA = document.getElementById('detailAccept');
      if(btnA) btnA.onclick = ()=> addAnnotationIfNew(f);
      const btnP = document.getElementById('detailPermalink');
      if(btnP) btnP.onclick = ()=> {
        writePermalink({ zoom: map.getZoom(), lat: f.lat, lon: f.lon, layer: currentLayerName, id: f.id });
        toast('Permalink updated in URL');
      };
    }

    // render markers
    function renderAllFeatures(list){
      markerCluster.clearLayers();
      featureMap.clear();
      for(const f of list){
        if(f.lat==null || f.lon==null) continue;
        const m = makeMarker(f);
        markerCluster.addLayer(m);
        featureMap.set(String(f.id), { f, marker: m });
      }
      // fit bounds if many
      const coords = list.filter(f=> f.lat!=null && f.lon!=null).map(f=> [f.lat, f.lon]);
      if(coords.length>0){
        try { map.fitBounds(coords, { maxZoom: Math.min(4, MAX_MAP_ZOOM), padding:[30,30] }); } catch(e){}
      }
    }
    renderAllFeatures(features);

    // ---- Annotations stored in localStorage ----
    const ANNO_KEY = 'embiggen_ann_v1';
    function loadAnnotations(){ try{ return JSON.parse(localStorage.getItem(ANNO_KEY) || '[]'); }catch(e){ return []; } }
    function saveAnnotations(a){ localStorage.setItem(ANNO_KEY, JSON.stringify(a)); }
    function refreshAnnotationsUI(){
      if(!annotationsListEl) return;
      const a = loadAnnotations();
      if(a.length === 0) { annotationsListEl.textContent = 'None yet'; return; }
      annotationsListEl.innerHTML = a.map(x => `<div class="ann-row"><b>${escapeHtml(x.name)}</b> <small>score:${(x.water_score!=null? x.water_score.toFixed(3): '—')}</small></div>`).join('');
    }
    function addAnnotationIfNew(f){
      if(!f.lat || !f.lon) { toast('Feature has no coords'); return; }
      const anns = loadAnnotations();
      if(anns.find(a => a.id && f.id && a.id === f.id)) { toast('Already annotated'); return; }
      const entry = { id: f.id, name: f.name, lat: f.lat, lon: f.lon, water_score: f.water_score || 0, ts: new Date().toISOString() };
      anns.push(entry); saveAnnotations(anns); refreshAnnotationsUI();
      // show marker
      const m = L.circleMarker([f.lat, f.lon], { radius: 10, color: '#2ee6a1', weight:1.4, fillOpacity:0.6 }).addTo(annotationLayer).bindPopup(`<b>${escapeHtml(f.name)}</b><br/>annotated`);
      toast('Annotation saved (localStorage)');
      // ensure visible
      if(!map.hasLayer(annotationLayer)) map.addLayer(annotationLayer);
    }
    refreshAnnotationsUI();

    // export annotations -> GeoJSON
    function exportAnnotations(){
      const anns = loadAnnotations();
      const featuresGeo = anns.map(a => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
        properties: { id: a.id, name: a.name, water_score: a.water_score, ts: a.ts }
      }));
      const fc = { type:'FeatureCollection', features: featuresGeo };
      const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'embiggen_annotations.geojson'; a.click(); URL.revokeObjectURL(url);
      toast('Exported annotations');
    }
    if(exportBtn) exportBtn.addEventListener('click', exportAnnotations);

    // Search binding
    function doSearch(){
      const q = (searchInput && searchInput.value || '').trim().toLowerCase();
      if(!q){ toast('Type a crater name or id'); return; }
      const found = features.find(f => (f.name && f.name.toLowerCase().includes(q)) || (String(f.id).toLowerCase() === q));
      if(!found) { toast('No crater matched'); return; }
      // simulate click
      const rec = featureMap.get(String(found.id));
      if(rec && rec.marker) {
        rec.marker.fire('click');
        rec.marker.openPopup();
        writePermalink({ zoom: map.getZoom(), lat: found.lat, lon: found.lon, layer: currentLayerName, id: found.id });
      } else {
        // fallback: center and highlight
        showHighlight(found);
        populateFeatureDetails(found);
      }
    }
    if(searchBtn) searchBtn.addEventListener('click', doSearch);
    if(searchInput) searchInput.addEventListener('keydown', e => { if(e.key === 'Enter') doSearch(); });

    // Suggest button: load suggestions.json (fallback to top-N by water_score)
    async function showSuggestions(){
      let suggestions = [];
      try {
        suggestions = await safeFetchJSON(PAGE_BASE + SUGGESTIONS_FILE);
        if(!Array.isArray(suggestions)) throw new Error('invalid suggestions structure');
      } catch(e) {
        // fallback: top 10 features by water_score
        suggestions = features.slice().sort((a,b)=> (b.water_score||0) - (a.water_score||0)).slice(0,10);
      }
      suggestionLayer.clearLayers();
      suggestions.forEach(s=>{
        const nf = normalizeFeature(s);
        if(nf.lat==null || nf.lon==null) return;
        const pulse = L.circleMarker([nf.lat, nf.lon], { radius: 12, color: '#ff7a00', weight:2, fillOpacity:0.15 });
        pulse.bindPopup(`<b>${escapeHtml(nf.name)}</b><br/>score: ${(nf.water_score!=null? nf.water_score.toFixed(3):'—')}<br/><button class="popup-accept btn small">Accept</button>`);
        pulse.on('popupopen', (e)=>{
          const el = e.popup.getElement();
          if(!el) return;
          const btn = el.querySelector('.popup-accept');
          if(btn) btn.onclick = () => { addAnnotationIfNew(nf); try{ e.popup._source && e.popup._source.closePopup(); }catch(_){} };
        });
        suggestionLayer.addLayer(pulse);
        // small CSS pulse effect if available (index.html CSS should define .pulse)
        const node = pulse.getElement();
        if(node) node.classList.add('pulse');
      });
      toast(`${suggestions.length} suggestions shown`);
    }
    if(suggestBtn) suggestBtn.addEventListener('click', showSuggestions);

    // Layer radio wiring (vis/ir/elev/index)
    let currentLayerName = 'vis';
    function setLayer(name){
      currentLayerName = name;
      map.removeLayer(layerVis); map.removeLayer(layerIR); map.removeLayer(layerElev); map.removeLayer(layerIndex);
      if(name === 'vis') map.addLayer(layerVis);
      else if(name === 'ir') map.addLayer(layerIR);
      else if(name === 'elev') map.addLayer(layerElev);
      else if(name === 'index') map.addLayer(layerIndex);
      writePermalink({ zoom: map.getZoom(), lat: map.getCenter().lat, lon: map.getCenter().lng, layer: currentLayerName });
    }
    // connect radios
    $$('input[name="layer"]').forEach(r => {
      r.addEventListener('change', (e) => { if(e.target.checked) setLayer(e.target.value); });
      // set disabled state visually if tile path likely missing: we leave as is, user can enable later
    });

    // Permalink on moveend (update hash)
    map.on('moveend', () => {
      const c = map.getCenter();
      writePermalink({ zoom: map.getZoom(), lat: c.lat, lon: c.lng, layer: currentLayerName });
    });

    // Read permalink and restore view if present
    (function restoreFromPermalink(){
      const p = readPermalink();
      if(!p) return;
      if(p.layer) {
        const radio = document.querySelector(`input[name="layer"][value="${p.layer}"]`);
        if(radio) { radio.checked = true; setLayer(p.layer); }
      }
      if(p.lat!=null && p.lon!=null) map.setView([p.lat, p.lon], (p.z || Math.min(3, MAX_MAP_ZOOM)));
      if(p.id) {
        // try open feature after a short delay so markers exist
        setTimeout(()=> {
          const rec = featureMap.get(String(p.id));
          if(rec && rec.marker){ rec.marker.fire('click'); rec.marker.openPopup(); }
        }, 600);
      }
    })();

    // Side-by-side swipe support (loads plugin if available; otherwise toggles only)
    let sideBySideControl = null;
    async function enableSideBySide(){
      if(window.SideBySide) {
        // plugin already loaded
        if(sideBySideControl) sideBySideControl.remove();
        sideBySideControl = L.control.sideBySide(layerVis, layerIR).addTo(map);
        toast('Side-by-side enabled (Visible / IR)');
        return;
      }
      // try to lazy-load leaflet-side-by-side plugin from unpkg
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://unpkg.com/leaflet-side-by-side/leaflet-side-by-side.min.js';
          s.onload = resolve; s.onerror = reject;
          document.head.appendChild(s);
        });
        // also try adding CSS (plugin has minimal CSS but good to add)
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'https://unpkg.com/leaflet-side-by-side/leaflet-side-by-side.css';
        document.head.appendChild(css);
        // slight delay
        setTimeout(()=> {
          if(window.SideBySide) {
            sideBySideControl = L.control.sideBySide(layerVis, layerIR).addTo(map);
            toast('Side-by-side enabled (Visible / IR)');
          } else {
            toast('Side-by-side plugin loaded but not available');
          }
        }, 300);
      } catch(e){
        toast('Side-by-side plugin failed to load; using toggle instead');
      }
    }
    // add a simple keyboard toggle: press 's' to enable side-by-side attempt
    window.addEventListener('keydown', (ev) => {
      if(ev.key === 's' && (ev.ctrlKey || ev.metaKey)) {
        enableSideBySide();
        ev.preventDefault();
      }
    });

    // small helper: make a permalink for current view + open selected feature
    map.on('popupopen', e => {
      // handle popup button wiring inside popup (delegated)
      const popup = e.popup;
      const el = popup.getElement();
      if(!el) return;
      const acceptBtn = el.querySelector('.popup-accept');
      if(acceptBtn) {
        acceptBtn.onclick = () => {
          const fid = e.popup._source && e.popup._source.featureId;
          if(fid && featureMap.has(String(fid))) addAnnotationIfNew(featureMap.get(String(fid)).f);
          try{ e.popup._source.closePopup(); }catch(_){}
        };
      }
      const permBtn = el.querySelector('.popup-permalink');
      if(permBtn) {
        permBtn.onclick = () => {
          const fid = e.popup._source && e.popup._source.featureId;
          const latlng = e.popup._latlng;
          writePermalink({ zoom: map.getZoom(), lat: latlng.lat, lon: latlng.lng, layer: currentLayerName, id: fid });
          toast('Permalink set in URL');
        };
      }
    });

    // Simple UI help button
    if(helpBtn) helpBtn.addEventListener('click', () => {
      const msg = `Shortcuts:\n• Ctrl/Cmd+S: try side-by-side\n• Search: find crater\n• Suggest: load precomputed suggestions\n• Export: download annotations`;
      alert(msg);
    });

    // expose some internals for debugging
    window.EMBIGEN = window.EMBIGEN || {};
    window.EMBIGEN.map = map;
    window.EMBIGEN.features = features;
    window.EMBIGEN.featureMap = featureMap;
    window.EMBIGEN.addAnnotationIfNew = addAnnotationIfNew;

    // final ready toast
    toast('EmbiggenEye ready — click a crater to inspect (or press Ctrl/Cmd+S to try side-by-side)');

  } // end init

  // start
  document.addEventListener('DOMContentLoaded', ()=> {
    try { init(); } catch(e) { console.error(e); toast('Initialization error — check console'); }
  });

})();
