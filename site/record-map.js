import { createStyle, loadMapFonts } from './basemap/style.js';

export const layers = {
  eggs: { name: 'Eggs', color: '#ae5536' },
  types: { name: 'Types', color: '#236653' },
  fluids: { name: 'Fluids', color: '#497b9b' },
  skins: { name: 'Skins', color: '#996b21' },
};

export function positionKey([lon, lat]) {
  return [lon === 180 ? -180 : lon, lat].join(',');
}

export function visibleLocations(snapshot, enabled) {
  const locations = new Map();
  for (const layer of Object.keys(layers)) {
    if (!enabled.has(layer)) continue;
    for (const record of snapshot.layers[layer].records) {
      const key = positionKey(record.point);
      if (!locations.has(key)) locations.set(key, { key, point: record.point, members: [] });
      locations.get(key).members.push({ layer, record });
    }
  }
  return locations;
}

function markerImage(layer, multiple) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 48;
  const ctx = canvas.getContext('2d');
  ctx.translate(24, 24);
  if (multiple) {
    ctx.beginPath();
    ctx.arc(0, 0, 18.5, 0, Math.PI * 2);
    ctx.fillStyle = '#faf8ed';
    ctx.fill();
    ctx.strokeStyle = layers[layer].color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  ctx.beginPath();
  switch (layer) {
    case 'eggs': ctx.arc(0, 0, 11, 0, Math.PI * 2); break;
    case 'types': ctx.moveTo(0, -15); ctx.lineTo(15, 0); ctx.lineTo(0, 15); ctx.lineTo(-15, 0); break;
    case 'fluids': ctx.rect(-10.5, -10.5, 21, 21); break;
    case 'skins': ctx.moveTo(0, -14); ctx.lineTo(14, 11); ctx.lineTo(-14, 11); break;
  }
  ctx.closePath();
  ctx.fillStyle = layers[layer].color;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#fff9e6';
  ctx.stroke();
  return ctx.getImageData(0, 0, 48, 48);
}

function initialView(container) {
  const mobile = container.clientWidth <= 650;
  return {
    center: mobile ? [-52, 28] : [-12, 25],
    zoom: Math.max(mobile ? 0.8 : 0.6, Math.log2(container.clientWidth / 512)),
    bearing: 0, pitch: 0,
  };
}

const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function createRecordMap(container, onChoose, onCoordinates, onError) {
  await loadMapFonts();
  maplibregl.setWorkerUrl(new URL('./vendor/maplibre-gl-worker.js', import.meta.url).href);
  const map = new maplibregl.Map({
    container, style: createStyle(), ...initialView(container), attributionControl: false,
    renderWorldCopies: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    maxPitch: 0, maxZoom: 20,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 88, unit: 'metric' }), 'bottom-left');
  await new Promise((resolve, reject) => {
    map.once('load', resolve);
    map.once('error', event => reject(event.error));
  });
  map.on('error', event => onError(event.error));
  for (const layer of Object.keys(layers)) {
    map.addImage(layer, markerImage(layer, false), { pixelRatio: 2 });
    map.addImage(layer + '-shared', markerImage(layer, true), { pixelRatio: 2 });
  }
  map.addSource('catalogue', { type: 'geojson', data: emptyCollection(), maxzoom: 20 });
  map.addLayer({
    id: 'selection', type: 'circle', source: 'catalogue', filter: ['==', ['get', 'key'], ''],
    paint: { 'circle-radius': 15, 'circle-color': '#fffdfa', 'circle-opacity': 0.6,
      'circle-stroke-width': 2, 'circle-stroke-color': '#224e45' },
  });
  map.addLayer({
    id: 'specimens', type: 'symbol', source: 'catalogue',
    layout: {
      'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.44, 2, 0.59, 5, 0.9, 9, 1.1],
      'symbol-sort-key': ['get', 'order'],
    },
  });
  let locations = new Map();
  function replace(next) {
    locations = next;
    const data = emptyCollection();
    for (const { key, point, members } of locations.values()) {
      const first = members[0].layer;
      data.features.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: point },
        properties: { key, icon: first + (members.length > 1 ? '-shared' : ''), order: Object.keys(layers).indexOf(first) },
      });
    }
    map.getSource('catalogue').setData(data);
  }
  function nearest(pixel, radius) {
    const { x, y } = pixel;
    const box = [[x - radius, y - radius], [x + radius, y + radius]];
    let nearestGroup, distance = Infinity;
    for (const hit of map.queryRenderedFeatures(box, { layers: ['specimens'] })) {
      const group = locations.get(hit.properties.key);
      if (!group) continue;
      const candidate = map.project(group.point).dist(pixel);
      if (candidate < distance) {
        nearestGroup = group;
        distance = candidate;
      }
    }
    return nearestGroup;
  }
  map.on('click', event => {
    const group = nearest(event.point, matchMedia('(pointer: coarse)').matches ? 15 : 5);
    onChoose(group);
  });
  map.on('mousemove', event => {
    map.getCanvas().style.cursor = nearest(event.point, 3) ? 'pointer' : '';
    onCoordinates(event.lngLat);
  });
  map.on('moveend', () => onCoordinates(map.getCenter()));
  onCoordinates(map.getCenter());
  map.getCanvas().setAttribute('aria-label', 'Bird collection map. Arrow keys pan, plus and minus zoom, Enter opens the nearest visible location.');
  map.getCanvas().addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.repeat) return;
    event.preventDefault();
    const middle = map.project(map.getCenter());
    const bounds = map.getBounds();
    let closest, distance = Infinity;
    for (const group of locations.values()) {
      if (!bounds.contains(group.point)) continue;
      const candidate = map.project(group.point).dist(middle);
      if (candidate < distance) {
        closest = group;
        distance = candidate;
      }
    }
    if (closest) onChoose(closest);
  });
  document.getElementById('zoom-in').onclick = () => map.zoomIn({ duration: reducedMotion() ? 0 : 230 });
  document.getElementById('zoom-out').onclick = () => map.zoomOut({ duration: reducedMotion() ? 0 : 230 });
  document.getElementById('reset-view').onclick = () => map.easeTo({
    ...initialView(container), duration: reducedMotion() ? 0 : 420,
  });
  return { map, replace, select: key => map.setFilter('selection', ['==', ['get', 'key'], key || '']) };
}
