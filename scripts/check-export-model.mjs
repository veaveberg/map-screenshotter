import assert from "node:assert/strict";

import {
  createExportPlan,
  createPatternExportPlan,
  scaleStyleForExport,
  stepCanvasSize,
} from "../src/export-model.js";
import {
  cleanSuggestedName,
  createDownloadFilename,
  createNameSuggestions,
  distanceInMeters,
} from "../src/name-suggestions.js";
import { getMoscowMetroEnglishName } from "../src/moscow-metro-names.js";

const plan = createExportPlan({
  canvasSize: 1000,
  outputSize: 4000,
  devicePixelRatio: 2,
});

assert.deepEqual(plan, {
  outputSize: 4000,
  cssSize: 2000,
  styleScale: 2,
  zoomDelta: 1,
  ppi: 1000,
});

assert.equal(stepCanvasSize(960, "expand"), 1152);
assert.equal(stepCanvasSize(1152, "contract"), 960);
assert.equal(stepCanvasSize(6000, "expand"), 6000);
assert.equal(stepCanvasSize(128, "contract"), 128);
assert.throws(() => stepCanvasSize(960, "sideways"), /Canvas direction/);

const style = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "rail",
      type: "line",
      paint: {
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 16, 4],
        "line-gap-width": 2,
        "line-translate": [3, 5],
      },
    },
    {
      id: "labels",
      type: "symbol",
      layout: { "text-size": 14 },
      paint: { "text-halo-width": 1 },
    },
    {
      id: "default-circle",
      type: "circle",
    },
    {
      id: "building",
      type: "fill",
      source: "composite",
      "source-layer": "building",
      minzoom: 15,
      paint: {
        "fill-color": "#e0dbd9",
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 16, 1],
        "fill-outline-color": "#c0b4af",
      },
    },
  ],
};

const scaled = scaleStyleForExport(style, 2);

assert.deepEqual(scaled.layers[0].paint["line-width"], [
  "interpolate",
  ["linear"],
  ["zoom"],
  11,
  2,
  17,
  8,
]);
assert.equal(scaled.layers[0].paint["line-gap-width"], 4);
assert.deepEqual(scaled.layers[0].paint["line-translate"], [6, 10]);
assert.equal(scaled.layers[1].layout["text-size"], 28);
assert.equal(scaled.layers[1].layout["icon-size"], 2);
assert.equal(scaled.layers[1].paint["text-halo-width"], 2);
assert.equal(scaled.layers[2].paint["circle-radius"], 10);
assert.equal(style.layers[2].paint, undefined, "source style must not be mutated");
assert.equal(scaled.layers[3].paint["fill-outline-color"], undefined);
assert.deepEqual(scaled.layers[4], {
  id: "building__mapbox_screenshotter_outline",
  type: "line",
  source: "composite",
  "source-layer": "building",
  minzoom: 16,
  layout: {},
  paint: {
    "line-color": "#c0b4af",
    "line-width": 2 / 3,
    "line-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 17, 1],
  },
});

const patternStyle = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "cemetery",
      type: "fill",
      paint: { "fill-pattern": "cemeteryx2" },
    },
    {
      id: "conditional-pattern",
      type: "fill",
      paint: {
        "fill-pattern": ["match", ["get", "kind"], "trees", "wood", "cemeteryx2"],
      },
    },
  ],
};
const patternPlan = createPatternExportPlan(
  patternStyle,
  {
    cemeteryx2: { x: 154, y: 0, width: 77, height: 84, pixelRatio: 2 },
    wood: { x: 0, y: 0, width: 40, height: 40, pixelRatio: 2 },
  },
  2,
);

