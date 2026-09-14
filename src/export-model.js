export const EXPORT_INCHES = 4;
export const MAX_EXPORT_SIZE = 8192;
export const MIN_CANVAS_SIZE = 128;
export const MAX_CANVAS_SIZE = 6000;
export const CANVAS_SCALE_STEP = 1.2;

const PATTERN_PROPERTIES = ["fill-pattern", "line-pattern"];
const EXPORT_PATTERN_PREFIX = "__mapbox_screenshotter_pattern__";
const EXPORT_OUTLINE_SUFFIX = "__mapbox_screenshotter_outline";
const FILL_OUTLINE_WIDTH = 1 / 3;

const SCALAR_PROPERTIES = {
  circle: {
    paint: {
      "circle-radius": 5,
      "circle-stroke-width": 0,
    },
  },
  heatmap: {
    paint: {
      "heatmap-radius": 30,
    },
  },
  line: {
    paint: {
      "line-blur": 0,
      "line-gap-width": 0,
      "line-offset": 0,
      "line-width": 1,
    },
  },
  symbol: {
    layout: {
      "icon-padding": 2,
      "icon-size": 1,
      "symbol-spacing": 250,
      "text-padding": 2,
      "text-size": 16,
    },
    paint: {
      "icon-halo-blur": 0,
      "icon-halo-width": 0,
      "text-halo-blur": 0,
      "text-halo-width": 0,
    },
  },
};

const ARRAY_PROPERTIES = {
  circle: { paint: ["circle-translate"] },
  fill: { paint: ["fill-translate"] },
  "fill-extrusion": { paint: ["fill-extrusion-translate"] },
  line: { paint: ["line-translate"] },
  symbol: {
    layout: ["icon-text-fit-padding"],
    paint: ["icon-translate", "text-translate"],
  },
};

function scaleLegacyFunction(value, scale) {
  return {
    ...value,
    ...(typeof value.default === "number" ? { default: value.default * scale } : {}),
    stops: value.stops.map(([stop, output]) => [
      stop,
      typeof output === "number" ? output * scale : output,
    ]),
  };
}

export function scaleScalarValue(value, scale) {
  if (typeof value === "number") {
    return value * scale;
  }

  if (value && !Array.isArray(value) && Array.isArray(value.stops)) {
    return scaleLegacyFunction(value, scale);
  }

  if (Array.isArray(value) && expressionContainsZoom(value)) {
    return scaleZoomExpression(value, scale);
  }

  return ["*", value, scale];
}

function expressionContainsZoom(value) {
  return Array.isArray(value) && (
    value[0] === "zoom" || value.some((entry) => expressionContainsZoom(entry))
  );
}

function scaleExpressionOutput(value, scale) {
  return typeof value === "number" ? value * scale : ["*", value, scale];
}

function scaleZoomExpression(value, scale) {
  const scaled = structuredClone(value);

  if (scaled[0] === "interpolate") {
    for (let index = 4; index < scaled.length; index += 2) {
      scaled[index] = scaleExpressionOutput(scaled[index], scale);
    }
    return scaled;
  }

  if (scaled[0] === "step") {
    scaled[2] = scaleExpressionOutput(scaled[2], scale);
    for (let index = 4; index < scaled.length; index += 2) {
      scaled[index] = scaleExpressionOutput(scaled[index], scale);
    }
    return scaled;
  }

  throw new TypeError("Zoom-based style values must use a top-level step or interpolate expression.");
}

function shiftZoomExpression(value, zoomDelta) {
  if (!expressionContainsZoom(value)) {
    return value;
  }

  const shifted = structuredClone(value);

  if (shifted[0] !== "step" && shifted[0] !== "interpolate") {
    throw new TypeError("Zoom-based style values must use a top-level step or interpolate expression.");
  }

  for (let index = 3; index < shifted.length; index += 2) {
    shifted[index] += zoomDelta;
  }

  return shifted;
}

function scaleArrayValue(value, scale) {
  if (!Array.isArray(value) || typeof value[0] === "string") {
    return value;
  }

  return value.map((entry) => (typeof entry === "number" ? entry * scale : entry));
}

function scaleLayerSection(layer, sectionName, scalarRules, arrayRules, scale) {
  if (!layer[sectionName] && !scalarRules && !arrayRules) {
    return;
  }

  const zoomDelta = Math.log2(scale);
  const section = { ...(layer[sectionName] ?? {}) };

  for (const [property, value] of Object.entries(section)) {
    section[property] = shiftZoomExpression(value, zoomDelta);
  }

  if (!scalarRules && !arrayRules) {
    layer[sectionName] = section;
    return;
  }

  for (const [property, defaultValue] of Object.entries(scalarRules ?? {})) {
    section[property] = scaleScalarValue(section[property] ?? defaultValue, scale);
  }

  for (const property of arrayRules ?? []) {
    if (section[property] !== undefined) {
      section[property] = scaleArrayValue(section[property], scale);
    }
  }

  layer[sectionName] = section;
}

