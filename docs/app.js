// app.js — EmbiggenEye (cleaned, tolerant, highlight-on-click behaviour)
// Replace your existing app.js with this file.
// - clustered clickable markers (small & unobtrusive)
// - single highlighted circle appears when user clicks a crater or searches it
// - pixel->latlon heuristic to spread pixel-coord features for inspection
// - safe popup close, blank-tile fallback, tolerant normalizer
(() => {
  'use strict';

  // ---------- CONFIG ----------
  // If you have real image georef, set this to map pixel->geo accurately.
  // Example: IMAGE_GEOTIFF = { minLon:-45, maxLon:45, minLat:-90, maxLat:0, width:60000, height:40000 };
  const IMAGE_GEOTIFF = null;

  // features parts attempted (in /docs/)
  const FEATURE_PARTS = ['features_part1.json', 'features_part2.json', 'features_part3.json'];
  const FEATURE_SINGLE = 'features.json';

  // blank tile fallback (place docs/static/blank-tile.png as a tiny transparent PNG)
  const BLANK_TILE_NAME = 'static/blank-tile.png';

  const DEBUG = false; // set true for verbose logs
  const MAX_MAP_ZOOM = 5; // matches your tile generation

  // ---------- utilities ----------
  const whenReady = () => new Promise(r => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => r());
    else r();
  });

  const waitForLeaflet = (timeout = 5000) => new Promise((resolve,reject)=>{
    const start = Date.now();
    (function check(){
      if(window.L) return resolve();
      if(Date.now()-start > timeout) return reject(new Error('Leaflet not found'));
      setTimeout(check,50);
    })();
  });

  function computePageBase(){
    let path = window.location.pathname || '/';
    if (path.indexOf('.') !== -1) path = path.substring(0, path.lastIndexOf('/')+1);
    else if (!path.endsWith('/')) path = path + '/';
    if (!path.startsWith('/')) path = '/' + path;
    return path;
  }

  function toast(msg, t=2800){
    const el = document.getElementById('toast');
    if(!el){ if(DEBUG) console.log('[toast]', msg); return; }
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(el._timer);
    el._timer = setTimeout(()=> el.classList.remove('visible'), t);
  }

  async function loadJSON(url){
    const r = await fetch(url);
    if(!r.ok) throw new Error(`${url} -> ${r.status}`);
    return await r.json();
  }

  // ----- normalization helpers -----
  function toNum(v){ return (v===undefined||v===null||v==='')? null : (Number(v)===Number(v)? Number(v) : null); }

  function normalizeFeature(f){
    const out = Object.assign({}, f);
    // lat/lon fallbacks
    let lat = toNum(out.lat ?? out.latitude ?? out.y ?? out.pixel_y);
    let lon = toNum(out.lon ?? out.longitude ?? out.x ?? out.pixel_x);
    // pixel -> latlon if needed and IMAGE_GEOTIFF provided
    if((lat==null || lon==null) && (out.x!==undefined || out.pixel_x!==undefined || out.y!==undefined || out.pixel_y!==undefined) && IMAGE_GEOTIFF){
      const x = toNum(out.x ?? out.pixel_x), y = toNum(out.y ?? out.pixel_y);
      if(x!=null && y!=null){
        const mapped = pixelToLatLon(x,y);
        if(mapped){ lat = mapped[0]; lon = mapped[1]; }
      }
    }
    out.lat = lat;
    out.lon = lon;

    // diameter -> meters
    let diameter_m = null;
    if(out.diameter_m!==undefined) diameter_m = toNum(out.diameter_m);
    else if(out.diameter_km!==undefined) diameter_m = toNum(out.diameter_km) * 1000;
    else if(out.diameter!==undefined){
      const v = toNum(out.diameter); if(v!=null) diameter_m = (v>0 && v<100)? v*1000 : v;
    } else if(out.diam!==undefined) diameter_m = toNum(out.diam);
    out.diameter_m = (diameter_m==null || Number.isNaN(diameter_m))? null : diameter_m;

    // water score tolerant
    out.water_score = (out.water_score!==undefined)? toNum(out.water_score)
      : (out.score!==undefined? toNum(out.score) : (out.waterScore!==undefined? toNum(out.waterScore) : 0));
    if(out.water_score==null || Number.isNaN(out.water_score)) out.water_score = 0;

    // extras
    out.psr_overlap = out.psr_overlap!==undefined? out.psr_overlap : (out.psr!==undefined? out.psr : 0);
    out.spectral_mean = out.spectral_mean!==undefined? out.spectral_mean : (out.spectral!==undefined? out.spectral : null);
    out.hydrogen_mean = out.hydrogen_mean!==undefined? out.hydrogen_mean : (out.hydrogen!==undefined? out.hydrogen : null);
    out.depth_metric = out.depth_metric!==undefined? out.depth_metric : (out.depth!==undefined? out.depth : null);

    out.id = out.id !== undefined ? out.id : (out.name !== undefined ? out.name : ('f_'+Math.random().toString(36).slice(2,9)));
    out.name = out.name || out.id || `Feature ${out.id}`;
    return out;
  }

  function pixelToLatLon(x,y){
    if(!IMAGE_GEOTIFF) return null;
    const { minLon, maxLon, minLat, maxLat, width, height } = IMAGE_GEOTIFF;
    if([minLon,maxLon,minLat,maxLat,width,height].some(v=>v===undefined)) return null;
    const lon = minLon + (x / width) * (maxLon - minLon);
    const lat = maxLat - (y / height) * (maxLat - minLat);
    return [lat, lon];
  }

  function scoreToColor(s){
    s = Math.max(0, Math.min(1, (s==null?0:+s)));
    const r = Math.round(255 * Math.min(1, Math.max(0, (s-0.5)*2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5-s)*2)));
    const g = Math.round(255 * (1 - Math.abs(s-0.5)*2));
    return `rgb(${r},${g},${b})`;
  }

  function diameterMetersToRadiusPx(d){
    if(!d||isNaN(d)) return 8;
    const km = Math.max(0.001, d/1000);
    return Math.min(48, Math.max(6, 6 + Math.log10(km + 1)*14));
  }

  // ---------- main ----------
  (async function main(){
    try{
      await whenReady();
      await waitForLeaflet();

      const PAGE_BASE = computePageBase();
      const TILE_PATHS = {
        vis: PAGE_BASE + 'tiles/layer_vis/{z}/{x}/{y}.png',
        ir: PAGE_BASE + 'tiles/layer_ir/{z}/{x}/{y}.png',
        elev: PAGE_BASE + 'tiles/layer_elev/{z}/{x}/{y}.png',
        index: PAGE_BASE + 'tiles/layer_index/{z}/{x}/{y}.png',
      };
      window.EMBIGEN = window.EMBIGEN || {};
      window.EMBIGEN.PAGE_BASE = PAGE_BASE;
      window.EMBIGEN.TILE_PATHS = TILE_PATHS;

      // Map init (center near south pole)
      const map = L.map('map', { preferCanvas: true }).setView([-89.6, -45.0], 2);
      window.map = map;

      // blank tile fallback relative to PAGE_BASE
      const BLANK_TILE = PAGE_BASE + BLANK_TILE_NAME;

      // tile creation helper (errorTileUrl to quiet 404s)
      function makeTileLayer(template, opts={}){
        const baseOpts = Object.assign({ maxZoom: MAX_MAP_ZOOM, tileSize: 256, noWrap:true, errorTileUrl: BLANK_TILE }, opts);
        return L.tileLayer(template, baseOpts);
      }

      // Try tms:false by default. If your tiles were generated as TMS set tms:true if needed.
      const layerVis = makeTileLayer(TILE_PATHS.vis);
      const layerIR = makeTileLayer(TILE_PATHS.ir);
      const layerElev = makeTileLayer(TILE_PATHS.elev);
      const layerIndex = makeTileLayer(TILE_PATHS.index);

      layerVis.addTo(map);
      L.control.layers({'Visible': layerVis}, {}, { collapsed: true }).addTo(map);

      // cluster group (small markers)
      const markerCluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false });
      map.addLayer(markerCluster);

      // visible raw marker layer (hidden by default)
      const rawMarkerLayer = L.layerGroup();

      // annotation layer (green markers)
      const annotationsLayer = L.layerGroup().addTo(map);

      // suggestion layer (orange pulsing)
      const suggestionLayer = L.layerGroup().addTo(map);

      // highlight circle (single)
      let highlight = null;
      function clearHighlight(){ if(highlight){ map.removeLayer(highlight); highlight = null; } }
      function showHighlightAt(lat, lon, diameter_m, color='#00ffff'){
        clearHighlight();
        const rpx = diameterMetersToRadiusPx(diameter_m || 1000);
        // use circle with realistic geo radius? we use pixel-based visual radius for demo (map units) — keep visual consistent
        highlight = L.circle([lat, lon], { radius: 5000, weight: 2.2, color, fillColor: color, fillOpacity: 0.12 }).addTo(map);
        // pan/zoom into it lightly
        try { map.setView([lat, lon], Math.min(MAX_MAP_ZOOM, Math.max(3, map.getZoom()))); } catch(e){}
      }

      // ---- load features (multi-part then fallback) ----
      let rawFeatures = [];
      let loadedCount = 0;
      for (const part of FEATURE_PARTS){
        try{
          const url = PAGE_BASE + part;
          const p = await loadJSON(url);
          if(Array.isArray(p)){ rawFeatures = rawFeatures.concat(p); loadedCount += p.length; if(DEBUG) console.log('loaded',part,p.length); }
        }catch(e){
          try{
            const p = await loadJSON(part);
            if(Array.isArray(p)){ rawFeatures = rawFeatures.concat(p); loadedCount += p.length; if(DEBUG) console.log('loaded',part,'(bare)',p.length); }
          }catch(e2){ if(DEBUG) console.log('no part', part); }
        }
      }
      if(loadedCount === 0){
        try{
          const url = PAGE_BASE + FEATURE_SINGLE;
          const single = await loadJSON(url);
          if(Array.isArray(single)){ rawFeatures = rawFeatures.concat(single); loadedCount = single.length; }
          else if(single && Array.isArray(single.features)){ rawFeatures = rawFeatures.concat(single.features); loadedCount = single.features.length; }
        }catch(e){
          try{
            const single = await loadJSON(FEATURE_SINGLE);
            if(Array.isArray(single)){ rawFeatures = rawFeatures.concat(single); loadedCount = single.length; }
            else if(single && Array.isArray(single.features)){ rawFeatures = rawFeatures.concat(single.features); loadedCount = single.features.length; }
          }catch(e2){
            if(DEBUG) console.log('no features found');
          }
        }
      }

      // normalize
      let features = rawFeatures.map(normalizeFeature);

      // Heuristic: if lat/lon mostly missing but pixel x/y exist, auto-spread them across map bounds for inspection
      function detectPixelLikeAndSpread(list){
        // count lat present
        const latCount = list.filter(f=> f.lat!=null && f.lon!=null).length;
        const total = list.length;
        // detect x/y presence
        const xCount = rawFeatures.filter(f=> f.x!==undefined || f.pixel_x!==undefined).length;
        const yCount = rawFeatures.filter(f=> f.y!==undefined || f.pixel_y!==undefined).length;
        if(latCount/Math.max(1,total) < 0.2 && xCount>Math.max(10, total*0.05) && yCount>Math.max(10, total*0.05)){
          if(DEBUG) console.log('Detected pixel-like features; applying heuristic spread for inspection');
          // compute pixel min/max
          const xs = rawFeatures.map(f=> toNum(f.x ?? f.pixel_x)).filter(n=>n!=null);
          const ys = rawFeatures.map(f=> toNum(f.y ?? f.pixel_y)).filter(n=>n!=null);
          if(xs.length && ys.length){
            const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
            // map bounds to spread across: prefer current map bounds if reasonable, else a south-pole focused box
            const mapBounds = map.getBounds();
            let minLat = -89.95, maxLat = -89.2, minLon = -180, maxLon = 180;
            if(mapBounds && isFinite(mapBounds.getSouth())){
              minLat = mapBounds.getSouth(); maxLat = mapBounds.getNorth();
              minLon = mapBounds.getWest(); maxLon = mapBounds.getEast();
            }
            // write debug lat/lon for each
            features = rawFeatures.map((orig) => {
              const f = normalizeFeature(orig);
              const x = toNum(orig.x ?? orig.pixel_x), y = toNum(orig.y ?? orig.pixel_y);
              if(x==null || y==null) return f;
              // spread x->lon, y->lat
              const lon = minLon + ((x - minX) / (maxX - minX || 1)) * (maxLon - minLon);
              const lat = maxLat - ((y - minY) / (maxY - minY || 1)) * (maxLat - minLat);
              f.lat = lat; f.lon = lon;
              f._pixel_spread = true;
              return f;
            });
            return true;
          }
        }
        return false;
      }
      detectPixelLikeAndSpread(features);

      // store for debug
      window.EMBIGEN.mergedFeatures = features;

      toast(`Loaded ${features.length} features`);

      // ----- render behavior: create small invisible/small markers in cluster, highlight on click -----
      const featureMap = new Map();

      // create small marker icon style: keep subtle so map not cluttered
      function makeMarkerForFeature(f){
        // use circleMarker with tiny radius and low opacity; clickable
        const marker = L.circleMarker([f.lat, f.lon], {
          radius: 6,
          color: '#0aa',
          weight: 1,
          fillOpacity: 0.7,
          opacity: 0.9
        });
        marker.featureId = f.id;
        // click -> open popup and highlight
        marker.on('click', (e)=>{
          // ensure normalized
          const ff = f;
          // open popup
          const popupHtml = buildPopupHtml(ff);
          marker.bindPopup(popupHtml, { minWidth: 220 }).openPopup();
          // safe popup close replacement available later when pressing Accept
          // show single highlight circle (uses visual radius estimate)
          showHighlightAt(ff.lat, ff.lon, ff.diameter_m || 1000);
        });
        return marker;
      }

      function buildPopupHtml(f){
        const diamDisplay = f.diameter_m ? `${Math.round(f.diameter_m)} m (${(f.diameter_m/1000).toFixed(2)} km)` : '—';
        const score = (f.water_score != null) ? f.water_score : 0;
        const spectral = (f.spectral_mean != null) ? f.spectral_mean.toFixed(3) : '—';
        const hydrogen = (f.hydrogen_mean != null) ? f.hydrogen_mean.toFixed(3) : '—';
        const depth = (f.depth_metric != null) ? f.depth_metric.toFixed(3) : '—';
        const psr = f.psr_overlap ? 'Yes' : 'No';
        return `
          <div class="popup-card">
            <h4 style="margin:0 0 6px 0;">${escapeHtml(f.name || f.id || 'Feature')}</h4>
            <table class="popup-table" style="width:100%;font-size:13px;">
              <tr><td>water_score</td><td style="text-align:right;"><b>${score.toFixed(3)}</b></td></tr>
              <tr><td>PSR overlap</td><td style="text-align:right;">${psr}</td></tr>
              <tr><td>diameter</td><td style="text-align:right;">${diamDisplay}</td></tr>
              <tr><td>spectral_mean</td><td style="text-align:right;">${spectral}</td></tr>
              <tr><td>hydrogen_mean</td><td style="text-align:right;">${hydrogen}</td></tr>
              <tr><td>depth_metric</td><td style="text-align:right;">${depth}</td></tr>
            </table>
            <div style="margin-top:8px;text-align:right;">
              <button class="btn small accept-btn">Accept</button>
              <button class="btn small comment-btn" data-id="${escapeHtml(String(f.id))}" style="margin-left:6px">Comment</button>
            </div>
          </div>`;
      }

      // safe HTML escape
      function escapeHtml(s){ if(s==null) return ''; return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

      // render features as cluster items (no giant circles)
      function renderFeatures(list){
        markerCluster.clearLayers();
        rawMarkerLayer.clearLayers();
        featureMap.clear();
        for(const f of list){
          if(f.lat==null || f.lon==null) {
            if(DEBUG) console.warn('skip feature no coords', f.id); continue;
          }
          const marker = makeMarkerForFeature(f);
          // attach popupopen behaviour: wire accept and comment buttons safely
          marker.on('popupopen', e=>{
            const popupEl = e.popup.getElement();
            if(!popupEl) return;
            const accept = popupEl.querySelector('.accept-btn');
            if(accept){
              accept.onclick = ()=> {
                addAnnotationIfNew(f);
                // safe close
                try {
                  if(e.popup && e.popup._source && typeof e.popup._source.closePopup === 'function') e.popup._source.closePopup();
                  else if(typeof map.closePopup === 'function') map.closePopup();
                } catch(err){ if(DEBUG) console.warn('popup close failed', err); }
              };
            }
            const commentBtn = popupEl.querySelector('.comment-btn');
            if(commentBtn){
              commentBtn.onclick = ()=> {
                // placeholder: open small prompt (not saved permanently yet)
                const note = prompt('Add a comment (not saved yet):');
                if(note !== null){
                  toast('Comment captured locally (not saved). Will implement persistent comments soon.');
                  // store on feature object for now
                  f._local_comment = note;
                }
              };
            }
          });
          markerCluster.addLayer(marker);
          rawMarkerLayer.addLayer(marker);
          featureMap.set(String(f.id), { feature: f, marker });
        }
        // by default show clusters; remove rawMarkerLayer from map unless user toggles raw
        if(map.hasLayer(rawMarkerLayer)) map.removeLayer(rawMarkerLayer);
        if(!map.hasLayer(markerCluster)) map.addLayer(markerCluster);

        // fit bounds lightly
        const latlngs = list.filter(f=> f.lat!=null && f.lon!=null).map(f=> [f.lat,f.lon]);
        if(latlngs.length){
          try{ map.fitBounds(latlngs, { maxZoom: Math.min(MAX_MAP_ZOOM, 4), padding: [40,40] }); } catch(e){ if(DEBUG) console.warn('fitBounds', e); }
        }
      }

      // initial render
      renderFeatures(features);

      // -------------- annotations ----------------
      const ANNOTATION_KEY = 'embiggen_annotations_v1';
      function loadAnnotations(){ try{ return JSON.parse(localStorage.getItem(ANNOTATION_KEY) || '[]'); }catch(e){ return []; } }
      function saveAnnotations(a){ localStorage.setItem(ANNOTATION_KEY, JSON.stringify(a)); }
      function renderAnnotationsList(){ const el = document.getElementById('annotationsList'); const anns = loadAnnotations(); if(!el) return; if(!anns.length) el.textContent='None yet'; else el.innerHTML = anns.map(a=>`<div class="ann-row"><b>${escapeHtml(a.name)}</b> <span class="score">${(a.water_score||'—')}</span></div>`).join(''); }
      renderAnnotationsList();

      function addAnnotationIfNew(feature){
        const f = feature;
        if(!f || f.lat==null || f.lon==null){ toast('Cannot annotate (no coords)'); return; }
        const anns = loadAnnotations();
        if(anns.find(a=> a.id && f.id && a.id === f.id) || anns.find(a=> a.lat === f.lat && a.lon === f.lon)){
          toast('Already annotated');
          return;
        }
        const ann = { id: f.id || null, name: f.name || f.id || 'candidate', lon: f.lon, lat: f.lat, water_score: f.water_score||null, ts: new Date().toISOString(), comment: f._local_comment || null };
        anns.push(ann); saveAnnotations(anns); renderAnnotationsList();
        // add visual annotation marker
        const m = L.circleMarker([f.lat,f.lon], { radius: 10, color: '#2ee6a1', weight: 1.4, fillOpacity: 0.6 }).addTo(annotationsLayer).bindPopup(`<b>${escapeHtml(f.name)}</b><br/>annotation`);
        // ensure annotations layer visible
        if(!map.hasLayer(annotationsLayer)) map.addLayer(annotationsLayer);
      }

      // expose simple API for external controls
      window.EMBIGEN.getFeatureById = id => featureMap.get(String(id))?.feature || null;
      window.EMBIGEN.openFeature = id => {
        const entry = featureMap.get(String(id));
        if(!entry) return toast('Feature not found');
        entry.marker.fire('click');
        entry.marker.openPopup();
      };

      // --- UI wiring: search, suggest, export, layer radios ---
      const searchInput = document.getElementById('searchInput');
      const searchBtn = document.getElementById('searchBtn');
      const suggestBtn = document.getElementById('suggestBtn');
      const exportBtn = document.getElementById('exportBtn');

      function doSearch(){
        const q = (searchInput && searchInput.value || '').trim().toLowerCase();
        if(!q) { toast('Type a crater name or id'); return; }
        const found = features.find(f=> (f.name && f.name.toLowerCase().includes(q)) || (String(f.id).toLowerCase() === q));
        if(!found) { toast('No matching crater found'); return; }
        window.EMBIGEN.openFeature(found.id);
      }
      if(searchBtn) searchBtn.addEventListener('click', doSearch);
      if(searchInput) searchInput.addEventListener('keydown', e=>{ if(e.key==='Enter') doSearch(); });

      // suggestions loader (falls back to top by water_score)
      async function loadSuggestionsOrTopN(n=10){
        try{ return await loadJSON(PAGE_BASE + 'suggestions.json'); } catch(e){ try{ return await loadJSON('suggestions.json'); }catch(e2){ return features.slice().sort((a,b)=> (b.water_score||0) - (a.water_score||0)).slice(0,n);} }
      }

      if(suggestBtn) suggestBtn.addEventListener('click', async ()=>{
        const list = await loadSuggestionsOrTopN(10);
        suggestionLayer.clearLayers();
        list.forEach(s=>{
          const nf = normalizeFeature(s);
          if(nf.lat==null || nf.lon==null) return;
          const m = L.circleMarker([nf.lat,nf.lon], { radius:12, color:'#ff7a00', weight:2, fillOpacity:0.25 }).addTo(suggestionLayer);
          m.bindPopup(`<b>${escapeHtml(nf.name)}</b><br/>score:${(nf.water_score||0).toFixed(3)}<br/><button class="btn small accept-btn">Accept</button>`);
          m.on('popupopen', e=>{
            const el = e.popup.getElement(); if(!el) return;
            const btn = el.querySelector('.accept-btn'); if(btn) btn.onclick = ()=> { addAnnotationIfNew(nf); try{ if(e.popup && e.popup._source && typeof e.popup._source.closePopup==='function') e.popup._source.closePopup(); else map.closePopup(); }catch(_){} };
          });
        });
        toast(`${list.length} suggestions shown`);
      });

      // export annotations
      if(exportBtn) exportBtn.addEventListener('click', ()=>{
        const anns = loadAnnotations();
        const featuresGeo = anns.map(a=>({ type:'Feature', properties:{ id:a.id, name:a.name, water_score:a.water_score, ts:a.ts, comment: a.comment||null }, geometry:{ type:'Point', coordinates:[a.lon, a.lat] } }));
        const fc = { type:'FeatureCollection', features: featuresGeo };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'embiggen_annotations.geojson'; a.click(); URL.revokeObjectURL(url);
      });

      // layer radio handling (vis/ir/elev/index toggles)
      const radios = document.querySelectorAll('input[name="layer"]');
      radios.forEach(r => r.addEventListener('change', e=>{
        const v = e.target.value;
        map.removeLayer(layerVis); map.removeLayer(layerIR); map.removeLayer(layerElev); map.removeLayer(layerIndex);
        if(v==='vis') map.addLayer(layerVis);
        else if(v==='ir') map.addLayer(layerIR);
        else if(v==='elev') map.addLayer(layerElev);
        else if(v==='index') map.addLayer(layerIndex);
      }));

      // small helper: expose internals & debug
      window.EMBIGEN.map = map;
      window.EMBIGEN.mergedFeatures = features;
      window.EMBIGEN.renderFeatures = renderFeatures;
      window.EMBIGEN.featureMap = featureMap;
      window.EMBIGEN.annotationsLayer = annotationsLayer;
      if(DEBUG) console.log('EMBIGEN ready', { PAGE_BASE, TILE_PATHS, featuresLoaded: features.length });

      // final toast
      toast('EmbiggenEye ready — click a marker to highlight & inspect');

    } catch(err){
      console.error('App init failed:', err);
      try{ toast('Initialization error — check console'); } catch(e){}
    }
  })();

})(); 
