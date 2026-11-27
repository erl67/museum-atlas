const water = "#c6dbdb";
const paper = "#f3f0e2";
const label = ["get", "name"];
const byKind = (kind) => ["==", ["get", "kind"], kind];
const zoomStops = (...stops) => ["interpolate", ["linear"], ["zoom"], ...stops];

function localSource(filename) {
  return { type: "geojson", data: new URL(filename, import.meta.url).href };
}

// Local canvas glyphs use the same bundled web fonts as the record panel.
// Wait before MapLibre measures characters, since it caches each glyph face.
export async function loadMapFonts() {
  if (!document.fonts) return;
  await Promise.allSettled([
    document.fonts.load('400 16px "DM Sans"', "Atlas Ł"),
    document.fonts.load('400 16px "Spectral"', "Atlas"),
    document.fonts.load('italic 400 16px "Spectral Italic"', "Ocean"),
  ]);
}

function graticule() {
  const features = [];
  const addLine = (degree, coordinates) => {
    features.push({
      type: "Feature",
      properties: { interval: degree % 30 === 0 ? "major" : "minor" },
      geometry: { type: "LineString", coordinates },
    });
  };
  for (let longitude = -180; longitude < 180; longitude += 10) {
    addLine(longitude, [[longitude, -85], [longitude, 0], [longitude, 85]]);
  }
  for (let latitude = -80; latitude <= 80; latitude += 10) {
    addLine(latitude, [[-180, latitude], [-90, latitude], [0, latitude], [90, latitude], [180, latitude]]);
  }
  return { type: "geojson", data: { type: "FeatureCollection", features } };
}

function countryLabel(tier, minzoom) {
  return {
    id: `country-label-${tier}`,
    source: "labels",
    type: "symbol",
    minzoom,
    filter: ["all", byKind("country"), ["==", ["get", "tier"], tier]],
    layout: {
      "text-field": label,
      "text-font": ["DM Sans"],
      "text-size": zoomStops(1, 10, 3, 12.5, 5.5, 15),
      "text-max-width": 9,
      "text-letter-spacing": 0.035,
      "text-padding": 3,
      "symbol-sort-key": ["get", "rank"],
    },
    paint: {
      "text-color": "#566654",
      "text-halo-color": "#f2efdf",
      "text-halo-width": 1.25,
    },
  };
}

