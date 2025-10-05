// app.js — EmbiggenEye (merged + recovered behavior)
// - Preserves your original logic (pixel spread heuristic, accept/annotate, popups)
// - Adds robust multi-part feature loading, PSR overlay, blank-tile fallback
// - Map uses canvas renderer (preferCanvas: true)
// - Put this file in docs/app.js (or adjust PAGE_BASE)
// NOTE: Edit CONFIG below to match your repo (paths, IMAGE_GEOTIFF).
(() => {
  'use strict';

  // ================== CONFIG ==================
  // Edit these paths to match your repo. Paths are relative to the docs/ root (PAGE_BASE auto-detected).
  const CONFIG = {
    FEATURE_PARTS: ['features_part1.json', 'features_part2.json', 'features_part3.json'], // tried in order
    FEATURE_SINGLE: 'features.json',
    SUGGESTIONS: 'suggestions.json',
    PSR_GEOJSON: 'static/psr_clean.geojson',
    TILE_VIS: 'tiles/layer_vis/{z}/{x}/{y}.png',   // visible tiles
    BLANK_TILE: 'static/blank-tile.png',
    FALLBACK_IMAGE: 'static/fallback.png', // optional single-image fallback
    MAX_MAP_ZOOM: 5,
    DEBUG: false,
    // If you have an accurately georeferenced image and want pixel->lonlat mapping,
    // set IMAGE_GEOTIFF to an object with minLon,maxLon,minLat,maxLat,width,height
    // Example: { minLon: -45, maxLon: 45, minLat: -90, maxLat: 0, width: 60000, height: 40000 }
    IMAGE_GEOTIFF: null,
  };
  // ============================================

  // ---------- tiny utilities ----------
  const log = (...args) => { if (CONFIG.DEBUG) console.log(...args); };
  const el = id => document.getElementById(id);
  function toast(msg, t = 2200) {
    const box = el('toast');
    if (!box) { console.log('TOAST:', msg); return; }
    box.textContent = msg;
    box.classList.add('visible');
    clearTimeout(box._timer);
    box._timer = setTimeout(() => box.classList.remove('visible'), t);
  }
  function whenReady() {
    return new Promise(r => {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => r());
      else r();
    });
  }
  function waitForLeaflet(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        if (window.L) return resolve();
        if (Date.now() - start > timeout) return reject(new Error('Leaflet not found'));
        setTimeout(check, 50);
      })();
    });
  }
  async function loadJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  }
  function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  function escapeHtml(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  // compute page base (attempt to make relative paths robust)
  function computePageBase() {
    let path = window.location.pathname || '/';
    // If page is e.g. /repo/docs/index.html -> want '/repo/docs/'
    if (path.indexOf('.') !== -1) path = path.substring(0, path.lastIndexOf('/') + 1);
    else if (!path.endsWith('/')) path = path + '/';
    if (!path.startsWith('/')) path = '/' + path;
    return path;
  }

  // ---------- normalization helpers (preserve old tolerant behavior) ----------
  function normalizeFeature(f) {
    // f may be GeoJSON Feature or plain props
    const props = f.properties || f;
    const out = Object.assign({}, props);

    // lat/lon detection: many naming combos used across pipelines
    let lat = toNum(out.lat ?? out.latitude ?? out.y ?? out.pixel_y);
    let lon = toNum(out.lon ?? out.longitude ?? out.x ?? out.pixel_x);

    // if geometry present (GeoJSON Feature)
    if ((lat == null || lon == null) && f.geometry && Array.isArray(f.geometry.coordinates)) {
      const cc = f.geometry.coordinates;
      if (cc.length >= 2) {
        lon = toNum(cc[0]);
        lat = toNum(cc[1]);
      }
    }

    // support Robbins 0..360 lon -> convert to -180..180 for Leaflet
    if (lon != null && lon > 180) lon = ((lon + 180) % 360) - 180;

    // diameter: try many fields (meters preferred)
    let dm = toNum(out.diameter_m ?? out.diameter ?? out.diam ?? out.DIAM_CIRC_IMG ?? out.DIAM_ELLI_MAJOR_IMG);
    if (dm == null) {
      const dk = toNum(out.diameter_km ?? out.diam_km);
      if (dk != null) dm = dk * 1000;
    } else {
      // heuristics: if value looks like km (small), convert
      if (dm > 0 && dm < 100) dm = dm * 1000; // assume km if less than 100
    }

    out.lat = lat;
    out.lon = lon;
    out.diameter_m = dm;
    out.id = out.id !== undefined ? String(out.id) : (out.CRATER_ID ? String(out.CRATER_ID) : (out.name ? String(out.name) : 'f_' + Math.random().toString(36).slice(2, 9)));
    out.name = out.name || out.id;

    out.water_score = toNum(out.water_score ?? out.score ?? out.waterScore) ?? 0;
    out.psr_overlap = (out.psr_overlap !== undefined) ? Boolean(out.psr_overlap) : Boolean(out.psr);
    out.spectral_mean = (out.spectral_mean !== undefined) ? toNum(out.spectral_mean) : null;
    out.hydrogen_mean = (out.hydrogen_mean !== undefined) ? toNum(out.hydrogen_mean) : null;
    out.depth_metric = (out.depth_metric !== undefined) ? toNum(out.depth_metric) : null;

    // keep any pixel coords present too, to support spreading heuristic
    out.x = out.x ?? out.pixel_x ?? out.col ?? null;
    out.y = out.y ?? out.pixel_y ?? out.row ?? null;

    return out;
  }
  function toNum(v) { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

  // ---------- pixel -> lat/lon functions (preserve & re-add IMAGE_GEOTIFF mapping) ----------
  function pixelToLatLon(x, y) {
    // If user provided precise IMAGE_GEOTIFF mapping, use it
    const cfg = CONFIG.IMAGE_GEOTIFF;
    if (!cfg) return null;
    const { minLon, maxLon, minLat, maxLat, width, height } = cfg;
    if ([minLon, maxLon, minLat, maxLat, width, height].some(v => v === undefined || v === null)) return null;
    const lon = minLon + (x / width) * (maxLon - minLon);
    const lat = maxLat - (y / height) * (maxLat - minLat);
    return [lat, lon];
  }

  // ---------- UI & Map bootstrap ----------
  (async function init() {
    try {
      await whenReady();
      await waitForLeaflet();

      const PAGE_BASE = computePageBase();
      window.EMBIGEN = window.EMBIGEN || {};
      window.EMBIGEN.PAGE_BASE = PAGE_BASE;

      // tile templates
      const TILE_VIS = PAGE_BASE + CONFIG.TILE_VIS;
      const BLANK_TILE = PAGE_BASE + CONFIG.BLANK_TILE;
      const FALLBACK_IMAGE = PAGE_BASE + CONFIG.FALLBACK_IMAGE;

      // create map (canvas renderer)
      const map = L.map('map', { preferCanvas: true, worldCopyJump: false, minZoom: 0, maxZoom: CONFIG.MAX_MAP_ZOOM, attributionControl: false }).setView([-85, 45], 2);
      window.map = map;

      // tile layer
      const visLayer = L.tileLayer(TILE_VIS, { maxZoom: CONFIG.MAX_MAP_ZOOM, errorTileUrl: BLANK_TILE, noWrap: true }).addTo(map);

      // layer control (minimal)
      L.control.layers({ 'Visible': visLayer }, {}, { collapsed: true }).addTo(map);

      // cluster & layers
      const markerCluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false });
      const rawMarkerLayer = L.layerGroup();
      const annotationsLayer = L.layerGroup().addTo(map);
      const suggestionLayer = L.layerGroup().addTo(map);

      map.addLayer(markerCluster);

      // single highlight circle (like old app)
      let highlight = null;
      function clearHighlight() { if (highlight) { try { map.removeLayer(highlight); } catch (e) { } highlight = null; } }
      function showHighlightAt(lat, lon, diameter_m, color = '#00ffff') {
        clearHighlight();
        const rpx = diameterMetersToRadiusPx(diameter_m || 1000);
        // Use a geo-radius that is visually reasonable; old behavior used a small fixed radius — keep moderate radius (5km)
        const radius = Math.max(2000, Math.min(50000, (diameter_m || 1000)));
        highlight = L.circle([lat, lon], { radius, weight: 2.2, color, fillColor: color, fillOpacity: 0.12 }).addTo(map);
        try { map.setView([lat, lon], Math.min(CONFIG.MAX_MAP_ZOOM, Math.max(3, map.getZoom()))); } catch (e) { }
      }

      // helper: color & radius
      function scoreToColor(s) {
        s = Math.max(0, Math.min(1, (s == null ? 0 : +s)));
        const r = Math.round(255 * Math.min(1, Math.max(0, (s - 0.5) * 2)));
        const b = Math.round(255 * Math.min(1, Math.max(0, (0.5 - s) * 2)));
        const g = Math.round(255 * (1 - Math.abs(s - 0.5) * 2));
        return `rgb(${r},${g},${b})`;
      }
      function diameterMetersToRadiusPx(d) {
        if (!d || isNaN(d)) return 8;
        const km = Math.max(0.001, d / 1000);
        return Math.min(48, Math.max(6, 6 + Math.log10(km + 1) * 14));
      }

      // ---------- Load & normalize features (multi-part support) ----------
      let rawFeatures = [];
      let loadedCount = 0;

      // try parts
      for (const p of CONFIG.FEATURE_PARTS) {
        try {
          const url = PAGE_BASE + p;
          const part = await loadJSON(url);
          if (Array.isArray(part)) {
            rawFeatures = rawFeatures.concat(part);
            loadedCount += part.length;
            log('loaded part', p, part.length);
          } else if (part && Array.isArray(part.features)) {
            rawFeatures = rawFeatures.concat(part.features);
            loadedCount += part.features.length;
            log('loaded part geojson', p, part.features.length);
          }
        } catch (e) {
          // not found or error -> skip
          log('no part', p, e.message);
        }
      }

      // fallback to single
      if (loadedCount === 0) {
        try {
          const s = await loadJSON(PAGE_BASE + CONFIG.FEATURE_SINGLE);
          if (Array.isArray(s)) rawFeatures = rawFeatures.concat(s);
          else if (s && Array.isArray(s.features)) rawFeatures = rawFeatures.concat(s.features);
          log('loaded single features.json', rawFeatures.length);
        } catch (e) {
          // try bare filename (if PAGE_BASE trick failed)
          try {
            const s2 = await loadJSON(CONFIG.FEATURE_SINGLE);
            if (Array.isArray(s2)) rawFeatures = rawFeatures.concat(s2);
            else if (s2 && Array.isArray(s2.features)) rawFeatures = rawFeatures.concat(s2.features);
            log('loaded single fallback', rawFeatures.length);
          } catch (e2) {
            log('no features found', e2 ? e2.message : '');
          }
        }
      }

      // If still empty -> warn and keep minimal behavior
      if (!rawFeatures.length) {
        toast('No features found. Put features_part*.json or features.json in docs/');
      }

      // normalize features (preserve original properties where possible)
      let features = rawFeatures.map(f => normalizeFeature(f));

      // ---------- Pixel-only features detection and "spread" heuristic (preserved from old app) ----------
      // If many features lack lat/lon but have pixel x/y (from catalog -> pixel conversion), produce temporary lat/lon for UI inspection.
      function detectPixelLikeAndSpread(featuresList) {
        // Count features with lat/lon
        const total = featuresList.length;
        const latCount = featuresList.filter(f => f.lat != null && f.lon != null).length;
        const xCount = featuresList.filter(f => f.x != null || f.pixel_x != null).length;
        const yCount = featuresList.filter(f => f.y != null || f.pixel_y != null).length;

        // If most features are pixel-only and there are enough x/y values to compute spread, do it.
        if (latCount / Math.max(1, total) < 0.2 && xCount > Math.max(10, total * 0.05) && yCount > Math.max(10, total * 0.05)) {
          log('Detected pixel-like features; applying spread heuristic.');

          // gather x/y arrays
          const xs = featuresList.map(f => toNum(f.x ?? f.pixel_x)).filter(n => n != null);
          const ys = featuresList.map(f => toNum(f.y ?? f.pixel_y)).filter(n => n != null);
          if (!xs.length || !ys.length) return false;

          const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);

          // If IMAGE_GEOTIFF present, map using precise geotransform; otherwise map into current map bounds
          const mapBounds = map.getBounds();
          let minLat = -89.95, maxLat = -72.0, minLon = -180, maxLon = 180;
          // If map already has reasonable bounds, use them
          if (mapBounds && isFinite(mapBounds.getSouth())) {
            minLat = mapBounds.getSouth(); maxLat = mapBounds.getNorth();
            minLon = mapBounds.getWest(); maxLon = mapBounds.getEast();
          }

          // Spread: produce lat/lon for each pixel-feature
          features = featuresList.map(orig => {
            const f = Object.assign({}, orig);
            const x = toNum(orig.x ?? orig.pixel_x), y = toNum(orig.y ?? orig.pixel_y);
            if (x == null || y == null) return f;

            // If IMAGE_GEOTIFF mapping exists, use it to get accurate lat/lon
            if (CONFIG.IMAGE_GEOTIFF) {
              const mapped = pixelToLatLon(x, y);
              if (mapped) {
                f.lat = mapped[0];
                f.lon = mapped[1];
                f._pixel_spread = true;
                return f;
              }
            }

            // Heuristic spread across current map bounds
            const lon = minLon + ((x - minX) / (maxX - minX || 1)) * (maxLon - minLon);
            const lat = maxLat - ((y - minY) / (maxY - minY || 1)) * (maxLat - minLat);
            f.lat = lat; f.lon = lon; f._pixel_spread = true;
            return f;
          });
          return true;
        }
        return false;
      }

      detectPixelLikeAndSpread(features);

      // Persist loaded features to global for debugging
      window.EMBIGEN.features = features;

      toast(`Loaded ${features.length} features`);

      // ---------- feature rendering (clustered markers, popups, accept flow preserved) ----------
      const featureMap = new Map(); // id -> { feature, marker }

      function makeMarkerForFeature(f) {
        // small circle marker; uses Canvas renderer automatically due to preferCanvas:true
        const marker = L.circleMarker([f.lat, f.lon], {
          radius: Math.max(5, (f.diameter_m ? diameterMetersToRadiusPx(f.diameter_m) / 6 : 6)),
          color: scoreToColor(f.water_score || 0),
          weight: 1,
          fillOpacity: 0.8
        });

        marker.featureId = f.id;
        marker.on('click', (e) => {
          // Build popup (preserve Accept and Comment behavior)
          const popupHtml = buildPopupHtml(f);
          marker.bindPopup(popupHtml, { minWidth: 220 }).openPopup();
          // highlight circle
          showHighlightAt(f.lat, f.lon, f.diameter_m || 1000);
        });

        return marker;
      }

      function buildPopupHtml(f) {
        const diamDisplay = f.diameter_m ? `${Math.round(f.diameter_m)} m (${(f.diameter_m / 1000).toFixed(2)} km)` : '—';
        const score = (f.water_score != null) ? f.water_score : 0;
        const spectral = (f.spectral_mean != null) ? Number(f.spectral_mean).toFixed(3) : '—';
        const hydrogen = (f.hydrogen_mean != null) ? Number(f.hydrogen_mean).toFixed(3) : '—';
        const depth = (f.depth_metric != null) ? Number(f.depth_metric).toFixed(3) : '—';
        const psr = f.psr_overlap ? 'Yes' : 'No';
        return `
          <div class="popup-card" style="color:#dfeaf5">
            <h4 style="margin:0 0 6px 0;">${escapeHtml(f.name || f.id || 'Feature')}</h4>
            <table class="popup-table" style="width:100%;font-size:13px;">
              <tr><td>water_score</td><td style="text-align:right;"><b>${Number(score).toFixed(3)}</b></td></tr>
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

      // render all features into cluster (and basic fit bounds)
      function renderFeatures(list) {
        markerCluster.clearLayers();
        rawMarkerLayer.clearLayers();
        featureMap.clear();
        for (const f of list) {
          if (f.lat == null || f.lon == null) {
            if (CONFIG.DEBUG) console.warn('skip feature no coords', f.id);
            continue;
          }
          const marker = makeMarkerForFeature(f);
          markerCluster.addLayer(marker);
          rawMarkerLayer.addLayer(marker);
          featureMap.set(String(f.id), { feature: f, marker });
        }
        if (map.hasLayer(rawMarkerLayer)) map.removeLayer(rawMarkerLayer);
        if (!map.hasLayer(markerCluster)) map.addLayer(markerCluster);

        // fit bounds lightly (safeguard)
        const latlngs = list.filter(f => f.lat != null && f.lon != null).map(f => [f.lat, f.lon]);
        if (latlngs.length) {
          try { map.fitBounds(latlngs, { maxZoom: Math.min(CONFIG.MAX_MAP_ZOOM, 4), padding: [40, 40] }); } catch (e) { log('fitBounds err', e); }
        }
      }

      // ---------- popup accept/comment wiring (delegated) ----------
      map.on('popupopen', (e) => {
        const popupEl = e.popup.getElement();
        if (!popupEl) return;
        const acceptBtn = popupEl.querySelector('.accept-btn');
        if (acceptBtn) {
          acceptBtn.onclick = () => {
            // find name in popup (first h4)
            const title = popupEl.querySelector('h4')?.textContent || null;
            if (title) {
              const f = features.find(x => String(x.name) === title || String(x.id) === title);
              if (f) addAnnotationIfNew(f);
            }
            try { if (e.popup && e.popup._source && typeof e.popup._source.closePopup === 'function') e.popup._source.closePopup(); else map.closePopup(); } catch (err) { }
          };
        }
        const commentBtn = popupEl.querySelector('.comment-btn');
        if (commentBtn) {
          commentBtn.onclick = () => {
            const note = prompt('Add a comment (saved locally):');
            if (note !== null) {
              toast('Comment saved locally (attached to feature in memory).');
              // attempt to find feature id attribute
              const fid = commentBtn.getAttribute('data-id');
              if (fid) {
                const entry = featureMap.get(String(fid));
                if (entry) entry.feature._local_comment = note;
              }
            }
          };
        }
      });

      // initial render
      renderFeatures(features);

      // ---------- annotations (localStorage) ----------
      const ANNOT_KEY = 'embiggen_annotations_v1';
      function loadAnnotations() { try { return JSON.parse(localStorage.getItem(ANNOT_KEY) || '[]'); } catch (e) { return []; } }
      function saveAnnotations(a) { localStorage.setItem(ANNOT_KEY, JSON.stringify(a)); }
      function renderAnnotationsList() {
        const elA = el('annotationsList'); if (!elA) return;
        const anns = loadAnnotations();
        if (!anns.length) { elA.textContent = 'None yet'; return; }
        elA.innerHTML = anns.map(a => `<div class="ann-row"><b>${escapeHtml(a.name)}</b> <span class="score">${(a.water_score || '—')}</span></div>`).join('');
      }
      renderAnnotationsList();

      function addAnnotationIfNew(feature) {
        const f = feature;
        if (!f || f.lat == null || f.lon == null) { toast('Cannot annotate (no coords)'); return; }
        const anns = loadAnnotations();
        if (anns.find(a => a.id && f.id && a.id === f.id) || anns.find(a => a.lat === f.lat && a.lon === f.lon)) {
          toast('Already annotated');
          return;
        }
        const ann = { id: f.id || null, name: f.name || f.id || 'candidate', lon: f.lon, lat: f.lat, water_score: f.water_score || null, ts: new Date().toISOString(), comment: f._local_comment || null };
        anns.push(ann); saveAnnotations(anns); renderAnnotationsList();
        // add visual marker
        const m = L.circleMarker([f.lat, f.lon], { radius: 10, color: '#2ee6a1', weight: 1.4, fillOpacity: 0.6 }).addTo(annotationsLayer).bindPopup(`<b>${escapeHtml(f.name)}</b><br/>annotation`);
        if (!map.hasLayer(annotationsLayer)) map.addLayer(annotationsLayer);
      }

      // export annotations
      el('exportBtn')?.addEventListener('click', () => {
        const anns = loadAnnotations();
        const featuresGeo = anns.map(a => ({ type: 'Feature', properties: { id: a.id, name: a.name, water_score: a.water_score, ts: a.ts, comment: a.comment || null }, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } }));
        const fc = { type: 'FeatureCollection', features: featuresGeo };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'embiggen_annotations.geojson'; a.click(); URL.revokeObjectURL(url);
      });

      // ---------- suggestions (try suggestions.json then fallback to top features) ----------
      async function loadSuggestionsOrTopN(n = 10) {
        try {
          const s = await loadJSON(PAGE_BASE + CONFIG.SUGGESTIONS);
          if (s && s.suggestions) return s.suggestions;
          if (Array.isArray(s)) return s;
        } catch (e) { /* ignore */ }
        // fallback: top n features ordered by water_score
        const ordered = (window.EMBIGEN.features || []).slice().sort((a, b) => (b.water_score || 0) - (a.water_score || 0)).slice(0, n);
        return ordered;
      }

      el('suggestBtn')?.addEventListener('click', async () => {
        suggestionLayer.clearLayers();
        const list = await loadSuggestionsOrTopN(20);
        for (const s of list) {
          const nf = (typeof s === 'object' && (s.lat !== undefined || s.geometry)) ? normalizeFeature(s) : s;
          if (nf.lat == null || nf.lon == null) continue;
          const m = L.circleMarker([nf.lat, nf.lon], { radius: 12, color: '#ff7a00', weight: 2, fillOpacity: 0.25 }).addTo(suggestionLayer);
          m.bindPopup(`<b>${escapeHtml(nf.name || nf.id)}</b><br/>score:${(nf.water_score || 0).toFixed ? (nf.water_score || 0).toFixed(3) : (nf.water_score || 0)}<br/><button class="btn small accept-btn">Accept</button>`);
          m.on('popupopen', e => {
            const pop = e.popup.getElement();
            if (!pop) return;
            const btn = pop.querySelector('.accept-btn');
            if (btn) btn.onclick = () => { addAnnotationIfNew(nf); try { if (e.popup && e.popup._source && typeof e.popup._source.closePopup === 'function') e.popup._source.closePopup(); else map.closePopup(); } catch (_) { } };
          });
        }
        if (!map.hasLayer(suggestionLayer)) map.addLayer(suggestionLayer);
        toast(`${list.length} suggestions shown`);
      });

      // ---------- search control ----------
      const searchInput = el('searchInput'), searchBtn = el('searchBtn');
      function doSearch() {
        const q = (searchInput && searchInput.value || '').trim().toLowerCase();
        if (!q) { toast('Type a crater name or id'); return; }
        const found = features.find(f => (f.name && f.name.toLowerCase().includes(q)) || (String(f.id).toLowerCase() === q));
        if (!found) { toast('No matching crater found'); return; }
        // open feature if rendered
        const entry = featureMap.get(String(found.id));
        if (entry && entry.marker) {
          entry.marker.fire('click'); entry.marker.openPopup();
        } else {
          // highlight at guessed coords
          if (found.lat != null && found.lon != null) showHighlightAt(found.lat, found.lon, found.diameter_m || 1000);
        }
      }
      searchBtn?.addEventListener('click', doSearch);
      searchInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

      // ---------- PSR overlay (visual only) ----------
      try {
        const psr = await loadJSON(PAGE_BASE + CONFIG.PSR_GEOJSON);
        if (psr && psr.type === 'FeatureCollection') {
          const psrLayer = L.geoJSON(psr, { style: { color: '#99f3ff', weight: 1.0, fillOpacity: 0.06 } }).addTo(map);
          // optional toggle UI could be added later
        }
      } catch (e) { log('PSR not loaded', e.message); }

      // ---------- Permalink handling ----------
      function setPermalink({ lat, lon, z, layer, id }) {
        const params = new URLSearchParams();
        if (lat != null) params.set('lat', lat.toFixed(6));
        if (lon != null) params.set('lon', lon.toFixed(6));
        if (z != null) params.set('z', z);
        if (layer) params.set('layer', layer);
        if (id) params.set('id', id);
        const h = '#' + params.toString();
        history.replaceState(null, '', window.location.pathname + h);
      }
      function readPermalink() {
        if (!location.hash) return null;
        const q = location.hash.replace(/^#/, '');
        const params = new URLSearchParams(q);
        const out = {};
        if (params.has('lat') && params.has('lon')) out.lat = safeNum(params.get('lat')), out.lon = safeNum(params.get('lon'));
        if (params.has('z')) out.z = parseInt(params.get('z'));
        if (params.has('layer')) out.layer = params.get('layer');
        if (params.has('id')) out.id = params.get('id');
        return out;
      }

      // If user clicks a feature, update permalink
      map.on('popupopen', e => {
        const latlng = e.popup.getLatLng();
        if (!latlng) return;
        setPermalink({ lat: latlng.lat, lon: latlng.lng, z: map.getZoom() });
      });

      // apply permalink if present (after loading)
      setTimeout(() => {
        const p = readPermalink();
        if (p) {
          if (p.layer) {
            const radios = document.querySelectorAll('input[name="layer"]');
            radios.forEach(r => { if (r.value === p.layer) r.checked = true; });
          }
          if (p.lat != null && p.lon != null) {
            map.setView([p.lat, p.lon], p.z || 3);
            if (p.id) {
              const entry = featureMap.get(String(p.id));
              if (entry) entry.marker.fire('click');
            }
          } else if (p.id) {
            const entry = featureMap.get(String(p.id));
            if (entry) entry.marker.fire('click');
          }
        }
      }, 700);

      // ---------- final: expose internals for debugging & finish UI wiring ----------
      window.EMBIGEN.featureMap = featureMap;
      window.EMBIGEN.features = features;
      window.EMBIGEN.annotationsLayer = annotationsLayer;
      window.EMBIGEN.map = map;

      renderAnnotationsList();

      toast('EmbiggenEye ready — click a marker to inspect');

    } catch (err) {
      console.error('App init failed:', err);
      try { toast('Initialization error — check console'); } catch (e) { }
    }
  })();

  // ---------- small helpers reused ----------
  function scoreToColor(s) {
    s = Math.max(0, Math.min(1, (s == null ? 0 : +s)));
    const r = Math.round(255 * Math.min(1, Math.max(0, (s - 0.5) * 2)));
    const b = Math.round(255 * Math.min(1, Math.max(0, (0.5 - s) * 2)));
    const g = Math.round(255 * (1 - Math.abs(s - 0.5) * 2));
    return `rgb(${r},${g},${b})`;
  }
  function diameterMetersToRadiusPx(d) {
    if (!d || isNaN(d)) return 8;
    const km = Math.max(0.001, d / 1000);
    return Math.min(48, Math.max(6, 6 + Math.log10(km + 1) * 14));
  }

})(); // end IIFE
