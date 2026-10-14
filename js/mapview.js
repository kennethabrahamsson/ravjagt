// Kortet: MapLibre (tegnes på grafikchippen) med eget mørkt udtryk, højde- og dybdekurver,
// kysten i farver, markører og turens spor. Resten af appen taler kun med dette modul
// og bruger [breddegrad, længdegrad] som i resten af koden – MapLibre selv bruger [lon, lat].
//
// Data: OpenFreeMap (land, vand, veje, navne – gratis, ingen nøgle),
//       Terrarium-højdemodellen på AWS (land og havbund – åbne data),
//       maplibre-contour tegner kurverne ud fra højdemodellen på telefonen.

/* global maplibregl, mlcontour */

const ll = (p) => [p[1], p[0]];
// MapLibre flytter markører med transform; animationer skal derfor ligge på et indre element
function pinEl(cls) {
  const outer = document.createElement('div');
  const inner = document.createElement('div');
  inner.className = cls;
  outer.append(inner);
  return { outer, inner };
}
const COLOR_IDLE = '#5b6b70';

export function createMap(el, { onSpotClick, onDragStart, onFindClick } = {}) {
  const dem = new mlcontour.DemSource({
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding: 'terrarium', maxzoom: 13, worker: true,
  });
  dem.setupMaplibre(maplibregl);

  const map = new maplibregl.Map({
    container: el,
    bounds: [[8.0, 54.55], [12.75, 57.78]],
    attributionControl: false,
    dragRotate: false, pitchWithRotate: false, touchPitch: false,
    maxZoom: 17.5, minZoom: 5,
    style: style(dem),
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> · Højdemodel: Mapzen/AWS · Luftfoto: Esri',
  }), 'bottom-left');
  if (onDragStart) map.on('dragstart', onDragStart);

  const ready = new Promise((res) => map.once('load', res));
  const markers = { best: [], me: null, start: null, finds: [] };

  ready.then(() => {
    // Kildeangivelsen starter foldet sammen (ⓘ)
    el.querySelector?.('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    map.on('click', 'coast-hit', (e) => { const f = e.features?.[0]; if (f && onSpotClick) onSpotClick(f.properties.sid); });
    map.on('mouseenter', 'coast-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'coast-hit', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', 'past-finds', (e) => { const f = e.features?.[0]; if (f && onFindClick) onFindClick(f.properties); });
  });

  const api = {
    map, ready,

    /** Kysten: alle strækninger (åben kyst farves, resten tynde grå) og høfder/moler */
    async setCoast(spots, trapLines) {
      await ready;
      const features = spots.map((s, i) => ({
        type: 'Feature', id: i,
        properties: { sid: s.id, open: s.open ? 1 : 0, r: s.region },
        geometry: { type: 'LineString', coordinates: s.line.map(ll) },
      }));
      map.getSource('coast').setData({ type: 'FeatureCollection', features });
      map.getSource('traps').setData({ type: 'FeatureCollection', features: trapLines.map((ln) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ln.map(ll) } })) });
      api._spots = spots;
      if (api._lastStyle) api.styleCoast(...api._lastStyle); // farverne kan være sat, før kortet var klar
    },

    /** Farver: items = [{ i, color, on }] for åben kyst; region 'v' | 'o' | null skjuler resten af landet */
    styleCoast(items, region) {
      api._lastStyle = [items, region];
      if (!map.getSource('coast') || !api._spots) return;
      for (const { i, color, on } of items) map.setFeatureState({ source: 'coast', id: i }, { color, on });
      const inRegion = region ? ['==', ['get', 'r'], region] : true;
      map.setFilter('coast-closed', ['all', ['==', ['get', 'open'], 0], inRegion]);
      for (const id of ['coast-glow', 'coast-line', 'coast-hit']) map.setFilter(id, ['all', ['==', ['get', 'open'], 1], inRegion]);
    },

    /** De tre bedste steder som nummererede markører */
    setBest(list) {
      markers.best.forEach((m) => m.remove());
      markers.best = list.map((b, n) => {
        const { outer, inner } = pinEl(`bestPin ${b.level}`);
        inner.style.setProperty('--d', `${n * 90}ms`);
        inner.textContent = n + 1;
        outer.addEventListener('click', (e) => { e.stopPropagation(); b.onClick(); });
        return new maplibregl.Marker({ element: outer }).setLngLat(ll(b.pos)).addTo(map);
      });
    },

    /** Din position med nøjagtighed */
    setMe(pos, acc) {
      if (!markers.me) {
        markers.me = new maplibregl.Marker({ element: pinEl('me').outer }).setLngLat(ll(pos)).addTo(map);
      } else markers.me.setLngLat(ll(pos));
      ready.then(() => map.getSource('acc').setData(circle(pos, acc)));
    },

    /** Turen: start, spor (stykker uden huller), linje hjem og fund */
    setTrip(trip, parts) {
      markers.start?.remove(); markers.start = null;
      markers.finds.forEach((m) => m.remove()); markers.finds = [];
      ready.then(() => {
        map.getSource('track').setData(lines(trip ? parts : []));
        map.getSource('home').setData(lines([]));
      });
      if (!trip) return;
      markers.start = new maplibregl.Marker({ element: pinEl('startPin').outer, anchor: 'bottom' }).setLngLat(ll(trip.start)).addTo(map);
      trip.findPts.forEach((f) => api.addFind(f));
    },
    /** Alle tidligere fund: [{ lat, lon, t }] */
    setPastFinds(list) {
      const data = { type: 'FeatureCollection', features: list.map((f) => ({ type: 'Feature', properties: { t: f.t, n: f.n }, geometry: { type: 'Point', coordinates: [f.lon, f.lat] } })) };
      ready.then(() => map.getSource('pastFinds').setData(data));
    },
    updateTrack(parts) { ready.then(() => map.getSource('track').setData(lines(parts))); },
    setHome(a, b) { ready.then(() => map.getSource('home').setData(lines([[a, b]]))); },
    addFind(f) {
      markers.finds.push(new maplibregl.Marker({ element: pinEl('findPin').outer }).setLngLat([f[1], f[0]]).addTo(map));
    },

    /** Centrér et punkt i den synlige del mellem toplinje og bundark */
    focus(pos, zoom, top = 0, bottom = 0, animate = false) {
      const opts = { center: ll(pos), zoom: zoom ?? map.getZoom(), padding: { top, bottom, left: 0, right: 0 } };
      animate ? map.easeTo({ ...opts, duration: 600 }) : map.jumpTo(opts);
    },
    fit(points, top = 0, bottom = 0) {
      if (!points.length) return;
      let w = 180, s = 90, e = -180, n = -90;
      for (const [la, lo] of points) { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); }
      // Nulstil den afstand, focus() har sat – ellers lægges den oveni, og kortet kan ikke passe og flytter sig ikke
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      map.fitBounds([[w, s], [e, n]], { padding: { top: top + 12, bottom: bottom + 12, left: 16, right: 60 }, duration: 600 });
    },
    getZoom: () => map.getZoom(),
    resize: () => map.resize(),

    /** Natlys: luftfotoet dæmpes kraftigt, så skærmen lyser mindst muligt */
    setNight(on) {
      ready.then(() => map.setPaintProperty('foto', 'raster-brightness-max', on ? 0.4 : 0.8));
    },

    /** Kort eller luftfoto */
    setLayer(name) {
      ready.then(() => {
        const foto = name === 'foto';
        map.setLayoutProperty('foto', 'visibility', foto ? 'visible' : 'none');
        for (const id of ['depth', 'height', 'depth-labels', 'shade']) map.setLayoutProperty(id, 'visibility', foto ? 'none' : 'visible');
      });
    },
  };
  return api;
}