export function createStyle() {
  return {
    version: 8,
    name: "Museum Atlas",
    sources: {
      geography: {
        ...localSource("world.geojson"),
        attribution: "Natural Earth",
      },
      labels: localSource("labels.geojson"),
      provinces: localSource("provinces.geojson"),
      graticule: graticule(),
    },
    layers: [
      {
        id: "ocean",
        type: "background",
        paint: { "background-color": water },
      },
      {
        id: "outer-shore",
        source: "geography",
        type: "line",
        filter: byKind("coast"),
        layout: { "line-join": "round" },
        paint: {
          "line-color": "#abc5c3",
          "line-width": zoomStops(0, 4.2, 3, 8, 7, 10),
          "line-opacity": 0.9,
        },
      },
      {
        id: "nearshore-water",
        source: "geography",
        type: "line",
        filter: byKind("coast"),
        layout: { "line-join": "round" },
        paint: { "line-color": "#d9e7df", "line-width": zoomStops(0, 3.3, 3, 6.6, 7, 8.6) },
      },
      {
        id: "land",
        source: "geography",
        type: "fill",
        filter: byKind("land"),
        paint: {
          "fill-color": ["match", ["get", "tone"], 1, "#eeeddd", 2, "#f4efdf", 3, "#edf0e2",
            4, "#f3f0e2", 5, "#ecebdc", 6, "#f2eedf", 7, "#f0f0e3", paper],
          "fill-outline-color": "#c0c6b4",
        },
      },
      {
        id: "shoreline",
        source: "geography",
        type: "line",
        filter: byKind("coast"),
        paint: { "line-color": "#9cae9f", "line-width": zoomStops(0, 0.55, 5, 1.1) },
      },
      {
        id: "rivers",
        source: "geography",
        type: "line",
        filter: byKind("river"),
        minzoom: 1,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#acc9c7",
          "line-width": zoomStops(1, 0.45, 4, 1.05, 7, 1.6),
        },
      },
      {
        id: "lakes",
        source: "geography",
        type: "fill",
        filter: byKind("lake"),
        paint: { "fill-color": water, "fill-outline-color": "#a3bdb4" },
      },
      {
        id: "secondary-graticule",
        source: "graticule",
        type: "line",
        filter: ["==", ["get", "interval"], "minor"],
        minzoom: 2,
        paint: {
          "line-color": "#729a98",
          "line-width": 0.55,
          "line-opacity": zoomStops(2, 0.04, 3, 0.24, 7, 0.15),
          "line-dasharray": [2, 4],
        },
      },
      {
        id: "main-graticule",
        source: "graticule",
        type: "line",
        filter: ["==", ["get", "interval"], "major"],
        paint: { "line-color": "#83a3a0", "line-width": 0.65, "line-opacity": 0.35 },
      },
      {
        id: "state-province-lines",
        source: "provinces",
        type: "line",
        minzoom: 2.5,
        paint: {
          "line-color": "#aeb5a4",
          "line-width": zoomStops(2.5, 0.5, 5, 0.95),
          "line-opacity": zoomStops(2.5, 0.1, 3.5, 0.82),
          "line-dasharray": [3, 2],
        },
      },
      {
        id: "international-boundaries",
        source: "geography",
        type: "line",
        filter: byKind("border"),
        paint: { "line-color": "#afb5a3", "line-width": zoomStops(0, 0.55, 4, 0.95, 7, 1.35) },
      },
      {
        id: "province-names",
        source: "labels",
        type: "symbol",
        filter: byKind("province"),
        minzoom: 3.4,
        layout: {
          "text-field": label,
          "text-font": ["DM Sans"],
          "text-size": zoomStops(3.4, 10, 6, 13),
          "text-letter-spacing": 0.05,
          "text-max-width": 8,
          "text-padding": 4,
          "symbol-sort-key": ["get", "rank"],
        },
        paint: { "text-color": "#71816e", "text-halo-color": paper, "text-halo-width": 1.1 },
      },
      countryLabel(2, 3.4),
      countryLabel(1, 2.15),
      countryLabel(0, 1.15),
      {
        id: "sea-names",
        source: "labels",
        type: "symbol",
        filter: byKind("sea"),
        minzoom: 2.3,
        layout: {
          "text-field": label,
          "text-font": ["Spectral Italic"],
          "text-size": zoomStops(2.3, 12, 5, 15),
          "text-letter-spacing": 0.035,
          "text-padding": 4,
        },
        paint: { "text-color": "#628b8e", "text-halo-color": water, "text-halo-width": 1 },
      },
      {
        id: "ocean-names",
        source: "labels",
        type: "symbol",
        filter: byKind("ocean"),
        maxzoom: 5,
        layout: {
          "text-field": label,
          "text-font": ["Spectral Italic"],
          "text-size": zoomStops(0, 12, 1.3, 16, 3.4, 21),
          "text-letter-spacing": 0.08,
          "text-max-width": 14,
          "text-padding": 6,
        },
        paint: { "text-color": "#567f85", "text-halo-color": water, "text-halo-width": 1.2 },
      },
      {
        id: "continent-names",
        source: "labels",
        type: "symbol",
        filter: byKind("continent"),
        maxzoom: 2.8,
        layout: {
          "text-field": label,
          "text-font": ["Spectral"],
          "text-transform": "uppercase",
          "text-size": zoomStops(0, 10, 1.25, 14, 2.5, 18),
          "text-letter-spacing": 0.19,
          "text-max-width": 18,
          "text-padding": 5,
        },
        paint: {
          "text-color": "#687a66",
          "text-halo-color": paper,
          "text-halo-width": 1.4,
          "text-opacity": zoomStops(2.3, 1, 2.79, 0.2),
        },
      },
    ],
  };
}