export function scaleStyleForExport(style, scale) {
  const scaledStyle = structuredClone(style);
  const zoomDelta = Math.log2(scale);
  const scaledLayers = [];

  for (const layer of scaledStyle.layers ?? []) {
    const scalarRules = SCALAR_PROPERTIES[layer.type] ?? {};
    const arrayRules = ARRAY_PROPERTIES[layer.type] ?? {};

    scaleLayerSection(layer, "layout", scalarRules.layout, arrayRules.layout, scale);
    scaleLayerSection(layer, "paint", scalarRules.paint, arrayRules.paint, scale);

    if (layer.minzoom !== undefined) {
      layer.minzoom = Math.max(0, Math.min(24, layer.minzoom + zoomDelta));
    }
    if (layer.maxzoom !== undefined) {
      layer.maxzoom = Math.max(0, Math.min(24, layer.maxzoom + zoomDelta));
    }

    scaledLayers.push(layer);

    const outlineColor = layer.type === "fill"
      ? layer.paint?.["fill-outline-color"]
      : undefined;
    if (outlineColor === undefined) {
      continue;
    }

    delete layer.paint["fill-outline-color"];
    const { paint, layout, ...sharedLayer } = layer;
    const outlinePaint = {
      "line-color": outlineColor,
      "line-width": scale * FILL_OUTLINE_WIDTH,
    };
    if (paint["fill-opacity"] !== undefined) {
      outlinePaint["line-opacity"] = paint["fill-opacity"];
    }

    scaledLayers.push({
      ...sharedLayer,
      id: `${layer.id}${EXPORT_OUTLINE_SUFFIX}`,
      type: "line",
      layout: layout?.visibility ? { visibility: layout.visibility } : {},
      paint: outlinePaint,
    });
  }

  scaledStyle.layers = scaledLayers;

  return scaledStyle;
}

function collectSpriteNames(value, availableNames, foundNames) {
  if (typeof value === "string") {
    if (availableNames.has(value)) {
      foundNames.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSpriteNames(entry, availableNames, foundNames);
    }
  }
}

function replaceSpriteNames(value, imageIds) {
  if (typeof value === "string") {
    return imageIds.get(value) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => replaceSpriteNames(entry, imageIds));
  }

  return value;
}

export function createPatternExportPlan(style, spriteMetadata, scale) {
  const availableNames = new Set(Object.keys(spriteMetadata));
  const usedNames = new Set();

  for (const layer of style.layers ?? []) {
    for (const property of PATTERN_PROPERTIES) {
      const value = layer.paint?.[property];
      if (value !== undefined) {
        collectSpriteNames(value, availableNames, usedNames);
      }
    }
  }

  const imageIds = new Map(
    [...usedNames].map((name) => [name, `${EXPORT_PATTERN_PREFIX}${name}`]),
  );
  const layerUpdates = [];

  for (const layer of style.layers ?? []) {
    for (const property of PATTERN_PROPERTIES) {
      const value = layer.paint?.[property];
      if (value === undefined) {
        continue;
      }

      const names = new Set();
      collectSpriteNames(value, availableNames, names);
      if (names.size > 0) {
        layerUpdates.push({
          layerId: layer.id,
          property,
          value: replaceSpriteNames(value, imageIds),
        });
      }
    }
  }

  return {
    images: [...usedNames].map((sourceId) => ({
      sourceId,
      exportId: imageIds.get(sourceId),
      metadata: spriteMetadata[sourceId],
      pixelRatio: spriteMetadata[sourceId].pixelRatio / scale,
    })),
    layerUpdates,
  };
}

export function createExportPlan({ canvasSize, outputSize, devicePixelRatio }) {
  const roundedOutputSize = Math.round(outputSize);

  if (roundedOutputSize > MAX_EXPORT_SIZE) {
    throw new RangeError(
      `The requested ${roundedOutputSize} × ${roundedOutputSize} export exceeds the ${MAX_EXPORT_SIZE} px browser-safe limit.`,
    );
  }

  const pixelRatio = Math.max(1, devicePixelRatio || 1);
  const cssSize = roundedOutputSize / pixelRatio;
  const styleScale = cssSize / canvasSize;

  return {
    outputSize: roundedOutputSize,
    cssSize,
    styleScale,
    zoomDelta: Math.log2(styleScale),
    ppi: Math.round(roundedOutputSize / EXPORT_INCHES),
  };
}

export function stepCanvasSize(canvasSize, direction) {
  if (direction !== "expand" && direction !== "contract") {
    throw new TypeError('Canvas direction must be "expand" or "contract".');
  }

  const factor = direction === "expand" ? CANVAS_SCALE_STEP : 1 / CANVAS_SCALE_STEP;
  return Math.max(
    MIN_CANVAS_SIZE,
    Math.min(MAX_CANVAS_SIZE, Math.round(canvasSize * factor)),
  );
}