const lines = (parts) => ({
  type: 'Feature', properties: {},
  geometry: { type: 'MultiLineString', coordinates: parts.filter((p) => p.length > 1).map((p) => p.map(ll)) },
});

function circle(pos, radius, n = 48) {
  const [lat, lon] = pos;
  const coords = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * 2 * Math.PI;
    coords.push([lon + (radius * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (radius * Math.cos(a)) / 110574]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } };
}

const W = (z9, z11, z13, z15) => ['interpolate', ['linear'], ['zoom'], 6, z9 * 0.5, 9, z9, 11, z11, 13, z13, 15, z15];
// Bredde efter zoom, forskellig for kyst i og uden for filteret (zoom-interpolationen skal ligge yderst)
const ON = ['boolean', ['feature-state', 'on'], true];
const WC = (on, off) => ['interpolate', ['linear'], ['zoom'],
  6, ['case', ON, on[0] * 0.5, off[0] * 0.5], 9, ['case', ON, on[0], off[0]], 11, ['case', ON, on[1], off[1]],
  13, ['case', ON, on[2], off[2]], 15, ['case', ON, on[3], off[3]]];
const EMPTY = { type: 'FeatureCollection', features: [] };

function style(dem) {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      foto: { type: 'raster', tileSize: 256, maxzoom: 19, tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
      dem: { type: 'raster-dem', tiles: [dem.sharedDemProtocolUrl], encoding: 'terrarium', tileSize: 256, maxzoom: 13 },
      contours: {
        type: 'vector', maxzoom: 15,
        tiles: [dem.contourProtocolUrl({
          // [lille kurve, stor kurve] i meter pr. zoom – også under havet (negative højder)
          thresholds: { 9: [10, 50], 10: [5, 20], 11: [2, 10], 12: [1, 5], 13: [1, 5] },
          elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours',
        })],
      },
      coast: { type: 'geojson', data: EMPTY },
      traps: { type: 'geojson', data: EMPTY },
      track: { type: 'geojson', data: EMPTY },
      pastFinds: { type: 'geojson', data: EMPTY },
      home: { type: 'geojson', data: EMPTY },
      acc: { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': '#151517' } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#08080a' } },
      { id: 'shade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.3, 'hillshade-shadow-color': '#000', 'hillshade-highlight-color': '#2c2c30', 'hillshade-accent-color': '#000' } },
      { id: 'foto', type: 'raster', source: 'foto', layout: { visibility: 'none' }, paint: { 'raster-brightness-max': 0.8, 'raster-saturation': -0.15 } },
      { id: 'roads', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 10, paint: { 'line-color': '#2a2a2e', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 15, 1.6] } },
      { id: 'depth', type: 'line', source: 'contours', 'source-layer': 'contours', filter: ['<', ['get', 'ele'], 0],
        paint: { 'line-color': '#5f8fb5', 'line-opacity': ['match', ['get', 'level'], 1, 0.5, 0.22], 'line-width': ['match', ['get', 'level'], 1, 1, 0.6] } },
      { id: 'height', type: 'line', source: 'contours', 'source-layer': 'contours', filter: ['>', ['get', 'ele'], 0],
        paint: { 'line-color': '#f5f5f2', 'line-opacity': ['match', ['get', 'level'], 1, 0.34, 0.13], 'line-width': ['match', ['get', 'level'], 1, 0.9, 0.5] } },
      { id: 'coastline', type: 'line', source: 'omt', 'source-layer': 'water', paint: { 'line-color': '#f5f5f2', 'line-opacity': 0.3, 'line-width': 0.7 } },
      { id: 'depth-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 10.5, filter: ['all', ['<', ['get', 'ele'], 0], ['==', ['get', 'level'], 1]],
        layout: { 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['*', -1, ['get', 'ele']]], ' m'], 'text-font': ['Noto Sans Regular'], 'text-size': 10 },
        paint: { 'text-color': '#5f8fb5', 'text-halo-color': '#08080a', 'text-halo-width': 1.5 } },
      { id: 'places', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 8,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 13] },
        paint: { 'text-color': '#8e8e93', 'text-halo-color': '#0a0a0b', 'text-halo-width': 1.2 } },

      // Kysten: lukket kyst tynd og grå, ravkyst med glød i farven (feature-state 'color' og 'on')
      { id: 'coast-closed', type: 'line', source: 'coast', filter: ['==', ['get', 'open'], 0], paint: { 'line-color': '#8e8e93', 'line-opacity': 0.25, 'line-width': 1.1 } },
      { id: 'coast-glow', type: 'line', source: 'coast', filter: ['==', ['get', 'open'], 1], layout: { 'line-cap': 'round' },
        paint: { 'line-color': ['coalesce', ['feature-state', 'color'], COLOR_IDLE], 'line-blur': 4, 'line-width': W(8, 16, 22, 28),
          'line-opacity': ['case', ['boolean', ['feature-state', 'on'], true], 0.2, 0] } },
      { id: 'coast-line', type: 'line', source: 'coast', filter: ['==', ['get', 'open'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['case', ['boolean', ['feature-state', 'on'], true], ['coalesce', ['feature-state', 'color'], COLOR_IDLE], '#8e8e93'],
          'line-width': WC([3, 5, 7, 9], [1.2, 1.5, 2, 2.5]),
          'line-opacity': ['case', ['boolean', ['feature-state', 'on'], true], 0.95, 0.35] } },
      { id: 'coast-hit', type: 'line', source: 'coast', filter: ['==', ['get', 'open'], 1], paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 24 } },
      { id: 'traps', type: 'line', source: 'traps', minzoom: 13, paint: { 'line-color': '#f5f5f2', 'line-opacity': 0.75, 'line-width': 2 } },

      // Tidligere fund: små rav-prikker, der bliver større, når man zoomer ind
      // Mørk skygge + hvid ring, så prikken skiller sig ud fra en gul eller grøn kyst
      { id: 'past-finds-shadow', type: 'circle', source: 'pastFinds', paint: { 'circle-color': '#000', 'circle-opacity': 0.55, 'circle-blur': 0.6, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 7, 14, 13] } },
      { id: 'past-finds', type: 'circle', source: 'pastFinds', paint: { 'circle-color': '#ffb72b', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 14, 2.5], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 14, 7] } },

      // Din position og turen
      { id: 'acc', type: 'fill', source: 'acc', paint: { 'fill-color': '#4aa3ff', 'fill-opacity': 0.08 } },
      { id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': '#4aa3ff', 'line-opacity': 0.35, 'line-width': 1 } },
      { id: 'home', type: 'line', source: 'home', paint: { 'line-color': '#ffb72b', 'line-width': 2, 'line-dasharray': [2, 3], 'line-opacity': 0.85 } },
      { id: 'track-glow', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffb72b', 'line-width': 16, 'line-blur': 6, 'line-opacity': 0.3 } },
      { id: 'track', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffc94d', 'line-width': 4 } },
    ],
  };
}
