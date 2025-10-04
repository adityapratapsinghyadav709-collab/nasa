// app.js — EmbiggenEye (robust, base-path aware, pixel/geo fallback)
// Replace your existing app.js with this file.

(() => {
  'use strict';

  // ---------- CONFIG ----------
  // If you run server from different folders (project root /docs / tiles), the PAGE_BASE logic below
  // will compute the correct prefix so tile URLs become '/tiles/...' or '/docs/tiles/...'.
  // If your features.json uses pixel x/y instead of lat/lon, fill IMAGE_GEOTIFF below:
  // IMAGE_GEOTIFF = {
  //   minLon: <left lon>,
  //   maxLon: <right lon>,
  //   minLat: <bottom lat>,
  //   maxLat: <top lat>,
  //   width: <image_pixel_width>,
  //   height: <image_pixel_height>
  // };
  // Coordinates mapping assumes x,y origin is top-left pixel (x to the right, y down).
  const IMAGE_GEOTIFF = null; // <-- set to object above if you have pixel coords and know bounds/size

  const DEBUG = true; // set true to log requested tile urls

  // Wait for DOMContentLoaded and Leaflet to be available
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

  // Compute page base (works if the page is at / or /docs/ or /foo/bar/index.html).
  function computePageBase() {
    let path = window.location.pathname || '/';
    // if path has filename, strip to folder
    if (path.indexOf('.') !== -1) {
      path = path.substring(0, path.lastIndexOf('/') + 1);
    } else if (!path.endsWith('/')) {
      path = path + '/';
    }
    // ensure starts with '/'
    if (!path.startsWith('/')) path = '/' + path;
    // Normalize: avoid double slashes later by trimming trailing slashes except single '/'
    if (path.length > 1 && path.endsWith('/')) path = path;
    return path;
  }

  // ---------- helpers ----------
  function toast(msg, timeout = 2800) {
    const t = document.getElementById('toast');
    if (!t) return console.log('Toast:', msg);
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

  // Map pixel x,y -> lat/lon using IMAGE_GEOTIFF config
  function pixelToLatLon(x, y) {
    if (!IMAGE_GEOTIFF) {
      throw new Error('IMAGE_GEOTIFF not configured — cannot map pixel x,y to lat/lon');
    }
    const { minLon, maxLon, minLat, maxLat, width, height } = IMAGE_GEOTIFF;
    // assume x [0..width], y [0..height], origin top-left
    const lon = minLon + (x / width) * (maxLon - minLon);
    // y increases downward in pixel coords; lat decreases downward; so map accordingly
    const lat = maxLat - (y / height) * (maxLat - minLat);
    return [lat, lon];
  }

  // ---------- main ----------
  (async function main() {
    try {
      await whenReady();
      await waitForLeaflet();

      // compute base so tiles work with different server roots
      const PAGE_BASE = computePageBase(); // e.g. '/' or '/docs/'
      if (DEBUG) console.log('PAGE_BASE=', PAGE_BASE);

      const TILE_PATHS = {
        vis: PAGE_BASE + 'tiles/layer_vis/{z}/{x}/{y}.png',
        ir: PAGE_BASE + 'tiles/layer_ir/{z}/{x}/{y}.png',
        elev: PAGE_BASE + 'tiles/layer_elev/{z}/{x}/{y}.png',
        index: PAGE_BASE + 'tiles/layer_index/{z}/{x}/{y}.png',
      };

      // expose for debugging
      window.EMBIGGEN = window.EMBIGGEN || {};
      window.EMBIGGEN.PAGE_BASE = PAGE_BASE;
      window.EMBIGGEN.TILE_PATHS = TILE_PATHS;

      // Map init (default view near lunar south pole for demo)
      const map = L.map('map', { preferCanvas: true }).setView([-89.6, -45.0], 2);
      // expose map for console
      window.map = map;

      // Optional debug tile wrapper - logs requested tile URLs (safe)
      function debugTileLayer(urlTemplate, options = {}) {
        const tl = L.tileLayer(urlTemplate, options);
        if (!DEBUG) return tl;
        const origCreate = tl.createTile.bind(tl);
        tl.createTile = function (coords, done) {
          const url = L.Util.template(this._url, coords);
          console.log('[tile-request]', url);
          // HEAD-check (non-blocking)
          fetch(url, { method: 'HEAD' }).then(r => {
            if (!r.ok) console.warn('[tile HEAD]', r.status, url);
          }).catch(e => console.warn('[tile HEAD error]', e, url));
          return origCreate(coords, done);
        };
        return tl;
      }

      // create tile layers
      const layerVis = debugTileLayer(TILE_PATHS.vis, { maxZoom: 5, tileSize: 256, noWrap: true });
      const layerIR = debugTileLayer(TILE_PATHS.ir, { maxZoom: 5, tileSize: 256, noWrap: true });
      const layerElev = debugTileLayer(TILE_PATHS.elev, { maxZoom: 5, tileSize: 256, noWrap: true });
      const layerIndex = debugTileLayer(TILE_PATHS.index, { maxZoom: 5, tileSize: 256, noWrap: true });

      // add visible by default
      layerVis.addTo(map);

      L.control.layers({ 'Visible': layerVis }, {}, { collapsed: true }).addTo(map);

      // cluster group
      const markerCluster = L.markerClusterGroup({ chunkedLoading: true });
      map.addLayer(markerCluster);

      // state
      let features = [];
      const featureMap = new Map();

      // load features.json
      let featuresLoaded = false;
      try {
        features = await loadJSON(PAGE_BASE + 'features.json');
        featuresLoaded = true;
        toast(`Loaded ${features.length} features`);
      } catch (err) {
        // try without PAGE_BASE (backward compatible)
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
        // prefer lat/lon fields in feature
        if (f.lat !== undefined && f.lon !== undefined) {
          return [f.lat, f.lon];
        }
        // sometimes property names are 'latitude'/'longitude'
        if (f.latitude !== undefined && f.longitude !== undefined) {
          return [f.latitude, f.longitude];
        }
        // fallback to pixel x,y mapping if available
        if ((f.x !== undefined && f.y !== undefined) || (f.pixel_x !== undefined && f.pixel_y !== undefined)) {
          const x = f.x !== undefined ? +f.x : +f.pixel_x;
          const y = f.y !== undefined ? +f.y : +f.pixel_y;
          if (!IMAGE_GEOTIFF) {
            // can't map pixel coords without IMAGE_GEOTIFF config
            return null;
          }
          try {
            return pixelToLatLon(x, y);
          } catch (e) {
            console.warn('pixel->latlon failed', e);
            return null;
          }
        }
        return null;
      }

      // Render features
      function renderFeatures(list) {
        markerCluster.clearLayers();
        featureMap.clear();
        const latlngs = [];
        for (const f of list) {
          const latlon = getLatLonForFeature(f);
          if (!latlon) {
            // skip or optionally log
            if (DEBUG) console.warn('Skipping feature (no lat/lon and no IMAGE_GEOTIFF):', f);
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

      // UI wiring
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

      // Suggestions (try suggestions.json, else top features)
      async function loadSuggestionsOrTopN(n = 10) {
        try {
          const s = await loadJSON(PAGE_BASE + 'suggestions.json');
          return s;
        } catch (e) {
          try { const s2 = await loadJSON('suggestions.json'); return s2; } catch (_) {
            // fallback: top N from features by water_score
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
