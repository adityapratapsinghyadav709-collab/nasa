// app.js — EmbiggenEye (fixed GeoJSON support + popups + annotations + suggestions)
// Replace your existing app.js with this file.

(() => {
  'use strict';

  const DEBUG = false;
  const MAX_MAP_ZOOM = 5;
  const FEATURE_PARTS = ['features_part1.json','features_part2.json','features_part3.json'];
  const FEATURE_SINGLE = 'features.json';
  const SUGGESTIONS_FILE = 'suggestions.json';
  const BLANK_TILE = 'static/blank-tile.png';

  // compute PAGE_BASE same as before
  function computePageBase(){
    let path = window.location.pathname || '/';
    if (path.indexOf('.') !== -1) path = path.substring(0, path.lastIndexOf('/')+1);
    if (!path.endsWith('/')) path = path + '/';
    return path;
  }
  const PAGE_BASE = computePageBase();

  // paths for tiles (relative to PAGE_BASE)
  const TILE_PATHS = {
    vis: PAGE_BASE + 'tiles/layer_vis/{z}/{x}/{y}.png',
    ir:  PAGE_BASE + 'tiles/layer_ir/{z}/{x}/{y}.png',
    elev:PAGE_BASE + 'tiles/layer_elev/{z}/{x}/{y}.png',
    index:PAGE_BASE + 'tiles/layer_index/{z}/{x}/{y}.png'
  };
  const BLANK_TILE_URL = PAGE_BASE + BLANK_TILE;

  // tiny helpers
  const $ = s => document.querySelector(s);
  const $id = id => document.getElementById(id);
  function toast(msg, t=2200){ const el=$id('toast'); if(!el){ console.log('TOAST:',msg); return;} el.textContent=msg; el.classList.add('visible'); clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('visible'),t); }
  function setLoader(txt){ const L=$id('loader'); if(!L) return; if(txt){ L.style.display='block'; L.textContent=txt; } else { L.style.display='none'; L.textContent=''; } }

  async function fetchJSON(url){
    const res = await fetch(url, {cache:'no-cache'});
    if(!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  }

  function toNum(v){ if(v===null || v===undefined || v==='') return null; const n=Number(v); return Number.isFinite(n)? n : null; }
  function clamp01(v){ return Math.max(0, Math.min(1, (v==null?0:+v))); }
  function escapeHtml(s){ if(s==null) return ''; return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

  // state
  const STATE = {
    map: null,
    markerCluster: null,
    suggestionLayer: null,
    annotationLayer: null,
    featuresRaw: [],
    features: [],
    featureMap: new Map(), // id -> {feature, marker}
    suggestions: [],
    annotationsKey: 'embiggen_annotations_v1'
  };

  // ---------------- load features (GeoJSON-aware) ----------------
  async function loadFeatures(){
    setLoader('Loading features…');
    let rows = [];

    // try parts first
    for(const part of FEATURE_PARTS){
      try{
        const data = await fetchJSON(PAGE_BASE + part);
        if(data){
          if(data.type && data.type.toLowerCase()==='featurecollection' && Array.isArray(data.features)){
            data.features.forEach(ft => {
              if(ft && ft.properties){
                const rec = Object.assign({}, ft.properties);
                // if geometry has coordinates and lat/lon missing, extract
                if((rec.lat==null || rec.lon==null) && ft.geometry && ft.geometry.type === 'Point' && Array.isArray(ft.geometry.coordinates)){
                  rec.lon = rec.lon==null ? toNum(ft.geometry.coordinates[0]) : toNum(rec.lon);
                  rec.lat = rec.lat==null ? toNum(ft.geometry.coordinates[1]) : toNum(rec.lat);
                }
                rec._geometry = ft.geometry || null;
                rows.push(rec);
              }
            });
            if(DEBUG) console.log('loaded geojson part', part, data.features.length);
          } else if(Array.isArray(data)){
            rows = rows.concat(data);
            if(DEBUG) console.log('loaded array part', part, data.length);
          } else if(data && data.features && Array.isArray(data.features)){
            data.features.forEach(ft=>{
              if(ft && ft.properties){
                const rec = Object.assign({}, ft.properties);
                if((rec.lat==null || rec.lon==null) && ft.geometry && ft.geometry.type === 'Point' && Array.isArray(ft.geometry.coordinates)){
                  rec.lon = rec.lon==null ? toNum(ft.geometry.coordinates[0]) : toNum(rec.lon);
                  rec.lat = rec.lat==null ? toNum(ft.geometry.coordinates[1]) : toNum(rec.lat);
                }
                rec._geometry = ft.geometry || null;
                rows.push(rec);
              }
            });
          }
        }
      }catch(e){
        if(DEBUG) console.log('no part', part, e);
      }
    }

    // try single file if none
    if(rows.length === 0){
      try{
        const data = await fetchJSON(PAGE_BASE + FEATURE_SINGLE);
        if(data){
          if(data.type && data.type.toLowerCase()==='featurecollection' && Array.isArray(data.features)){
            data.features.forEach(ft => {
              if(ft && ft.properties){
                const rec = Object.assign({}, ft.properties);
                if((rec.lat==null || rec.lon==null) && ft.geometry && ft.geometry.type === 'Point' && Array.isArray(ft.geometry.coordinates)){
                  rec.lon = rec.lon==null ? toNum(ft.geometry.coordinates[0]) : toNum(rec.lon);
                  rec.lat = rec.lat==null ? toNum(ft.geometry.coordinates[1]) : toNum(rec.lat);
                }
                rec._geometry = ft.geometry || null;
                rows.push(rec);
              }
            });
            if(DEBUG) console.log('loaded features.json geojson', rows.length);
          } else if(Array.isArray(data)){
            rows = rows.concat(data);
            if(DEBUG) console.log('loaded features.json array', data.length);
          } else if(data && data.features && Array.isArray(data.features)){
            data.features.forEach(ft=>{
              if(ft && ft.properties){
                const rec = Object.assign({}, ft.properties);
                if((rec.lat==null || rec.lon==null) && ft.geometry && ft.geometry.type === 'Point' && Array.isArray(ft.geometry.coordinates)){
                  rec.lon = rec.lon==null ? toNum(ft.geometry.coordinates[0]) : toNum(rec.lon);
                  rec.lat = rec.lat==null ? toNum(ft.geometry.coordinates[1]) : toNum(rec.lat);
                }
                rec._geometry = ft.geometry || null;
                rows.push(rec);
              }
            });
          } else {
            if(DEBUG) console.log('features.json unexpected format');
          }
        }
      }catch(e){
        if(DEBUG) console.log('no features.json at PAGE_BASE, trying bare name', e);
        try{
          const data = await fetchJSON(FEATURE_SINGLE);
          if(Array.isArray(data)) rows = rows.concat(data);
        }catch(e2){}
      }
    }

    // as final fallback try bare parts (no PAGE_BASE)
    if(rows.length === 0){
      for(const part of FEATURE_PARTS){
        try{
          const data = await fetchJSON(part);
          if(data){
            if(Array.isArray(data)) rows = rows.concat(data);
            else if(data.type && data.type.toLowerCase()==='featurecollection' && Array.isArray(data.features)){
              data.features.forEach(ft=>{
                if(ft && ft.properties){
                  const rec = Object.assign({}, ft.properties);
                  if((rec.lat==null || rec.lon==null) && ft.geometry && ft.geometry.type === 'Point' && Array.isArray(ft.geometry.coordinates)){
                    rec.lon = rec.lon==null ? toNum(ft.geometry.coordinates[0]) : toNum(rec.lon);
                    rec.lat = rec.lat==null ? toNum(ft.geometry.coordinates[1]) : toNum(rec.lat);
                  }
                  rec._geometry = ft.geometry || null;
                  rows.push(rec);
                }
              });
            }
          }
        }catch(e){}
      }
    }

    STATE.featuresRaw = rows;
    setLoader('');
    console.log('loadFeatures -> rows read:', rows.length);
    return rows;
  }

  // ---------------- normalize and compute fallback water_score ----------------
  function normalizeFeatures(rawRows){
    const out = rawRows.map(r => {
      const rec = Object.assign({}, r);
      // normalize names/ids
      rec.id = rec.id !== undefined ? String(rec.id) : (rec.name ? String(rec.name) : ('f_'+Math.random().toString(36).slice(2,9)));
      rec.name = rec.name || rec.id;
      // coordinates: support lon/lat or x/y
      rec.lat = rec.lat !== undefined ? toNum(rec.lat) : (rec.latitude !== undefined ? toNum(rec.latitude) : null);
      rec.lon = rec.lon !== undefined ? toNum(rec.lon) : (rec.longitude !== undefined ? toNum(rec.longitude) : null);
      // geometry coords fallback if lat/lon missing
      if((rec.lat==null || rec.lon==null) && rec._geometry && rec._geometry.type === 'Point' && Array.isArray(rec._geometry.coordinates)){
        rec.lon = rec.lon==null ? toNum(rec._geometry.coordinates[0]) : rec.lon;
        rec.lat = rec.lat==null ? toNum(rec._geometry.coordinates[1]) : rec.lat;
      }
      // diameters
      if(rec.diameter_m === undefined){
        if(rec.diameter_km !== undefined) rec.diameter_m = toNum(rec.diameter_km) * 1000;
        else if(rec.diameter !== undefined) rec.diameter_m = toNum(rec.diameter);
        else rec.diameter_m = null;
      } else rec.diameter_m = toNum(rec.diameter_m);
      // numeric components
      rec.spectral_mean = rec.spectral_mean !== undefined ? toNum(rec.spectral_mean) : null;
      rec.hydrogen_mean = rec.hydrogen_mean !== undefined ? toNum(rec.hydrogen_mean) : null;
      rec.depth_metric = rec.depth_metric !== undefined ? toNum(rec.depth_metric) : null;
      // psr_overlap could be boolean or numeric
      if(rec.psr_overlap === false) rec.psr_overlap = 0;
      else if(rec.psr_overlap === true) rec.psr_overlap = 1;
      else rec.psr_overlap = toNum(rec.psr_overlap); // null if missing
      // water_score may be null
      rec.water_score = rec.water_score !== undefined && rec.water_score !== null ? toNum(rec.water_score) : null;
      return rec;
    });

    // compute simple fallback water_score if missing for many features:
    // we'll normalize available components and use simple weights:
    const spectralVals = out.map(f=>f.spectral_mean).filter(v=>v!=null);
    const hydrogenVals = out.map(f=>f.hydrogen_mean).filter(v=>v!=null);
    const depthVals = out.map(f=>f.depth_metric).filter(v=>v!=null);
    const psrVals = out.map(f=>f.psr_overlap).filter(v=>v!=null);

    function normFn(arr){
      if(!arr || arr.length===0) return v => 0;
      const mn = Math.min(...arr), mx = Math.max(...arr);
      const span = (mx - mn) || 1;
      return v => (v==null ? 0 : Math.max(0, Math.min(1, (v - mn) / span)));
    }
    const normSpec = normFn(spectralVals);
    const normHyd = normFn(hydrogenVals);
    const normDep = normFn(depthVals);
    const normPsr = normFn(psrVals);

    for(const f of out){
      // if water_score already provided, keep it
      if(f.water_score != null) continue;
      // compute normalized components
      const ns = normSpec(f.spectral_mean);
      const nh = normHyd(f.hydrogen_mean);
      const nd = normDep(f.depth_metric);
      const np = normPsr(f.psr_overlap);
      // weights fallback
      let w_psr = 0.35, w_hyd = 0.30, w_spec = 0.30, w_dep = 0.05;
      // zero weights of missing components then renormalize
      const has = { psr: f.psr_overlap != null && f.psr_overlap > 0, hyd: f.hydrogen_mean!=null, spec: f.spectral_mean!=null, dep: f.depth_metric!=null };
      if(!has.psr) w_psr = 0;
      if(!has.hyd) w_hyd = 0;
      if(!has.spec) w_spec = 0;
      if(!has.dep) w_dep = 0;
      const tot = w_psr + w_hyd + w_spec + w_dep || 1;
      w_psr/=tot; w_hyd/=tot; w_spec/=tot; w_dep/=tot;
      const score = w_psr * np + w_hyd * nh + w_spec * ns + w_dep * nd;
      f.water_score = Number.isFinite(score)? score : 0;
      f._computed_score = true;
      f._norm = { ns, nh, nd, np };
      f._weights = { w_psr, w_hyd, w_spec, w_dep };
    }
    return out;
  }

  // ---------------- map init ----------------
  function initMap(){
    if(!window.L) throw new Error('Leaflet not found');
    const map = L.map('map', { preferCanvas:true, maxZoom: MAX_MAP_ZOOM }).setView([-89.6, -45.0], 2);
    STATE.map = map;
    const vis = L.tileLayer(TILE_PATHS.vis, { maxZoom: MAX_MAP_ZOOM, tileSize:256, noWrap:true, errorTileUrl: BLANK_TILE_URL });
    const ir = L.tileLayer(TILE_PATHS.ir, { maxZoom: MAX_MAP_ZOOM, tileSize:256, noWrap:true, errorTileUrl: BLANK_TILE_URL });
    vis.addTo(map);
    L.control.layers({'Visible':vis}, {}, {collapsed:true}).addTo(map);

    STATE.tileLayers = { vis, ir };

    // cluster
    STATE.markerCluster = L.markerClusterGroup({ chunkedLoading:true, showCoverageOnHover:false });
    map.addLayer(STATE.markerCluster);

    // suggestion and annotation layers
    STATE.suggestionLayer = L.layerGroup().addTo(map);
    STATE.annotationLayer = L.layerGroup().addTo(map);

    // map move => update hash (permalink)
    map.on('moveend', () => {
      const c = map.getCenter();
      const z = map.getZoom();
      const parts = [`z=${z}`, `lat=${c.lat.toFixed(6)}`, `lon=${c.lng.toFixed(6)}`, `layer=${STATE.currentLayerName||'vis'}`];
      location.hash = parts.join('&');
    });

    STATE.currentLayerName = 'vis';
  }

  // ---------------- rendering features & popups ----------------
  function scoreToColor(s){
    const v = clamp01(s);
    const r = Math.round(255 * Math.min(1, Math.max(0, (v-0.5)*2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5-v)*2)));
    const g = Math.round(255 * (1 - Math.abs(v-0.5)*2));
    return `rgb(${r},${g},${b})`;
  }
  function diameterToRadiusPx(d){
    if(!d) return 6;
    const km = Math.max(0.001, d/1000);
    return Math.min(40, Math.max(6, 6 + Math.log10(km+1)*12));
  }

  function buildPopupHtml(f){
    const diam = f.diameter_m ? `${Math.round(f.diameter_m)} m (${(f.diameter_m/1000).toFixed(2)} km)` : '—';
    const score = (f.water_score!=null)? f.water_score.toFixed(3) : '—';
    const spectral = (f.spectral_mean!=null)? f.spectral_mean.toFixed(3) : '—';
    const hydrogen = (f.hydrogen_mean!=null)? f.hydrogen_mean.toFixed(3) : '—';
    const depth = (f.depth_metric!=null)? f.depth_metric.toFixed(3) : '—';
    const psr = (f.psr_overlap != null && f.psr_overlap > 0) ? `${(f.psr_overlap*100).toFixed(1)}%` : 'No';
    return `
      <div class="popup-card">
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
          <button class="btn small popup-accept">Accept</button>
          <button class="btn small ghost popup-comment">Comment</button>
        </div>
      </div>
    `;
  }

  function clearHighlight(){
    if(STATE._highlightLayer){ try{ STATE.map.removeLayer(STATE._highlightLayer); }catch(_){} STATE._highlightLayer=null; }
  }
  function showHighlightAt(f){
    clearHighlight();
    if(!f || f.lat==null || f.lon==null) return;
    const r = Math.max(1000, (f.diameter_m? f.diameter_m/3 : 3000));
    STATE._highlightLayer = L.circle([f.lat, f.lon], { radius: r, color: '#00ffff', weight:2.4, fillOpacity:0.06 }).addTo(STATE.map);
    try { STATE.map.setView([f.lat, f.lon], Math.min(MAX_MAP_ZOOM, Math.max(3, STATE.map.getZoom()))); } catch(e){}
  }

  function createMarkerForFeature(f){
    if(f.lat==null || f.lon==null) return null;
    const rpx = diameterToRadiusPx(f.diameter_m);
    const marker = L.circleMarker([f.lat, f.lon], {
      radius: Math.max(6, Math.min(28, rpx)),
      color: scoreToColor(f.water_score),
      weight: 1.4,
      fillOpacity: 0.75
    });
    marker.featureId = f.id;
    marker._feature = f;
    marker.bindPopup(buildPopupHtml(f), { minWidth: 240 });
    marker.on('click', () => {
      try{ marker.openPopup(); }catch(e){}
      showHighlightAt(f);
      populateRightPanel(f);
    });
    marker.on('popupopen', (ev) => {
      const el = ev.popup.getElement();
      if(!el) return;
      const acc = el.querySelector('.popup-accept');
      if(acc) acc.onclick = () => { addAnnotation(f); try{ ev.popup._source.closePopup(); }catch(_){} };
      const com = el.querySelector('.popup-comment');
      if(com) com.onclick = () => { promptComment(f); };
    });
    return marker;
  }

  // render features all at once
  function renderFeatures(features){
    if(!STATE.markerCluster) return;
    STATE.markerCluster.clearLayers();
    STATE.featureMap.clear();
    let added = 0, skipped = 0;
    for(const f of features){
      if(f.lat==null || f.lon==null){ skipped++; continue; }
      const m = createMarkerForFeature(f);
      if(m){ STATE.markerCluster.addLayer(m); STATE.featureMap.set(String(f.id), { feature: f, marker: m }); added++; }
      else skipped++;
    }
    toast(`Rendered ${added} craters (skipped ${skipped})`);
    if(added>0){
      // don't auto-fit aggressively, but if user hasn't panned try fit
      try{
        const coords = features.filter(ff=>ff.lat!=null && ff.lon!=null).slice(0,200).map(ff=>[ff.lat, ff.lon]);
        if(coords.length) STATE.map.fitBounds(coords, { maxZoom: Math.min(MAX_MAP_ZOOM,4), padding:[30,30] });
      }catch(e){}
    }
    // restore previously saved annotations visual
    restoreAnnotationsOnMap();
  }

  // ---------------- annotations & comments (localStorage) ----------------
  function loadAnnotations(){
    try{ return JSON.parse(localStorage.getItem(STATE.annotationsKey) || '[]'); } catch(e){ return []; }
  }
  function saveAnnotations(arr){ localStorage.setItem(STATE.annotationsKey, JSON.stringify(arr)); }

  function refreshLeftAnnotationsUI(){
    const el = $id('annotationsList');
    if(!el) return;
    const anns = loadAnnotations();
    if(anns.length === 0) { el.textContent = 'None yet'; return; }
    el.innerHTML = anns.map(a => `<div class="ann-row"><div><b>${escapeHtml(a.name)}</b><div style="font-size:12px;color:var(--muted)">${escapeHtml(a.id || '')}</div></div><div style="text-align:right;color:${scoreToColor(a.water_score || 0)}">${(a.water_score!=null? a.water_score.toFixed(3):'—')}</div></div>`).join('');
  }

  function restoreAnnotationsOnMap(){
    const anns = loadAnnotations();
    STATE.annotationLayer.clearLayers();
    for(const a of anns){
      try{
        const mm = L.circleMarker([a.lat, a.lon], { radius: 9, color:'#2ee6a1', weight:1.6, fillOpacity:0.7 }).addTo(STATE.annotationLayer);
        mm.bindPopup(`<b>${escapeHtml(a.name)}</b><br/>annotation`);
      }catch(e){}
    }
    refreshLeftAnnotationsUI();
  }

  function addAnnotation(f){
    if(!f || f.lat==null || f.lon==null){ toast('Cannot annotate (no coords)'); return; }
    const anns = loadAnnotations();
    if(anns.find(x=> x.id && f.id && String(x.id) === String(f.id))) { toast('Already annotated'); return; }
    const entry = { id: f.id, name: f.name, lat: f.lat, lon: f.lon, water_score: (f.water_score!=null? f.water_score:0), ts: new Date().toISOString(), comment: f._comment || null };
    anns.push(entry);
    saveAnnotations(anns);
    restoreAnnotationsOnMap();
    toast('Annotation saved locally');
  }

  function promptComment(f){
    const prev = f._comment || '';
    const note = prompt('Add a comment / note for this crater:', prev);
    if(note === null) return;
    f._comment = note;
    // if annotated, sync
    const anns = loadAnnotations();
    const idx = anns.findIndex(a=> a.id && f.id && String(a.id)===String(f.id));
    if(idx !== -1){ anns[idx].comment = note; anns[idx].ts = new Date().toISOString(); saveAnnotations(anns); restoreAnnotationsOnMap(); }
    toast('Comment saved locally');
  }

  // export annotations
  function exportAnnotations(){
    const anns = loadAnnotations();
    const fc = { type:'FeatureCollection', features: anns.map(a=>({ type:'Feature', properties:{ id:a.id, name:a.name, water_score:a.water_score, ts:a.ts, comment:a.comment||null }, geometry:{ type:'Point', coordinates:[a.lon, a.lat] } })) };
    const blob = new Blob([JSON.stringify(fc,null,2)], { type:'application/geo+json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'embiggen_annotations.geojson'; a.click(); URL.revokeObjectURL(url);
    toast('Exported annotations');
  }

  // ---------------- suggestions (load suggestions.json or fallback to top-N) ----------------
  async function loadSuggestionsFile(){
    try{
      const s = await fetchJSON(PAGE_BASE + SUGGESTIONS_FILE);
      if(Array.isArray(s)) { STATE.suggestions = s; toast('Loaded suggestions.json'); return s; }
    }catch(e){ if(DEBUG) console.log('no suggestions.json at PAGE_BASE', e); }
    try{ const s = await fetchJSON(SUGGESTIONS_FILE); if(Array.isArray(s)) { STATE.suggestions = s; toast('Loaded suggestions.json'); return s; } } catch(e){}
    return null;
  }
  async function showSuggestions(){
    const sfile = await loadSuggestionsFile();
    if(!sfile){
      // fallback: top N by water_score
      const arr = STATE.features.slice().sort((a,b)=>(b.water_score||0)-(a.water_score||0)).slice(0,20);
      STATE.suggestions = arr.map(f=>({ id:f.id, name:f.name, lat:f.lat, lon:f.lon, water_score:f.water_score }));
    }
    // draw suggestions
    STATE.suggestionLayer.clearLayers();
    for(const s of STATE.suggestions){
      if(s.lat==null || s.lon==null) continue;
      const c = L.circleMarker([s.lat,s.lon], { radius:12, color:'#ff7a00', weight:2, fillOpacity:0.22 }).addTo(STATE.suggestionLayer);
      c.bindPopup(`<b>${escapeHtml(s.name)}</b><br/>score:${(s.water_score!=null? s.water_score.toFixed(3):'—')}<br/><button class="btn small popup-accept">Accept</button>`);
      c.on('popupopen', (ev) => {
        const el = ev.popup.getElement(); if(!el) return;
        const btn = el.querySelector('.popup-accept'); if(btn) btn.onclick = () => { const rec = STATE.features.find(x=>String(x.id)===String(s.id)); if(rec) addAnnotation(rec); try{ ev.popup._source.closePopup(); }catch(_){} };
      });
      const elt = c.getElement(); if(elt) elt.classList.add('pulse');
    }
    toast(`${STATE.suggestions.length} suggestions shown`);
    // open suggestions tab if present
    if(document.getElementById('tab-suggestions')) document.getElementById('tab-suggestions').click();
  }

  // ---------------- right panel details ----------------
  function ensureRightPanel(){
    const root = $id('featureDetails');
    if(!root) return;
    if(root._ready) return;
    root._ready = true;
    root.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <button id="tab-details" class="btn small ghost">Details</button>
        <button id="tab-suggestions" class="btn small ghost">Suggestions</button>
        <button id="tab-debug" class="btn small ghost">Debug</button>
        <div style="flex:1"></div>
        <button id="btn-detect" class="btn small">Detect</button>
      </div>
      <div id="tab-content" style="min-height:140px"><div class="empty" style="color:var(--muted)">Click a crater to view details</div></div>
    `;
    $id('tab-details').addEventListener('click', ()=> showTab('details'));
    $id('tab-suggestions').addEventListener('click', ()=> showTab('suggestions'));
    $id('tab-debug').addEventListener('click', ()=> showTab('debug'));
    $id('btn-detect').addEventListener('click', ()=> { showTab('suggestions'); showSuggestions(); });
    showTab('details');
  }
  function showTab(name){
    const content = $id('tab-content'); if(!content) return;
    ['details','suggestions','debug'].forEach(k => { const btn = $id('tab-'+k); if(btn) btn.classList.toggle('active', k===name); });
    if(name==='details'){ content.innerHTML = `<div class="empty" style="color:var(--muted)">Click a crater to view details</div>`; }
    else if(name==='suggestions'){ content.innerHTML = `<div style="color:var(--muted)">Use the Suggest button (topbar) to load suggestions.json or Detect to generate candidates.</div>`; }
    else if(name==='debug'){
      const total = STATE.features.length;
      const missingCoords = STATE.features.filter(f => f.lat==null || f.lon==null).length;
      const missingSpec = STATE.features.filter(f => f.spectral_mean==null).length;
      const missingHyd = STATE.features.filter(f => f.hydrogen_mean==null).length;
      const missingDepth = STATE.features.filter(f => f.depth_metric==null).length;
      content.innerHTML = `<div style="font-size:13px;color:var(--muted);padding:6px">
        <div>Total features: <b>${total}</b></div>
        <div>Missing coords: <b>${missingCoords}</b></div>
        <div>Missing spectral: <b>${missingSpec}</b></div>
        <div>Missing hydrogen: <b>${missingHyd}</b></div>
        <div>Missing depth: <b>${missingDepth}</b></div>
        <div style="margin-top:8px"><button id="dbg-sample" class="btn small ghost">Console sample</button> <button id="dbg-recompute" class="btn small">Re-render</button></div>
      </div>`;
      $id('dbg-sample').onclick = ()=> { console.log('features sample', STATE.features.slice(0,12)); toast('Sample printed to console'); };
      $id('dbg-recompute').onclick = ()=> { renderFeatures(STATE.features); toast('Re-render complete'); };
    }
  }

  function populateRightPanel(f){
    ensureRightPanel();
    const content = $id('tab-content'); if(!content) return;
    if(!f){ content.innerHTML = `<div class="empty" style="color:var(--muted)">Click a crater to view details</div>`; return; }
    content.innerHTML = `
      <div style="padding:6px">
        <h3 style="margin:6px 0;color:var(--accent)">${escapeHtml(f.name)}</h3>
        <div class="meta">id: ${escapeHtml(f.id)}</div>
        <div style="margin-top:8px">Water score: <b style="color:${scoreToColor(f.water_score)}">${(f.water_score!=null? f.water_score.toFixed(3):'—')}</b></div>
        <div>PSR: ${(f.psr_overlap && f.psr_overlap>0 ? (f.psr_overlap*100).toFixed(1)+'%':'No')}</div>
        <div>Diameter: ${(f.diameter_m? Math.round(f.diameter_m)+' m':'—')}</div>
        <div>Spectral mean: ${(f.spectral_mean!=null? f.spectral_mean.toFixed(3):'—')}</div>
        <div>Hydrogen mean: ${(f.hydrogen_mean!=null? f.hydrogen_mean.toFixed(3):'—')}</div>
        <div>Depth metric: ${(f.depth_metric!=null? f.depth_metric.toFixed(3):'—')}</div>
        <div style="margin-top:8px"><button id="detailAccept" class="btn small">Accept</button> <button id="detailComment" class="btn small ghost">Comment</button> <button id="detailPermalink" class="btn small ghost">Permalink</button></div>
      </div>
    `;
    $id('detailAccept').onclick = () => addAnnotation(f);
    $id('detailComment').onclick = () => promptComment(f);
    $id('detailPermalink').onclick = () => { const c=STATE.map.getCenter(); location.hash = `z=${STATE.map.getZoom()}&lat=${f.lat.toFixed(6)}&lon=${f.lon.toFixed(6)}&id=${encodeURIComponent(f.id)}`; toast('Permalink set'); };
  }

  function scoreToColor(s){ return scoreToColor_imple(s); } // alias below

  // small wrapper to avoid duplicate function definitions
  function scoreToColor_imple(s){
    const v = clamp01(s);
    const r = Math.round(255 * Math.min(1, Math.max(0, (v-0.5)*2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5-v)*2)));
    const g = Math.round(255 * (1 - Math.abs(v-0.5)*2));
    return `rgb(${r},${g},${b})`;
  }

  // ---------------- UI wiring for topbar controls ----------------
  function wireTopbar(){
    const searchInput = $id('searchInput');
    const searchBtn = $id('searchBtn');
    if(searchBtn) searchBtn.addEventListener('click', ()=> doSearch(searchInput && searchInput.value));
    if(searchInput) searchInput.addEventListener('keydown', e => { if(e.key === 'Enter') doSearch(searchInput.value); });

    const suggestBtn = $id('suggestBtn');
    if(suggestBtn) suggestBtn.addEventListener('click', ()=> showSuggestions());

    const exportBtn = $id('exportBtn'); if(exportBtn) exportBtn.addEventListener('click', ()=> exportAnnotations());
    const helpBtn = $id('helpBtn'); if(helpBtn) helpBtn.addEventListener('click', ()=> alert('EmbiggenEye — Tips:\\n- Search by name/id\\n- Click markers to view details and Accept/Comment\\n- Use Suggest to show candidates'));
  }

  function doSearch(q){
    if(!q || !String(q).trim()){ toast('Type crater name or id'); return; }
    const s = String(q).trim().toLowerCase();
    const found = STATE.features.find(f => (f.name && f.name.toLowerCase().includes(s)) || (String(f.id).toLowerCase() === s));
    if(!found){ toast('No match'); return; }
    const rec = STATE.featureMap.get(String(found.id));
    if(rec && rec.marker){ rec.marker.fire('click'); rec.marker.openPopup(); } else { showHighlightAt(found); populateRightPanel(found); }
  }

  // ---------------- boot sequence ----------------
  async function start(){
    try{
      setLoader('Starting EmbiggenEye…');
      initMap();
      wireTopbar();
      ensureRightPanel();

      const raw = await loadFeatures();
      if(!raw || raw.length === 0){
        setLoader('No features found; please add features.json to docs/');
        toast('No features found');
        return;
      }
      const normalized = normalizeFeatures(raw);
      STATE.features = normalized;
      // render
      renderFeatures(STATE.features);
      // restore saved annotations
      restoreAnnotationsOnMap();
      setLoader('');
      toast('Ready — click a crater to inspect');
      // placer: debug log
      if(DEBUG) console.log('STATE.features sample', STATE.features.slice(0,10));
    } catch(err){
      console.error('start err', err);
      setLoader('');
      toast('Initialization error — check console');
    }
  }

  // expose for console debugging
  window.EMBIGEN = window.EMBIGEN || {};
  Object.assign(window.EMBIGEN, {
    start, STATE, normalizeFeatures, loadFeatures, renderFeatures
  });

  // start when DOM loaded (index.html loads leaflet then this)
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

})();


