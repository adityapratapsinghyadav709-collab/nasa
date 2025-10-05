// app.js — EmbiggenEye full frontend
// Place in docs/ and ensure index.html includes it after Leaflet + markercluster.
// Expects elements with IDs: searchInput, searchBtn, suggestBtn, exportBtn, helpBtn, annotationsList, featureDetails, toast, loader.
// Expects radio inputs: input[name="layer"] with values 'vis','ir','elev','index'.
// Expects tile folders under docs/tiles/... or a blank tile at docs/static/blank-tile.png

(() => {
  'use strict';

  // ---------- CONFIG ----------
  const DEBUG = false;
  const MAX_MAP_ZOOM = 5;
  const FEATURE_PARTS = ['features_part1.json','features_part2.json','features_part3.json'];
  const FEATURE_SINGLE = 'features.json';
  const SUGGESTIONS_FILE = 'suggestions.json';
  const BLANK_TILE = 'static/blank-tile.png'; // relative to PAGE_BASE
  const PAGE_BASE = (function(){
    let p = window.location.pathname || '/';
    if(p.indexOf('.') !== -1) p = p.substring(0, p.lastIndexOf('/')+1);
    if(!p.endsWith('/')) p += '/';
    return p;
  })();

  const TILE_PATHS = {
    vis: PAGE_BASE + 'tiles/layer_vis/{z}/{x}/{y}.png',
    ir:  PAGE_BASE + 'tiles/layer_ir/{z}/{x}/{y}.png',
    elev:PAGE_BASE + 'tiles/layer_elev/{z}/{x}/{y}.png',
    index:PAGE_BASE + 'tiles/layer_index/{z}/{x}/{y}.png'
  };

  // ---------- DOM helpers ----------
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  function safeId(id){ return document.getElementById(id); }
  function toast(msg, ms=2600){
    const el = safeId('toast');
    if(!el){ console.log('toast:', msg); return; }
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(el._t); el._t = setTimeout(()=> el.classList.remove('visible'), ms);
  }
  function setLoaderText(t){ const L = safeId('loader'); if(L){ L.style.display = t? 'block':'none'; L.textContent = t || ''; } }

  async function fetchJSON(url){
    const r = await fetch(url, {cache:'no-cache'});
    if(!r.ok) throw new Error(`${url} -> ${r.status}`);
    return await r.json();
  }

  // ---------- math / formatting helpers ----------
  function toNum(v){ if(v===undefined || v===null || v==='') return null; const n = Number(v); return Number.isFinite(n)? n : null; }
  function clamp01(v){ return Math.max(0, Math.min(1, (v==null?0:+v))); }
  function scoreToColor(s){
    const v = clamp01(s);
    const r = Math.round(255 * Math.min(1, Math.max(0, (v-0.5)*2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5-v)*2)));
    const g = Math.round(255 * (1 - Math.abs(v-0.5)*2));
    return `rgb(${r},${g},${b})`;
  }
  function diameterToRadiusPx(d){
    if(!d || isNaN(d)) return 6;
    const km = Math.max(0.001, d/1000);
    return Math.min(48, Math.max(6, 6 + Math.log10(km+1)*14));
  }
  function escapeHtml(s){ if(s==null) return ''; return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

  // ---------- normalization ----------
  function normalizeFeature(raw){
    const f = Object.assign({}, raw);
    f.id = f.id !== undefined ? String(f.id) : (f.name ? String(f.name) : ('f_'+Math.random().toString(36).slice(2,9)));
    f.name = f.name || f.id;
    f.lat = f.lat !== undefined ? toNum(f.lat) : (f.latitude !== undefined ? toNum(f.latitude) : null);
    f.lon = f.lon !== undefined ? toNum(f.lon) : (f.longitude !== undefined ? toNum(f.longitude) : null);
    f.x = f.x !== undefined ? toNum(f.x) : (f.pixel_x !== undefined ? toNum(f.pixel_x) : null);
    f.y = f.y !== undefined ? toNum(f.y) : (f.pixel_y !== undefined ? toNum(f.pixel_y) : null);
    if(f.diameter_m===undefined){
      if(f.diameter_km!==undefined) f.diameter_m = toNum(f.diameter_km) * 1000;
      else if(f.diameter!==undefined) f.diameter_m = toNum(f.diameter);
      else f.diameter_m = null;
    } else f.diameter_m = toNum(f.diameter_m);
    f.water_score = (f.water_score!==undefined)? toNum(f.water_score) : (f.score!==undefined? toNum(f.score) : 0);
    f.psr_overlap = (f.psr_overlap!==undefined)? f.psr_overlap : (f.psr!==undefined? f.psr : 0);
    f.spectral_mean = (f.spectral_mean!==undefined)? toNum(f.spectral_mean) : (f.spectral!==undefined? toNum(f.spectral) : null);
    f.hydrogen_mean = (f.hydrogen_mean!==undefined)? toNum(f.hydrogen_mean) : (f.hydrogen!==undefined? toNum(f.hydrogen) : null);
    f.depth_metric = (f.depth_metric!==undefined)? toNum(f.depth_metric) : (f.depth!==undefined? toNum(f.depth) : null);
    return f;
  }

  // ---------- main app ----------
  async function main(){
    try{
      setLoaderText('Initializing map…');

      // verify Leaflet present
      if(!window.L) throw new Error('Leaflet not found — include Leaflet before app.js');

      // map init (south-pole centered)
      const map = L.map('map', { preferCanvas:true, maxZoom: MAX_MAP_ZOOM }).setView([-89.6, -45.0], 2);
      window.map = map;

      // blank tile fallback
      const BLANK_TILE_URL = PAGE_BASE + BLANK_TILE;

      function makeTileLayer(template){
        return L.tileLayer(template, { maxZoom: MAX_MAP_ZOOM, tileSize:256, noWrap:true, errorTileUrl: BLANK_TILE_URL });
      }

      const layerVis = makeTileLayer(TILE_PATHS.vis);
      const layerIR = makeTileLayer(TILE_PATHS.ir);
      const layerElev = makeTileLayer(TILE_PATHS.elev);
      const layerIndex = makeTileLayer(TILE_PATHS.index);

      layerVis.addTo(map);

      // cluster group
      const markerCluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false });
      map.addLayer(markerCluster);

      // extra layers
      const suggestionLayer = L.layerGroup().addTo(map);
      const annotationLayer = L.layerGroup().addTo(map);

      // feature containers
      let rawFeatures = [];
      let features = [];
      const featureMap = new Map(); // id -> { feature, marker }

      // load features (parts first)
      setLoaderText('Loading features…');
      let totalLoaded = 0;
      for(const part of FEATURE_PARTS){
        try{
          const p = await fetchJSON(PAGE_BASE + part);
          if(Array.isArray(p)){ rawFeatures = rawFeatures.concat(p); totalLoaded += p.length; if(DEBUG) console.log('loaded', part, p.length); }
        }catch(e){}
      }
      if(totalLoaded === 0){
        try{
          const single = await fetchJSON(PAGE_BASE + FEATURE_SINGLE);
          if(Array.isArray(single)) { rawFeatures = rawFeatures.concat(single); totalLoaded += single.length; }
          else if(single && Array.isArray(single.features)){ rawFeatures = rawFeatures.concat(single.features); totalLoaded += single.features.length; }
        }catch(e){}
      }

      if(totalLoaded === 0){
        setLoaderText('');
        toast('No features found; app will still run (fallback).');
      } else {
        setLoaderText(`Loaded ${totalLoaded} raw features — normalizing…`);
      }

      // normalize features and collect pixel x/y lists for pixel-spread heuristic
      rawFeatures = rawFeatures.map(normalizeFeature);
      const allX = rawFeatures.map(f=>f.x).filter(v=>v!=null);
      const allY = rawFeatures.map(f=>f.y).filter(v=>v!=null);

      // apply pixel-spread if many features lack lat/lon but have x/y
      const latCount = rawFeatures.filter(f=> f.lat!=null && f.lon!=null).length;
      if((latCount / Math.max(1, rawFeatures.length)) < 0.25 && allX.length >= Math.max(10, rawFeatures.length*0.05) && allY.length >= Math.max(10, rawFeatures.length*0.05)){
        // compute min/max
        const minX = Math.min(...allX), maxX = Math.max(...allX);
        const minY = Math.min(...allY), maxY = Math.max(...allY);
        const bounds = map.getBounds();
        const minLat = bounds.getSouth(), maxLat = bounds.getNorth(), minLon = bounds.getWest(), maxLon = bounds.getEast();
        rawFeatures = rawFeatures.map(f=>{
          if((f.lat==null || f.lon==null) && f.x!=null && f.y!=null){
            const lon = minLon + ((f.x - minX) / (maxX - minX || 1)) * (maxLon - minLon);
            const lat = maxLat - ((f.y - minY) / (maxY - minY || 1)) * (maxLat - minLat);
            f.lat = lat; f.lon = lon; f._pixel_spread = true;
          }
          return f;
        });
        if(DEBUG) console.log('Applied pixel-spread heuristic for features without lat/lon');
      }

      // final features array
      features = rawFeatures.slice();
      window.EMBIGEN = window.EMBIGEN || {};
      window.EMBIGEN.features = features;

      setLoaderText('Rendering features on map…');

      // utility to build popup html
      function buildPopupHtml(f){
        const diam = f.diameter_m ? `${Math.round(f.diameter_m)} m (${(f.diameter_m/1000).toFixed(2)} km)` : '—';
        const score = (f.water_score!=null) ? f.water_score.toFixed(3) : '—';
        const spec = (f.spectral_mean!=null)? f.spectral_mean.toFixed(3) : '—';
        const hyd = (f.hydrogen_mean!=null)? f.hydrogen_mean.toFixed(3) : '—';
        const depth = (f.depth_metric!=null)? f.depth_metric.toFixed(3) : '—';
        const psr = f.psr_overlap ? 'Yes' : 'No';
        return `<div class="popup-card">
          <h4>${escapeHtml(f.name)}</h4>
          <table class="popup-table">
            <tr><td>water_score</td><td style="text-align:right"><b>${score}</b></td></tr>
            <tr><td>PSR</td><td style="text-align:right">${psr}</td></tr>
            <tr><td>Diameter</td><td style="text-align:right">${diam}</td></tr>
            <tr><td>Spectral</td><td style="text-align:right">${spec}</td></tr>
            <tr><td>Hydrogen</td><td style="text-align:right">${hyd}</td></tr>
            <tr><td>Depth</td><td style="text-align:right">${depth}</td></tr>
          </table>
          <div style="text-align:right;margin-top:8px">
            <button class="popup-accept btn small">Accept</button>
            <button class="popup-permalink btn small ghost">Permalink</button>
          </div>
        </div>`;
      }

      // highlight circle
      let highlight = null;
      function clearHighlight(){ if(highlight){ map.removeLayer(highlight); highlight = null; } }
      function showHighlight(f, color='#00ffff'){
        clearHighlight();
        const radius = Math.max(800, (f.diameter_m? f.diameter_m/3 : 5000));
        highlight = L.circle([f.lat, f.lon], { radius, color, weight:2.2, fillOpacity:0.08 }).addTo(map);
        try { map.setView([f.lat, f.lon], Math.min(MAX_MAP_ZOOM, Math.max(3, map.getZoom()))); } catch(e){}
      }

      // create marker for feature
      function makeMarkerForFeature(f){
        if(f.lat==null || f.lon==null) { if(DEBUG) console.warn('skip no coords', f.id); return null; }
        const rpx = diameterToRadiusPx(f.diameter_m);
        const marker = L.circleMarker([f.lat, f.lon], {
          radius: Math.max(6, Math.min(26, rpx)),
          color: scoreToColor(f.water_score),
          weight: 1.4,
          fillOpacity: 0.72
        });
        marker.featureId = f.id;
        marker._f = f;
        marker.bindPopup(buildPopupHtml(f), { minWidth: 240 });
        // open popup -> highlight + populate details
        marker.on('click', () => {
          try { marker.openPopup(); } catch(e){}
          try { showHighlight(f); } catch(e){}
          try { populateDetailsPanel(f); } catch(e){}
        });
        marker.on('popupopen', (ev)=>{
          const el = ev.popup.getElement();
          if(!el) return;
          const acc = el.querySelector('.popup-accept');
          if(acc) acc.onclick = ()=> { addAnnotationIfNew(f); try{ ev.popup._source.closePopup(); }catch(_){ } };
          const per = el.querySelector('.popup-permalink');
          if(per) per.onclick = ()=> { writePermalink({ zoom: map.getZoom(), lat: f.lat, lon: f.lon, layer: currentLayerName, id: f.id }); toast('Permalink updated'); };
        });
        return marker;
      }

      // render all features
      function renderFeatures(list){
        markerCluster.clearLayers();
        featureMap.clear();
        let added = 0, skipped = 0;
        for(const f of list){
          const m = makeMarkerForFeature(f);
          if(m){ markerCluster.addLayer(m); featureMap.set(String(f.id), { feature: f, marker: m }); added++; }
          else skipped++;
        }
        if(added > 0){
          // fit bounds loosely
          const coords = list.filter(ft=> ft.lat!=null && ft.lon!=null).map(ft=> [ft.lat, ft.lon]);
          try{ map.fitBounds(coords, { maxZoom: Math.min(4, MAX_MAP_ZOOM), padding:[40,40] }); } catch(e){}
        }
        setLoaderText('');
        if(DEBUG) console.log(`renderFeatures added=${added} skipped=${skipped}`);
        toast(`Displayed ${added} craters` , 2000);
        // update annotations UI
        refreshAnnotationsUI();
      }

      // populate right-hand panel with a feature
      const detailsEl = safeId('featureDetails');
      function populateDetailsPanel(f){
        if(!detailsEl) return;
        detailsEl.innerHTML = `
          <div style="padding:6px">
            <h3>${escapeHtml(f.name)}</h3>
            <div class="meta">id: ${escapeHtml(f.id)}</div>
            <div class="score-row" style="margin-top:6px">Water score: <b style="color:${scoreToColor(f.water_score)}">${(f.water_score||0).toFixed(3)}</b></div>
            <div style="margin-top:8px">PSR overlap: ${(f.psr_overlap? 'Yes':'No')}</div>
            <div>Diameter: ${(f.diameter_m? Math.round(f.diameter_m)+' m':'—')}</div>
            <div>Spectral mean: ${(f.spectral_mean!=null? f.spectral_mean.toFixed(3):'—')}</div>
            <div>Hydrogen mean: ${(f.hydrogen_mean!=null? f.hydrogen_mean.toFixed(3):'—')}</div>
            <div>Depth metric: ${(f.depth_metric!=null? f.depth_metric.toFixed(3):'—')}</div>
            <div style="margin-top:10px"><button id="detailAccept" class="btn small">Accept</button> <button id="detailPermalink" class="btn small ghost">Permalink</button></div>
          </div>
        `;
        const acc = safeId('detailAccept'); if(acc) acc.onclick = ()=> addAnnotationIfNew(f);
        const per = safeId('detailPermalink'); if(per) per.onclick = ()=> { writePermalink({ zoom: map.getZoom(), lat: f.lat, lon: f.lon, layer: currentLayerName, id: f.id }); toast('Permalink set'); };
      }

      // ---------- annotations (localStorage) ----------
      const ANNO_KEY = 'embiggen_annotations_v1';
      function loadAnnotations(){ try{ return JSON.parse(localStorage.getItem(ANNO_KEY) || '[]'); }catch(e){ return []; } }
      function saveAnnotations(a){ localStorage.setItem(ANNO_KEY, JSON.stringify(a)); }

      const annListEl = safeId('annotationsList');
      function refreshAnnotationsUI(){
        if(!annListEl) return;
        const anns = loadAnnotations();
        if(anns.length === 0){ annListEl.textContent = 'None yet'; return; }
        annListEl.innerHTML = anns.map(a => `<div class="ann-row"><div style="font-weight:700">${escapeHtml(a.name)}</div><div class="score">${(a.water_score!=null? a.water_score.toFixed(3):'—')}</div></div>`).join('');
      }

      function addAnnotationIfNew(f){
        if(!f || f.lat==null || f.lon==null){ toast('Cannot annotate — missing coords'); return; }
        const anns = loadAnnotations();
        if(anns.find(x=> x.id && f.id && x.id === f.id) || anns.find(x=> x.lat === f.lat && x.lon === f.lon)){ toast('Already annotated'); return; }
        const entry = { id: f.id, name: f.name, lat: f.lat, lon: f.lon, water_score: f.water_score || 0, ts: new Date().toISOString() };
        anns.push(entry); saveAnnotations(anns); refreshAnnotationsUI();
        // add a green marker
        const m = L.circleMarker([f.lat, f.lon], { radius: 10, color: '#2ee6a1', weight:1.4, fillOpacity:0.6 }).addTo(annotationLayer).bindPopup(`<b>${escapeHtml(f.name)}</b><br/>annotated`);
        toast('Annotation saved (localStorage)');
      }

      // export annotations
      function exportAnnotations(){
        const anns = loadAnnotations();
        const fc = { type:'FeatureCollection', features: anns.map(a=>({ type:'Feature', properties: { id:a.id, name:a.name, water_score:a.water_score, ts:a.ts }, geometry: { type:'Point', coordinates: [a.lon, a.lat] } })) };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type:'application/geo+json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'embiggen_annotations.geojson'; a.click(); URL.revokeObjectURL(url);
        toast('Exported annotations');
      }

      // ---------- search ----------
      const searchInput = safeId('searchInput');
      const searchBtn = safeId('searchBtn');
      function doSearch(){
        const q = (searchInput && searchInput.value || '').trim().toLowerCase();
        if(!q){ toast('Type crater name or id'); return; }
        const found = features.find(f => (f.name && f.name.toLowerCase().includes(q)) || (String(f.id).toLowerCase() === q));
        if(!found){ toast('No crater matched'); return; }
        // open marker
        const rec = featureMap.get(String(found.id));
        if(rec && rec.marker){ rec.marker.fire('click'); rec.marker.openPopup(); }
        else { showHighlight(found); populateDetailsPanel(found); map.setView([found.lat, found.lon], Math.min(MAX_MAP_ZOOM, 4)); }
        // update permalink
        writePermalink({ zoom: map.getZoom(), lat: found.lat, lon: found.lon, layer: currentLayerName, id: found.id });
      }
      if(searchBtn) searchBtn.addEventListener('click', doSearch);
      if(searchInput) searchInput.addEventListener('keydown', e => { if(e.key === 'Enter') doSearch(); });

      // ---------- suggestions ----------
      const suggestBtn = safeId('suggestBtn');
      async function loadSuggestionsOrTopN(n=10){
        try {
          const s = await fetchJSON(PAGE_BASE + SUGGESTIONS_FILE);
          if(Array.isArray(s)) return s;
        } catch(e){ if(DEBUG) console.warn('no suggestions file', e); }
        // fallback
        return features.slice().sort((a,b)=> (b.water_score||0) - (a.water_score||0)).slice(0,n);
      }

      async function showSuggestions(){
        setLoaderText('Loading suggestions…');
        const list = await loadSuggestionsOrTopN(10);
        suggestionLayer.clearLayers();
        let shown = 0;
        for(const s of list){
          const nf = normalizeFeature(s);
          if(nf.lat==null || nf.lon==null) continue;
          const node = L.circleMarker([nf.lat, nf.lon], { radius:12, color:'#ff7a00', weight:2, fillOpacity:0.22 });
          node.bindPopup(`<b>${escapeHtml(nf.name)}</b><br/>score: ${(nf.water_score!=null? nf.water_score.toFixed(3):'—')}<br/><button class="popup-accept btn small">Accept</button>`);
          node.on('popupopen', (ev)=>{
            const el = ev.popup.getElement();
            if(!el) return;
            const btn = el.querySelector('.popup-accept'); if(btn) btn.onclick = ()=>{ addAnnotationIfNew(nf); try{ ev.popup._source.closePopup(); }catch(_){} };
          });
          suggestionLayer.addLayer(node);
          // pulse effect via CSS class
          const el = node.getElement();
          if(el) el.classList.add('pulse');
          shown++;
        }
        setLoaderText('');
        toast(`${shown} suggestions shown`);
      }
      if(suggestBtn) suggestBtn.addEventListener('click', showSuggestions);

      // ---------- layer switching ----------
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
      // wire radio inputs
      $$('input[name="layer"]').forEach(r => {
        r.addEventListener('change', e => { if(e.target.checked) setLayer(e.target.value); });
      });

      // ---------- permalink helpers ----------
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
        const o = {};
        h.split('&').forEach(p => { const [k,v] = p.split('='); if(k) o[k] = decodeURIComponent(v || ''); });
        if(o.z) o.z = +o.z; if(o.lat) o.lat = +o.lat; if(o.lon) o.lon = +o.lon;
        return o;
      }

      // apply permalink on load
      (function restoreFromPermalink(){
        const p = readPermalink();
        if(!p) return;
        if(p.layer){ const radio = document.querySelector(`input[name="layer"][value="${p.layer}"]`); if(radio){ radio.checked = true; setLayer(p.layer); } }
        if(p.lat!=null && p.lon!=null) map.setView([p.lat, p.lon], (p.z || Math.min(3, MAX_MAP_ZOOM)));
        if(p.id){
          setTimeout(()=> {
            const rec = featureMap.get(String(p.id));
            if(rec && rec.marker){ rec.marker.fire('click'); rec.marker.openPopup(); }
          }, 600);
        }
      })();

      // update permalink as map moves
      map.on('moveend', ()=> {
        const c = map.getCenter();
        writePermalink({ zoom: map.getZoom(), lat: c.lat, lon: c.lng, layer: currentLayerName });
      });

      // ---------- side-by-side helper (Ctrl/Cmd+S) ----------
      async function enableSideBySide(){
        if(window.SideBySide){ if(window.sideBySideControl){ window.sideBySideControl.remove(); window.sideBySideControl = null; toast('Side-by-side removed'); return; } window.sideBySideControl = L.control.sideBySide(layerVis, layerIR).addTo(map); toast('Side-by-side enabled'); return; }
        try{
          await new Promise((resolve,reject)=>{
            const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet-side-by-side/leaflet-side-by-side.min.js'; s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
            const css = document.createElement('link'); css.rel='stylesheet'; css.href='https://unpkg.com/leaflet-side-by-side/leaflet-side-by-side.css'; document.head.appendChild(css);
          });
          window.sideBySideControl = L.control.sideBySide(layerVis, layerIR).addTo(map);
          toast('Side-by-side enabled (Visible / IR)');
        }catch(e){ toast('Side-by-side failed to load — falling back to layer toggle'); }
      }
      window.addEventListener('keydown', (ev) => { if((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's'){ ev.preventDefault(); enableSideBySide(); } });

      // ---------- UI wiring: search + export + help ----------
      const exportBtn = safeId('exportBtn');
      if(exportBtn) exportBtn.addEventListener('click', exportAnnotations);
      const helpBtn = safeId('helpBtn');
      if(helpBtn) helpBtn.addEventListener('click', ()=> {
        alert('EmbiggenEye tips:\n- Search a crater by name or id\n- Click Suggest to show precomputed candidates\n- Click a crater to inspect and Accept annotation\n- Press Ctrl/Cmd+S to try side-by-side (Visible vs IR)');
      });

      // ---------- final render ----------
      renderFeatures(features);

      // log summary
      if(DEBUG) console.log('EMBIGEN ready', { PAGE_BASE, TILE_PATHS, featuresLoaded: features.length });

    } catch(err){
      console.error('Fatal app error:', err);
      toast('Initialization error — check console');
      setLoaderText('');
    }
  }

  // start when DOM loaded
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();

})();