assert.deepEqual(
  patternPlan.images.map(({ sourceId, pixelRatio }) => ({ sourceId, pixelRatio })),
  [
    { sourceId: "cemeteryx2", pixelRatio: 1 },
    { sourceId: "wood", pixelRatio: 1 },
  ],
);
assert.equal(
  patternPlan.layerUpdates[0].value,
  "__mapbox_screenshotter_pattern__cemeteryx2",
);
assert.deepEqual(patternPlan.layerUpdates[1].value, [
  "match",
  ["get", "kind"],
  "trees",
  "__mapbox_screenshotter_pattern__wood",
  "__mapbox_screenshotter_pattern__cemeteryx2",
]);

assert.throws(
  () =>
    createExportPlan({
      canvasSize: 3000,
      outputSize: 9000,
      devicePixelRatio: 2,
    }),
  /exceeds the 8192 px browser-safe limit/,
);

assert.equal(cleanSuggestedName("Babushkinskaya Metro Station"), "Babushkinskaya");
assert.equal(cleanSuggestedName("Станция метро Бабушкинская"), "Бабушкинская");
assert.equal(cleanSuggestedName("Sheremetyevo International Airport"), "Sheremetyevo");
assert.equal(cleanSuggestedName("Yaroslavskiy Railway Terminal"), "Yaroslavskiy");
assert.equal(cleanSuggestedName("Kurskiy Vokzal"), "Kurskiy");
assert.equal(cleanSuggestedName("Meshchanskiy District"), "Meshchanskiy");
assert.equal(cleanSuggestedName("O'Hare Airport"), "O'Hare");
assert.equal(getMoscowMetroEnglishName("Савеловская"), "Savelovskaya");
assert.equal(getMoscowMetroEnglishName("Chistye prudy"), "Chistye Prudy");
assert.ok(Math.abs(distanceInMeters([0, 0], [0, 1]) - 111_195) < 2);

const nearbyNames = createNameSuggestions({
  origin: [37.63, 55.76],
  railFeatures: [
    {
      id: "metro",
      geometry: { coordinates: [37.631, 55.76] },
      properties: {
        name: "Babushkinskaya Metro Station",
        poi_category_ids: ["light_rail_station", "railway_station"],
        distance: 80,
      },
    },
    {
      id: "rail",
      geometry: { coordinates: [37.64, 55.76] },
      properties: {
        name: "Rizhsky Railway Station",
        poi_category_ids: ["railway_station"],
        distance: 600,
      },
    },
  ],
  airportFeatures: [
    {
      id: "near-airport",
      geometry: { coordinates: [37.63, 55.768] },
      properties: { name: "City Airport", distance: 900 },
    },
    {
      id: "far-airport",
      geometry: { coordinates: [37.63, 55.78] },
      properties: { name: "Far Airport", distance: 1_001 },
    },
    {
      id: "second-near-airport",
      geometry: { coordinates: [37.63, 55.7685] },
      properties: { name: "Airport Office", distance: 950 },
    },
  ],
  districtFeatures: [
    { id: "district", properties: { name: "Meshchanskiy District" } },
  ],
});

assert.deepEqual(nearbyNames.map(({ group, name }) => ({ group, name })), [
  { group: "Metro", name: "babushkinskaya" },
  { group: "Railway", name: "rizhsky" },
  { group: "Airport", name: "city" },
  { group: "District", name: "meshchanskiy" },
]);
assert.equal(createDownloadFilename({
  suggestionName: "Babushkinskaya Metro Station",
  namingEnabled: true,
  center: [37.630847, 55.766782],
  zoom: 15.61,
  bearing: 0,
  size: 3840,
}), "babushkinskaya-3840px.png");
assert.equal(createDownloadFilename({
  suggestionName: "O'Hare Airport",
  namingEnabled: true,
  center: [0, 0],
  zoom: 0,
  bearing: 0,
  size: 3840,
}), "ohare-3840px.png");
assert.equal(createDownloadFilename({
  suggestionName: "",
  namingEnabled: false,
  center: [37.630847, 55.766782],
  zoom: 15.61,
  bearing: 15,
  size: 3840,
}), "map-37.6308-55.7668-15.61-15-3840px.png");

console.log("Export model checks passed.");
