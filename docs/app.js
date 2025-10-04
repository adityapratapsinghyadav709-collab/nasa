// app.js — EmbiggenEye (robust, tolerant loader + normalizer + renderer)
// Drop this file in place of your current app.js. Designed to work with features_part1/2/3.json
// or a single features.json. Exposes window.EMBIGEN for debugging.
// Author: GPT (adapted to your project)

(() => {
  'use strict';

  // ------------- CONFIG -------------
  // If your features use pixel coordinates (x/y), configure IMAGE_GEOTIFF with real bounds.
  // Example:
  // const IMAGE_GEOTIFF = {
  //   minLon: -180, maxLon: 180,
  //   minLat: -90, maxLat: 90,
  //   width: 100000, height: 50000
  // };
  const IMAGE_GEOTIFF = null; // <-- set object above if you have pixel coordinates and want mapping

  // Which feature-part files to attempt loading (in order).
  const FEATURE_PARTS = ['features_part1.json', 'features_part2.json', 'features_part3.json'];

  // Fallback single-file name
  const FEATURE_SINGLE = 'features.json';

  // Debug toggles
  const DEBUG = false; // set true to see extra logs (tile requests, load traces)

  // Max zoom available in your tiles
  const MAX_MAP_ZOOM = 5;

  // ------------- UTILITIES -------------
  function whenReady() {
    return new Promise((resolve) => {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => resolve());
      } else resolve();
    });
  }

  function waitForLeaflet(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        if (window.L) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('Leaflet (L) not found'));
        setTimeout(check, 50);
      })();
    });
  }

  // Compute page base so assets resolve when served from / or /repo/ or /docs/
  function computePageBase() {
    let path = window.location.pathname || '/';
    if (path.indexOf('.') !== -1) path = path.substring(0, path.lastIndexOf('/') + 1);
    else if (!path.endsWith('/')) path = path + '/';
    if (!path.startsWith('/')) path = '/' + path;
    return path;
  }

  function toast(msg, timeout = 2800) {
    const t = document.getElementById('toast');
    if (!t) {
      if (DEBUG) console.log('[toast]', msg);
      return;
    }
    t.textContent = msg;
    t.classList.add('visible');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('visible'), timeout);
  }

  function loadJSON(url) {
    return fetch(url).then(r => {
      if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
      return r.json();
    });
  }

  // color and radius helpers
  function scoreToColor(s) {
    s = Math.max(0, Math.min(1, (s == null ? 0 : +s)));
    const r = Math.round(255 * Math.min(1, Math.max(0, (s - 0.5) * 2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5 - s) * 2)));
    const g = Math.round(255 * (1 - Math.abs(s - 0.5) * 2));
    return `rgb(${r},${g},${b})`;
  }

  // Convert diameter in meters -> pixel radius for display
  function diameterMetersToRadiusPx(diameter_m) {
    if (!diameter_m || isNaN(diameter_m)) return 8;
    const km = Math.max(0.001, diameter_m / 1000);
    // Gentle log scaling: small craters visible, large craters not huge
    return Math.min(48, Math.max(6, 6 + Math.log10(km + 1) * 14));
  }

  // Parse/normalize a single feature into canonical fields.
  // Returns a NEW object (does not mutate original).
  function normalizeFeature(f) {
    const out = Object.assign({}, f); // shallow copy

    // --- lat / lon ---
    // Prefer explicit numeric lat/lon
    function toNum(v) { return v === undefined || v === null ? null : (Number(v) === Number(v) ? Number(v) : null); }
    let lat = toNum(out.lat ?? out.latitude ?? out.y ?? out.pixel_y);
    let lon = toNum(out.lon ?? out.longitude ?? out.x ?? out.pixel_x);
    // If lat/lon were present but in lon/lat order (rare), try swap if values look like lon/lat
    if ((lat == null && lon != null) && (out.latitude == undefined && out.longitude == undefined)) {
      // attempt to interpret as (x,y) but fallback is handled by pixel mapping below
    }

    // Pixel -> lat/lon mapping if needed
    if ((lat == null || lon == null) && (out.x !== undefined || out.pixel_x !== undefined || out.y !== undefined || out.pixel_y !== undefined)) {
      const x = toNum(out.x ?? out.pixel_x);
      const y = toNum(out.y ?? out.pixel_y);
      if (x != null && y != null && IMAGE_GEOTIFF) {
        const mapped = pixelToLatLon(x, y);
        lat = mapped ? mapped[0] : lat;
        lon = mapped ? mapped[1] : lon;
      }
    }

    out.lat = lat;
    out.lon = lon;

    // --- diameter: normalize to meters into out.diameter_m ---
    const dCandidates = [
      ['diameter_m', out.diameter_m],
      ['diameter_km', out.diameter_km],
      ['diameter', out.diameter],
      ['diam', out.diam],
      ['size', out.size],
      ['radius_m', out.radius_m],
    ];
    let diameter_m = null;
    for (const [k, v] of dCandidates) {
      if (v !== undefined && v !== null && v !== '') {
        const n = Number(v);
        if (!Number.isNaN(n)) {
          if (k === 'diameter_km') diameter_m = n * 1000;
          else if (k === 'diameter_m' || k === 'radius_m') diameter_m = n;
          else if (k === 'diameter' || k === 'diam' || k === 'size') {
            // guess unit: if number less than 100 -> assume km, else meters
            diameter_m = (n > 0 && n < 100) ? n * 1000 : n;
          }
          break;
        }
      }
    }
    out.diameter_m = diameter_m != null ? diameter_m : null;

    // --- water score normalization ---
    out.water_score = (out.water_score !== undefined) ? Number(out.water_score)
      : (out.score !== undefined ? Number(out.score)
      : (out.waterScore !== undefined ? Number(out.waterScore) : null));
    if (out.water_score === null || Number.isNaN(out.water_score)) out.water_score = 0;

    // --- other expected fields (PSR, spectral, hydrogen, depth) ---
    out.psr_overlap = (out.psr_overlap !== undefined) ? out.psr_overlap : (out.psr !== undefined ? out.psr : 0);
    out.spectral_mean = (out.spectral_mean !== undefined) ? out.spectral_mean : (out.spectral !== undefined ? out.spectral : null);
    out.hydrogen_mean = (out.hydrogen_mean !== undefined) ? out.hydrogen_mean : (out.hydrogen !== undefined ? out.hydrogen : null);
    out.depth_metric = (out.depth_metric !== undefined) ? out.depth_metric : (out.depth !== undefined ? out.depth : null);

    // ensure ID and name exist
    out.id = (out.id !== undefined) ? out.id : (out.name !== undefined ? out.name : (Math.random().toString(36).slice(2, 9)));
    out.name = out.name || out.id || `Feature ${out.id}`;

    return out;
  }

  // Map pixel -> lat/lon
  function pixelToLatLon(x, y) {
    if (!IMAGE_GEOTIFF) return null;
    const { minLon, maxLon, minLat, maxLat, width, height } = IMAGE_GEOTIFF;
    if (![minLon, maxLon, minLat, maxLat, width, height].every(v => v !== undefined)) return null;
    const lon = minLon + (x / width) * (maxLon - minLon);
    const lat = maxLat - (y / height) * (maxLat - minLat);
    return [lat, lon];
  }

  // ------------- MAIN -------------
  (async function main() {
    try {
      await whenReady();
      await waitForLeaflet();

      const PAGE_BASE = computePageBase();
      if (DEBUG) console.log('[EMBIGGEN] PAGE_BASE =', PAGE_BASE);

      // Tile paths (page-base aware)
      const TILE_PATHS = {
        vis: PAGE_BASE + 'tiles/layer_vis/{z}/{x}/{y}.png',
        ir: PAGE_BASE + 'tiles/layer_ir/{z}/{x}/{y}.png',
        elev: PAGE_BASE + 'tiles/layer_elev/{z}/{x}/{y}.png',
        index: PAGE_BASE + 'tiles/layer_index/{z}/{x}/{y}.png',
      };

      // expose debug container
      window.EMBIGEN = window.EMBIGEN || {};
      window.EMBIGEN.PAGE_BASE = PAGE_BASE;
      window.EMBIGEN.TILE_PATHS = TILE_PATHS;

      // initialize map (center near south pole for demo)
      const map = L.map('map', { preferCanvas: true }).setView([-89.6, -45.0], 2);
      window.map = map;

      // debug tile wrapper — logs requested tile urls when DEBUG true
      function debugTileLayer(urlTemplate, options = {}) {
        const tl = L.tileLayer(urlTemplate, options);
        if (!DEBUG) return tl;
        const origCreate = tl.createTile.bind(tl);
        tl.createTile = function (coords, done) {
          const url = L.Util.template(this._url, coords);
          console.log('[tile-request]', url);
          fetch(url, { method: 'HEAD' }).then(r => {
            if (!r.ok) console.warn('[tile HEAD]', r.status, url);
          }).catch(e => console.warn('[tile HEAD error]', e, url));
          return origCreate(coords, done);
        };
        return tl;
      }

      const layerVis = debugTileLayer(TILE_PATHS.vis, { maxZoom: MAX_MAP_ZOOM, tileSize: 256, noWrap: true });
      const layerIR = debugTileLayer(TILE_PATHS.ir, { maxZoom: MAX_MAP_ZOOM, tileSize: 256, noWrap: true });
      const layerElev = debugTileLayer(TILE_PATHS.elev, { maxZoom: MAX_MAP_ZOOM, tileSize: 256, noWrap: true });
      const layerIndex = debugTileLayer(TILE_PATHS.index, { maxZoom: MAX_MAP_ZOOM, tileSize: 256, noWrap: true });

      layerVis.addTo(map);
      L.control.layers({ 'Visible': layerVis }, {}, { collapsed: true }).addTo(map);

      // marker clustering
      const markerCluster = L.markerClusterGroup({ chunkedLoading: true });
      map.addLayer(markerCluster);

      // ---- load features (multi-part then fallback) ----
      let rawFeatures = [];
      let loadedCount = 0;
      // Try multi-part
      for (const part of FEATURE_PARTS) {
        try {
          const url = PAGE_BASE + part;
          if (DEBUG) console.log('[EMBIGGEN] trying load', url);
          const partData = await loadJSON(url);
          if (Array.isArray(partData)) {
            rawFeatures = rawFeatures.concat(partData);
            loadedCount += partData.length;
            if (DEBUG) console.log(`[EMBIGGEN] loaded ${part} (${partData.length})`);
          } else {
            if (DEBUG) console.warn(`[EMBIGGEN] ${part} loaded but not an array; skipping`);
          }
        } catch (e) {
          // try bare path (no PAGE_BASE)
          try {
            const partData = await loadJSON(part);
            if (Array.isArray(partData)) {
              rawFeatures = rawFeatures.concat(partData);
              loadedCount += partData.length;
              if (DEBUG) console.log(`[EMBIGGEN] loaded ${part} (bare) (${partData.length})`);
            }
          } catch (e2) {
            if (DEBUG) console.log(`[EMBIGGEN] part not found: ${part}`);
          }
        }
      }

      // If nothing from parts, try single file
      if (loadedCount === 0) {
        try {
          const url = PAGE_BASE + FEATURE_SINGLE;
          const data = await loadJSON(url);
          if (Array.isArray(data)) {
            rawFeatures = rawFeatures.concat(data);
            loadedCount = data.length;
            if (DEBUG) console.log(`[EMBIGGEN] loaded single features.json (${data.length})`);
          } else if (data && Array.isArray(data.features)) {
            // handle GeoJSON-style { features: [...] }
            rawFeatures = rawFeatures.concat(data.features);
            loadedCount = data.features.length;
            if (DEBUG) console.log(`[EMBIGGEN] loaded GeoJSON features (${loadedCount})`);
          }
        } catch (e) {
          try {
            const data = await loadJSON(FEATURE_SINGLE);
            if (Array.isArray(data)) { rawFeatures = rawFeatures.concat(data); loadedCount = data.length; }
            else if (data && Array.isArray(data.features)) { rawFeatures = rawFeatures.concat(data.features); loadedCount = data.features.length; }
          } catch (e2) {
            if (DEBUG) console.warn('[EMBIGGEN] no features found (parts or single).');
          }
        }
      }

      const features = rawFeatures.map(normalizeFeature);
      if (features.length > 0) {
        toast(`Loaded ${features.length} features`);
      } else {
        toast('No features loaded (ok for demo)');
      }

      // store merged features for console debugging & runtime use
      window.EMBIGEN.mergedFeatures = features;

      // --- rendering ---
      const featureMap = new Map(); // id -> { feature, marker }

      function buildPopupHtml(f) {
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
            <div style="margin-top:8px;text-align:right;"><button class="btn small accept-btn">Accept</button></div>
          </div>`;
      }

      // safe HTML escaper for popup
      function escapeHtml(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
      }

      function renderFeatures(list) {
        markerCluster.clearLayers();
        featureMap.clear();
        const latlngs = [];

        for (const f of list) {
          if (f.lat == null || f.lon == null) {
            if (DEBUG) console.warn('skip feature - no coords:', f);
            continue;
          }
          const latlon = [f.lat, f.lon];
          const color = scoreToColor(f.water_score);
          const radius = diameterMetersToRadiusPx(f.diameter_m);
          const marker = L.circleMarker(latlon, {
            radius,
            color,
            weight: 1.5,
            fillOpacity: 0.65
          });

          const popupHtml = buildPopupHtml(f);
          marker.bindPopup(popupHtml, { minWidth: 220 });

          marker.on('popupopen', e => {
            // hook accept button inside popup
            const el = e.popup.getElement();
            if (el) {
              const btn = el.querySelector('.accept-btn');
              if (btn) btn.onclick = () => {
                addAnnotation(f);
                toast('Annotation saved locally');
                e.popup._close();
              };
            }
            showFeatureDetails(f);
          });

          marker.on('click', () => showFeatureDetails(f));

          markerCluster.addLayer(marker);
          featureMap.set(f.id || (f.name + '_' + Math.random().toString(36).slice(2,8)), { feature: f, marker });
          latlngs.push(latlon);
        }

        if (latlngs.length) {
          try { map.fitBounds(latlngs, { maxZoom: MAX_MAP_ZOOM, padding: [40,40] }); }
          catch (e) { if (DEBUG) console.warn('fitBounds failed', e); }
        }
      }

      renderFeatures(features);

      // ---- UI controls wiring ----
      const searchInput = document.getElementById('searchInput');
      const searchBtn = document.getElementById('searchBtn');
      const suggestBtn = document.getElementById('suggestBtn');
      const exportBtn = document.getElementById('exportBtn');

      function doSearch() {
        const q = (searchInput && searchInput.value || '').trim().toLowerCase();
        if (!q) { toast('Type a crater name or id'); return; }
        const found = features.find(f => (f.name && f.name.toLowerCase().includes(q)) || (String(f.id).toLowerCase() === q));
        if (!found) { toast('No matching crater found'); return; }
        map.setView([found.lat, found.lon], Math.min(MAX_MAP_ZOOM, 4));
        const item = featureMap.get(found.id) || Array.from(featureMap.values()).find(v => v.feature === found);
        if (item && item.marker) item.marker.openPopup();
      }

      if (searchBtn) searchBtn.addEventListener('click', doSearch);
      if (searchInput) searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

      async function loadSuggestionsOrTopN(n = 10) {
        try {
          const url = PAGE_BASE + 'suggestions.json';
          return await loadJSON(url);
        } catch (e) {
          try { return await loadJSON('suggestions.json'); } catch (e2) {
            return features.slice().sort((a,b) => (b.water_score||0) - (a.water_score||0)).slice(0, n);
          }
        }
      }

      let suggestionLayer = L.layerGroup().addTo(map);

      async function showSuggestions(list) {
        suggestionLayer.clearLayers();
        list.forEach(s => {
          // normalize suggestion to ensure lat/lon
          const nf = normalizeFeature(s);
          if (nf.lat == null || nf.lon == null) return;
          const m = L.circleMarker([nf.lat, nf.lon], { radius: 12, color: '#ff7a00', weight: 2, fillOpacity: 0.25 }).addTo(suggestionLayer);
          m.bindPopup(`<b>${escapeHtml(nf.name)}</b><br/>water_score: ${(nf.water_score||0).toFixed(3)}<br/><button class="btn small accept-btn">Accept</button>`);
          m.on('popupopen', e => {
            const el = e.popup.getElement();
            if (!el) return;
            const btn = el.querySelector('.accept-btn'); if (btn) btn.onclick = () => { addAnnotation(nf); toast('Suggestion accepted'); e.popup._close(); };
          });
        });
        toast(`${list.length} suggestions shown`);
      }

      if (suggestBtn) suggestBtn.addEventListener('click', async () => {
        const list = await loadSuggestionsOrTopN(10);
        await showSuggestions(list);
      });

      // --- Annotations (localStorage) ---
      const ANNOTATION_KEY = 'embiggen_annotations_v1';
      function loadAnnotations() { try { return JSON.parse(localStorage.getItem(ANNOTATION_KEY) || '[]'); } catch (e) { return []; } }
      function saveAnnotations(a) { localStorage.setItem(ANNOTATION_KEY, JSON.stringify(a)); }

      function addAnnotation(feature) {
        const anns = loadAnnotations();
        anns.push({ id: feature.id || null, name: feature.name || feature.id || 'candidate', lon: feature.lon, lat: feature.lat, water_score: feature.water_score || null, ts: new Date().toISOString() });
        saveAnnotations(anns);
        renderAnnotationsList();
      }

      function renderAnnotationsList() {
        const el = document.getElementById('annotationsList');
        const anns = loadAnnotations();
        if (!el) return;
        if (!anns.length) { el.textContent = 'None yet'; return; }
        el.innerHTML = anns.map(a => `<div class="ann-row"><b>${escapeHtml(a.name)}</b> <span class="score">${(a.water_score||'—')}</span></div>`).join('');
      }
      renderAnnotationsList();

      if (exportBtn) exportBtn.addEventListener('click', () => {
        const anns = loadAnnotations();
        const featuresGeo = anns.map(a => ({ type:'Feature', properties:{ id:a.id, name:a.name, water_score:a.water_score, ts:a.ts }, geometry:{ type:'Point', coordinates:[a.lon, a.lat] } }));
        const fc = { type:'FeatureCollection', features: featuresGeo };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'embiggen_annotations.geojson'; a.click(); URL.revokeObjectURL(url);
      });

      // --- Right panel detail rendering ---
      function showFeatureDetails(f) {
        const container = document.getElementById('featureDetails'); if (!container) return;
        const diam = f.diameter_m ? `${Math.round(f.diameter_m)} m (${(f.diameter_m/1000).toFixed(2)} km)` : '—';
        container.innerHTML = `<div class="detail-top"><h3>${escapeHtml(f.name || f.id)}</h3><div class="meta">ID: ${escapeHtml(String(f.id || '—'))}</div></div>
          <div class="scores" style="font-size:13px;line-height:1.5">
            <div>water_score: <b>${(f.water_score||0).toFixed(3)}</b></div>
            <div>PSR overlap: ${f.psr_overlap ? 'Yes' : 'No'}</div>
            <div>diameter: ${diam}</div>
            <div>spectral_mean: ${(f.spectral_mean==null? '—' : f.spectral_mean.toFixed(3))}</div>
            <div>hydrogen_mean: ${(f.hydrogen_mean==null? '—' : f.hydrogen_mean.toFixed(3))}</div>
            <div>depth_metric: ${(f.depth_metric==null? '—' : f.depth_metric.toFixed(3))}</div>
          </div>
          <div style="margin-top:8px"><button class="btn" id="detailAccept">Accept as annotation</button></div>`;
        const btn = document.getElementById('detailAccept'); if (btn) btn.onclick = () => { addAnnotation(f); toast('Annotation saved'); };
      }

      // --- layer radio handling ---
      const radios = document.querySelectorAll('input[name="layer"]');
      radios.forEach(r => r.addEventListener('change', e => {
        const v = e.target.value;
        map.removeLayer(layerVis); map.removeLayer(layerIR); map.removeLayer(layerElev); map.removeLayer(layerIndex);
        if (v === 'vis') map.addLayer(layerVis);
        else if (v === 'ir') map.addLayer(layerIR);
        else if (v === 'elev') map.addLayer(layerElev);
        else if (v === 'index') map.addLayer(layerIndex);
      }));

      // final toast
      toast('EmbiggenEye ready — features: ' + features.length);

      // expose internals for debugging
      window.EMBIGEN.map = map;
      window.EMBIGEN.mergedFeatures = features;
      window.EMBIGEN.renderFeatures = renderFeatures;
      window.EMBIGEN.getLatLonForFeature = (f) => [f.lat, f.lon];
      window.EMBIGEN.normalizeFeature = normalizeFeature;
      if (DEBUG) console.log('[EMBIGGEN] ready', { PAGE_BASE, TILE_PATHS, featuresLoaded: features.length });

    } catch (err) {
      console.error('App init failed:', err);
      toast('Initialization error — check console');
    }
  })();

})();
