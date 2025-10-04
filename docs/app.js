// app.js — EmbiggenEye (robust, base-path aware, pixel/geo fallback)
// Behavior preserved from your original file; fixes: more robust PAGE_BASE detection,
// safer feature fetch fallback, clearer debug logs, small defensive guards.

(() => {
  'use strict';

  // ---------- CONFIG ----------
  // If your features.json uses pixel x/y instead of lat/lon, fill IMAGE_GEOTIFF like:
  // const IMAGE_GEOTIFF = {
  //   minLon: <left lon>,
  //   maxLon: <right lon>,
  //   minLat: <bottom lat>,
  //   maxLat: <top lat>,
  //   width: <image_pixel_width>,
  //   height: <image_pixel_height>
  // };
  // origin: top-left pixel (x -> right, y -> down)
  const IMAGE_GEOTIFF = null; // <-- set to object above if needed

  // Toggle debug logs (tile requests, warnings). Set to false for production.
  const DEBUG = true;

  // ---------- tiny utility helpers ----------
  function whenReady() {
    return new Promise((resolve) => {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => resolve());
      } else {
        resolve();
      }
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

  // Compute page base so assets work whether site is served from / or /repo/ or /docs/
  function computePageBase() {
    let path = window.location.pathname || '/';
    // if there's a filename, strip to folder
    if (path.indexOf('.') !== -1) {
      path = path.substring(0, path.lastIndexOf('/') + 1);
    } else if (!path.endsWith('/')) {
      path = path + '/';
    }
    if (!path.startsWith('/')) path = '/' + path;
    // keep trailing slash (do not collapse to empty)
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

  function scoreToColor(s) {
    s = Math.max(0, Math.min(1, (s == null ? 0 : s)));
    const r = Math.round(255 * Math.min(1, Math.max(0, (s - 0.5) * 2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5 - s) * 2)));
    const g = Math.round(255 * (1 - Math.abs(s - 0.5) * 2));
    return `rgb(${r},${g},${b})`;
  }

  function diameterToRadiusPx(diameter_m) {
    if (!diameter_m) return 8;
    const km = diameter_m / 1000;
    return Math.min(40, Math.max(6, 6 + Math.log10(km + 1) * 12));
  }

  function pixelToLatLon(x, y) {
    if (!IMAGE_GEOTIFF) {
      throw new Error('IMAGE_GEOTIFF not configured — cannot map pixel x,y to lat/lon');
    }
    const { minLon, maxLon, minLat, maxLat, width, height } = IMAGE_GEOTIFF;
    const lon = minLon + (x / width) * (maxLon - minLon);
    const lat = maxLat - (y / height) * (maxLat - minLat);
    return [lat, lon];
  }

  // ---------- main ----------
  (async function main() {
    try {
      await whenReady();
      await waitForLeaflet();

      const PAGE_BASE = computePageBase();
      if (DEBUG) console.log('[EMBIGGEN] PAGE_BASE =', PAGE_BASE);

      const TILE_PATHS = {
        vis: PAGE_BASE + 'tiles/layer_vis/{z}/{x}/{y}.png',
        ir: PAGE_BASE + 'tiles/layer_ir/{z}/{x}/{y}.png',
        elev: PAGE_BASE + 'tiles/layer_elev/{z}/{x}/{y}.png',
        index: PAGE_BASE + 'tiles/layer_index/{z}/{x}/{y}.png',
      };

      // expose tiny debug object
      window.EMBIGGEN = window.EMBIGGEN || {};
      window.EMBIGGEN.PAGE_BASE = PAGE_BASE;
      window.EMBIGGEN.TILE_PATHS = TILE_PATHS;

      // init map (center near south pole for demo)
      const map = L.map('map', { preferCanvas: true }).setView([-89.6, -45.0], 2);
      window.map = map;

      // debug tile layer builder — logs requested tile URLs when DEBUG true
      function debugTileLayer(urlTemplate, options = {}) {
        const tl = L.tileLayer(urlTemplate, options);
        if (!DEBUG) return tl;
        const origCreate = tl.createTile.bind(tl);
        tl.createTile = function (coords, done) {
          const url = L.Util.template(this._url, coords);
          console.log('[tile-request]', url);
          // non-blocking HEAD check
          fetch(url, { method: 'HEAD' }).then(r => {
            if (!r.ok) console.warn('[tile HEAD]', r.status, url);
          }).catch(e => console.warn('[tile HEAD error]', e, url));
          return origCreate(coords, done);
        };
        return tl;
      }

      const layerVis = debugTileLayer(TILE_PATHS.vis, { maxZoom: 5, tileSize: 256, noWrap: true });
      const layerIR = debugTileLayer(TILE_PATHS.ir, { maxZoom: 5, tileSize: 256, noWrap: true });
      const layerElev = debugTileLayer(TILE_PATHS.elev, { maxZoom: 5, tileSize: 256, noWrap: true });
      const layerIndex = debugTileLayer(TILE_PATHS.index, { maxZoom: 5, tileSize: 256, noWrap: true });

      // add visible by default
      layerVis.addTo(map);
      L.control.layers({ 'Visible': layerVis }, {}, { collapsed: true }).addTo(map);

      // marker cluster group
      const markerCluster = L.markerClusterGroup({ chunkedLoading: true });
      map.addLayer(markerCluster);

      // state
      let features = [];
      const featureMap = new Map();
      let featuresLoaded = false;

      // Try loading features.json with PAGE_BASE then fallback to bare filename.
      try {
        features = await loadJSON(PAGE_BASE + 'features.json');
        featuresLoaded = true;
        toast(`Loaded ${features.length} features`);
      } catch (err) {
        if (DEBUG) console.warn('[EMBIGGEN] load with PAGE_BASE failed:', err.message);
        try {
          features = await loadJSON('features.json');
          featuresLoaded = true;
          toast(`Loaded ${features.length} features`);
        } catch (err2) {
          console.warn('Could not load features.json with PAGE_BASE or without. Check file path.');
          toast('features.json not found (check path)');
          features = [];
        }
      }

      function getLatLonForFeature(f) {
        if (f.lat !== undefined && f.lon !== undefined) return [f.lat, f.lon];
        if (f.latitude !== undefined && f.longitude !== undefined) return [f.latitude, f.longitude];
        // support pixel coords: x,y or pixel_x,pixel_y
        const hasXY = (f.x !== undefined && f.y !== undefined) || (f.pixel_x !== undefined && f.pixel_y !== undefined);
        if (hasXY) {
          const x = (f.x !== undefined) ? +f.x : +f.pixel_x;
          const y = (f.y !== undefined) ? +f.y : +f.pixel_y;
          if (!IMAGE_GEOTIFF) {
            if (DEBUG) console.warn('Feature has pixel x/y but IMAGE_GEOTIFF not set; skipping feature', f);
            return null;
          }
          try {
            return pixelToLatLon(x, y);
          } catch (e) {
            if (DEBUG) console.warn('pixelToLatLon failed', e);
            return null;
          }
        }
        return null;
      }

      // render features onto map & cluster
      function renderFeatures(list) {
        markerCluster.clearLayers();
        featureMap.clear();
        const latlngs = [];
        for (const f of list) {
          const latlon = getLatLonForFeature(f);
          if (!latlon) {
            if (DEBUG) console.warn('Skipping feature (no lat/lon):', f);
            continue;
          }
          const [lat, lon] = latlon;
          const score = (f.water_score !== undefined && f.water_score !== null) ? +f.water_score : 0;
          const color = scoreToColor(score);
          const radius = diameterToRadiusPx(f.diameter_m);
          const marker = L.circleMarker([lat, lon], { radius, color, weight: 1.5, fillOpacity: 0.65 });

          const popupHtml = `<div class='popup-card'>
            <h4>${f.name || f.id || 'Feature'}</h4>
            <table class='popup-table'>
              <tr><td>water_score</td><td>${(f.water_score || 0).toFixed(2)}</td></tr>
              <tr><td>PSR overlap</td><td>${f.psr_overlap || 0}</td></tr>
              <tr><td>spectral_mean</td><td>${(f.spectral_mean == null ? '—' : f.spectral_mean.toFixed(3))}</td></tr>
              <tr><td>hydrogen_mean</td><td>${(f.hydrogen_mean == null ? '—' : f.hydrogen_mean.toFixed(3))}</td></tr>
              <tr><td>depth_metric</td><td>${(f.depth_metric == null ? '—' : f.depth_metric.toFixed(3))}</td></tr>
            </table>
            <div style='margin-top:6px'><button class='btn small accept-btn'>Accept</button></div>
          </div>`;

          marker.bindPopup(popupHtml, { minWidth: 200 });
          marker.on('popupopen', e => {
            const btn = e.popup.getElement().querySelector('.accept-btn');
            if (btn) btn.onclick = () => { addAnnotation(f); toast('Annotation saved'); e.popup._close(); };
            showFeatureDetails(f);
          });

          marker.on('click', () => showFeatureDetails(f));

          markerCluster.addLayer(marker);
          featureMap.set(f.id || `${f.name}_${Math.random().toString(36).slice(2, 8)}`, { feature: f, marker });
          latlngs.push([lat, lon]);
        }

        if (latlngs.length) {
          try {
            map.fitBounds(latlngs, { maxZoom: 5, padding: [40, 40] });
          } catch (e) {
            if (DEBUG) console.warn('fitBounds failed', e);
          }
        }
      }

      renderFeatures(features);

      // --- UI bindings ---
      const searchInput = document.getElementById('searchInput');
      const searchBtn = document.getElementById('searchBtn');
      const suggestBtn = document.getElementById('suggestBtn');
      const exportBtn = document.getElementById('exportBtn');

      function doSearch() {
        const q = (searchInput && searchInput.value || '').trim().toLowerCase();
        if (!q) { toast('Type a crater name or id'); return; }
        const found = features.find(f => (f.name && f.name.toLowerCase().includes(q)) || (f.id && (f.id + '').toLowerCase() === q));
        if (!found) { toast('No matching crater found'); return; }
        const val = getLatLonForFeature(found);
        if (!val) { toast('Found crater but no lat/lon available'); return; }
        const [lat, lon] = val;
        map.setView([lat, lon], 4);
        const item = featureMap.get(found.id) || Array.from(featureMap.values()).find(v => v.feature === found);
        if (item) item.marker.openPopup();
      }

      if (searchBtn) searchBtn.addEventListener('click', doSearch);
      if (searchInput) searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

      // Suggestions loader (PAGE_BASE aware)
      async function loadSuggestionsOrTopN(n = 10) {
        try {
          return await loadJSON(PAGE_BASE + 'suggestions.json');
        } catch (e) {
          if (DEBUG) console.warn('suggestions with PAGE_BASE failed:', e.message);
          try { return await loadJSON('suggestions.json'); } catch (_) {
            return features.slice().sort((a, b) => (b.water_score || 0) - (a.water_score || 0)).slice(0, n);
          }
        }
      }

      let suggestionLayer = L.layerGroup().addTo(map);

      async function showSuggestions(list) {
        suggestionLayer.clearLayers();
        for (const s of list) {
          const latlon = getLatLonForFeature(s);
          if (!latlon) continue;
          const m = L.circleMarker(latlon, { radius: 12, color: '#ff7a00', weight: 2, fillOpacity: 0.25 }).addTo(suggestionLayer);
          m.bindPopup(`<b>${s.name || s.id || 'Candidate'}</b><br/>water_score: ${(s.water_score || 0).toFixed(2)}<br/><button class='btn small accept-btn'>Accept</button>`);
          m.on('popupopen', e => {
            const btn = e.popup.getElement().querySelector('.accept-btn'); if (btn) btn.onclick = () => { addAnnotation(s); toast('Suggestion accepted'); e.popup._close(); };
          });
        }
        toast(`${list.length} suggestions shown`);
      }

      if (suggestBtn) {
        suggestBtn.addEventListener('click', async () => {
          const list = await loadSuggestionsOrTopN(10);
          await showSuggestions(list);
        });
      }

      // annotations (localStorage)
      const ANNOTATION_KEY = 'embiggen_annotations_v1';
      function loadAnnotations() { try { return JSON.parse(localStorage.getItem(ANNOTATION_KEY) || '[]'); } catch (e) { return []; } }
      function saveAnnotations(a) { localStorage.setItem(ANNOTATION_KEY, JSON.stringify(a)); }
      function addAnnotation(feature) {
        const anns = loadAnnotations();
        anns.push({ id: feature.id || null, name: feature.name || feature.id || 'candidate', lon: feature.lon, lat: feature.lat, water_score: feature.water_score || null, ts: new Date().toISOString() });
        saveAnnotations(anns); renderAnnotationsList();
      }

      function renderAnnotationsList() {
        const el = document.getElementById('annotationsList');
        const anns = loadAnnotations();
        if (!el) return;
        if (!anns.length) { el.textContent = 'None yet'; return; }
        el.innerHTML = anns.map(a => `<div class='ann-row'><b>${a.name}</b> <span class='score'>${(a.water_score || '—')}</span></div>`).join('');
      }
      renderAnnotationsList();

      if (exportBtn) exportBtn.addEventListener('click', () => {
        const anns = loadAnnotations();
        const featuresGeo = anns.map(a => ({ type: 'Feature', properties: { id: a.id, name: a.name, water_score: a.water_score, ts: a.ts }, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } }));
        const fc = { type: 'FeatureCollection', features: featuresGeo };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'embiggen_annotations.geojson'; a.click(); URL.revokeObjectURL(url);
      });

      // right panel details
      function showFeatureDetails(f) {
        const container = document.getElementById('featureDetails'); if (!container) return;
        container.innerHTML = `<div class='detail-top'><h3>${f.name || f.id}</h3><div class='meta'>ID: ${f.id || '—'}</div></div>
          <div class='scores'>
            <div>water_score: <b>${(f.water_score || 0).toFixed(3)}</b></div>
            <div>PSR overlap: ${f.psr_overlap || 0}</div>
            <div>spectral_mean: ${(f.spectral_mean == null ? '—' : f.spectral_mean.toFixed(3))}</div>
            <div>hydrogen_mean: ${(f.hydrogen_mean == null ? '—' : f.hydrogen_mean.toFixed(3))}</div>
            <div>depth_metric: ${(f.depth_metric == null ? '—' : f.depth_metric.toFixed(3))}</div>
          </div>
          <div style='margin-top:8px'><button class='btn' id='detailAccept'>Accept as annotation</button></div>`;
        const btn = document.getElementById('detailAccept'); if (btn) btn.onclick = () => { addAnnotation(f); toast('Annotation saved'); };
      }

      // layer radio handling (index.html radios)
      const radios = document.querySelectorAll('input[name="layer"]');
      radios.forEach(r => r.addEventListener('change', e => {
        const v = e.target.value;
        map.removeLayer(layerVis); map.removeLayer(layerIR); map.removeLayer(layerElev); map.removeLayer(layerIndex);
        if (v === 'vis') map.addLayer(layerVis);
        else if (v === 'ir') map.addLayer(layerIR);
        else if (v === 'elev') map.addLayer(layerElev);
        else if (v === 'index') map.addLayer(layerIndex);
      }));

      // final small notification
      toast('EmbiggenEye ready — features: ' + (featuresLoaded ? features.length : 0));

      // expose some internals for debugging in console
      window.EMBIGGEN.map = map;
      window.EMBIGGEN.renderFeatures = renderFeatures;
      window.EMBIGGEN.getLatLonForFeature = getLatLonForFeature;
      window.EMBIGGEN.PAGE_BASE = PAGE_BASE;
      window.EMBIGGEN.TILE_PATHS = TILE_PATHS;
      if (DEBUG) console.log('EMBIGGEN debug:', window.EMBIGGEN);

    } catch (err) {
      console.error('App init failed:', err);
      toast('Initialization error — check console');
    }
  })();

})();
