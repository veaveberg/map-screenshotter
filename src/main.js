import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

import {
  MAX_CANVAS_SIZE,
  MIN_CANVAS_SIZE,
  createExportPlan,
  createPatternExportPlan,
  scaleStyleForExport,
  stepCanvasSize,
} from "./export-model.js";
import {
  createDownloadFilename,
  createNameSuggestions,
  slugifySuggestedName,
} from "./name-suggestions.js";
import "./styles.css";

const STYLE_URL = "mapbox://styles/veave/clxnace1t003701r00j380e5e";
const ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const DEFAULT_CANVAS_SIZE = 960;
const EXPORT_TIMEOUT_MS = 30_000;

const elements = {
  lngInput: document.querySelector("#lngInput"),
  latInput: document.querySelector("#latInput"),
  zoomInput: document.querySelector("#zoomInput"),
  bearingInput: document.querySelector("#bearingInput"),
  sizeInput: document.querySelector("#sizeInput"),
  exportStatus: document.querySelector("#exportStatus"),
  screenshotButton: document.querySelector("#screenshotButton"),
  copyButton: document.querySelector("#copyButton"),
  mapViewport: document.querySelector("#mapViewport"),
  mapStage: document.querySelector("#mapStage"),
  previewShell: document.querySelector(".preview-shell"),
  stageScroll: document.querySelector(".stage-scroll"),
  mapContainer: document.querySelector("#map"),
  themeButton: document.querySelector("#themeButton"),
  themeButtonLabel: document.querySelector(".theme-button-label"),
  expandCanvasButton: document.querySelector("#expandCanvasButton"),
  contractCanvasButton: document.querySelector("#contractCanvasButton"),
  nameToggle: document.querySelector("#nameToggle"),
  nameSelect: document.querySelector("#nameSelect"),
  nameSelectLabel: document.querySelector("#nameSelectLabel"),
  nameInput: document.querySelector("#nameInput"),
  nameEditButton: document.querySelector("#nameEditButton"),
};

const state = {
  center: [37.630847, 55.766782],
  zoom: 15.61,
  bearing: 0,
  canvasSize: DEFAULT_CANVAS_SIZE,
  outputSize: 3840,
};

let map;
let spriteSheetPromise;
let previewResizeFrame;
let nameSearchController;
let nameSearchTimer;
let hasCustomName = false;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  elements.themeButtonLabel.textContent = theme === "dark" ? "Light" : "Dark";
  elements.themeButton.setAttribute("aria-pressed", String(theme === "dark"));
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(theme);

  try {
    localStorage.setItem("mapbox-screenshotter-theme", theme);
  } catch {
    // The selected theme still applies for the current page.
  }
}

function clamp(number, min, max) {
  return Math.min(max, Math.max(min, number));
}

function getExportPlan() {
  return createExportPlan({
    canvasSize: state.canvasSize,
    outputSize: state.outputSize,
    devicePixelRatio: window.devicePixelRatio,
  });
}

function setStatus(message = "", stateName = "") {
  if (!elements.exportStatus) return;
  elements.exportStatus.textContent = message;

  if (stateName) {
    elements.exportStatus.dataset.state = stateName;
  } else {
    delete elements.exportStatus.dataset.state;
  }
}

function syncDerivedExportState() {
  try {
    const plan = getExportPlan();
    elements.sizeInput.value = String(plan.outputSize);
    setStatus();
  } catch (error) {
    elements.sizeInput.value = String(state.outputSize);
    setStatus(error.message, "error");
  }
}

function updatePreviewScale() {
  const scrollRect = elements.stageScroll.getBoundingClientRect();
  const shellRect = elements.previewShell.getBoundingClientRect();
  const controlGutter = window.matchMedia("(max-width: 520px)").matches ? 0 : 64;
  const fallbackSide = Math.max(1, Math.min(shellRect.width - 32, 960));
  const availableWidth = scrollRect.width > 0
    ? scrollRect.width - 32 - controlGutter
    : fallbackSide - controlGutter;
  const availableHeight = scrollRect.height > 0 ? scrollRect.height - 32 : fallbackSide;
  const availableSide = Math.max(1, Math.min(availableWidth, availableHeight));
  const displaySize = Math.max(1, Math.round(availableSide));
  const scale = displaySize / state.canvasSize;

  elements.mapViewport.style.width = `${displaySize}px`;
  elements.mapViewport.style.height = `${displaySize}px`;
  elements.mapStage.style.transform = `scale(${scale})`;
}

function schedulePreviewResize() {
  if (previewResizeFrame) {
    cancelAnimationFrame(previewResizeFrame);
  }

  previewResizeFrame = requestAnimationFrame(() => {
    previewResizeFrame = undefined;
    updatePreviewScale();
    map?.resize();
  });
}

function setCanvasSize(size) {
  state.canvasSize = clamp(
    Math.round(size) || DEFAULT_CANVAS_SIZE,
    MIN_CANVAS_SIZE,
    MAX_CANVAS_SIZE,
  );
  elements.mapStage.style.width = `${state.canvasSize}px`;
  elements.mapStage.style.height = `${state.canvasSize}px`;
  elements.expandCanvasButton.disabled = state.canvasSize >= MAX_CANVAS_SIZE;
  elements.contractCanvasButton.disabled = state.canvasSize <= MIN_CANVAS_SIZE;
  elements.expandCanvasButton.setAttribute(
    "aria-label",
    `Expand canvas to show more area. Current size ${state.canvasSize} pixels.`,
  );
  elements.contractCanvasButton.setAttribute(
    "aria-label",
    `Contract canvas to show less area. Current size ${state.canvasSize} pixels.`,
  );
  updatePreviewScale();
  syncDerivedExportState();
}

function reflectCameraInputs({ preserveFocused = false } = {}) {
  const values = new Map([
    [elements.lngInput, state.center[0].toFixed(4)],
    [elements.latInput, state.center[1].toFixed(4)],
    [elements.zoomInput, state.zoom.toFixed(2)],
    [elements.bearingInput, state.bearing.toFixed(0)],
  ]);

  for (const [input, value] of values) {
    if (!preserveFocused || document.activeElement !== input) {
      input.value = value;
    }
  }
}

function syncStateFromMap() {
  const previousCenter = state.center;
  const center = map.getCenter();
  state.center = [center.lng, center.lat];
  state.zoom = map.getZoom();
  state.bearing = map.getBearing();
  reflectCameraInputs({ preserveFocused: true });
  return state.center.some((coordinate, index) =>
    Math.abs(coordinate - previousCenter[index]) > 0.0000001
  );
}

function searchUrl(path, parameters) {
  const url = new URL(`https://api.mapbox.com${path}`);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, String(value));
  }
  url.searchParams.set("access_token", ACCESS_TOKEN);
  return url;
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Mapbox name search failed with status ${response.status}.`);
  }
  return response.json();
}

function renderNameSuggestions(suggestions, selectedName = "", preferClosest = false) {
  elements.nameSelectLabel.dataset.loading = "false";
  elements.nameSelect.replaceChildren();

  if (suggestions.length === 0) {
    elements.nameSelect.add(new Option("No nearby names", ""));
    syncNameControls();
    return;
  }

  const groups = new Map();
  for (const suggestion of suggestions) {
    if (!groups.has(suggestion.group)) {
      const optionGroup = document.createElement("optgroup");
      optionGroup.label = suggestion.group;
      groups.set(suggestion.group, optionGroup);
      elements.nameSelect.appendChild(optionGroup);
    }
    groups.get(suggestion.group).appendChild(new Option(suggestion.name, suggestion.name));
  }

  const hasPreviousSelection = suggestions.some(({ name }) => name === selectedName);
  if (!preferClosest && hasPreviousSelection) elements.nameSelect.value = selectedName;
  syncNameControls();
}

function syncNameControls() {
  const hasSuggestedName = Boolean(elements.nameSelect.value);
  const namingEnabled = elements.nameToggle.checked;
  elements.nameSelect.disabled = !namingEnabled || !hasSuggestedName;
  elements.nameInput.disabled = !namingEnabled;
  elements.nameEditButton.disabled = !namingEnabled || !hasSuggestedName;
}

function setNameEditMode(isCustom) {
  hasCustomName = isCustom;
  elements.nameSelect.hidden = isCustom;
  elements.nameInput.hidden = !isCustom;
  elements.nameEditButton.dataset.state = isCustom ? "reset" : "edit";
  const label = isCustom ? "Reset to suggested name" : "Edit suggested name";
  elements.nameEditButton.setAttribute("aria-label", label);
  elements.nameEditButton.title = label;
  syncNameControls();
}

function editSuggestedName() {
  elements.nameInput.value = elements.nameSelect.value;
  setNameEditMode(true);
  elements.nameInput.focus();
  elements.nameInput.select();
}

function resetSuggestedName() {
  elements.nameInput.value = "";
  setNameEditMode(false);
  elements.nameSelect.focus();
}

function activePngName() {
  return hasCustomName ? elements.nameInput.value : elements.nameSelect.value;
}

async function refreshNameSuggestions({ preferClosest = false } = {}) {
  nameSearchController?.abort();
  nameSearchController = new AbortController();
  const { signal } = nameSearchController;
  const [longitude, latitude] = state.center;
  const proximity = `${longitude},${latitude}`;
  const selectedName = elements.nameSelect.value;

  elements.nameSelect.disabled = true;
  elements.nameEditButton.disabled = !elements.nameToggle.checked || !selectedName;
  if (!selectedName) {
    elements.nameSelect.replaceChildren(new Option("Finding nearby names...", ""));
  }
  elements.nameSelectLabel.dataset.loading = "true";

  try {
    const [metroData, railData, airportData, districtData] = await Promise.all([
      fetchJson(searchUrl("/search/searchbox/v1/category/light_rail_station", {
        language: "en",
        limit: 10,
        proximity,
      }), signal),
      fetchJson(searchUrl("/search/searchbox/v1/category/railway_station", {
        language: "en",
        limit: 25,
        proximity,
        poi_category_exclusions: "light_rail_station",
      }), signal),
      fetchJson(searchUrl("/search/searchbox/v1/category/airport", {
        language: "en",
        limit: 10,
        proximity,
        radius: 0.02,
      }), signal),
      fetchJson(searchUrl("/search/geocode/v6/reverse", {
        longitude,
        latitude,
        language: "en",
        types: "district,locality,neighborhood",
      }), signal),
    ]);

    if (signal.aborted) return;
    renderNameSuggestions(createNameSuggestions({
      railFeatures: [...metroData.features, ...railData.features],
      airportFeatures: airportData.features,
      districtFeatures: districtData.features,
      origin: state.center,
    }), selectedName, preferClosest);
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error(error);
    elements.nameSelectLabel.dataset.loading = "false";
    elements.nameSelect.replaceChildren(new Option("Names unavailable", ""));
    syncNameControls();
  }
}

function scheduleNameSuggestionRefresh({ preferClosest = false } = {}) {
  window.clearTimeout(nameSearchTimer);
  nameSearchTimer = window.setTimeout(
    () => refreshNameSuggestions({ preferClosest }),
    250,
  );
}

function applyCameraFromInputs({ normalize = true } = {}) {
  const previousCenter = state.center;
  const longitude = elements.lngInput.valueAsNumber;
  const latitude = elements.latInput.valueAsNumber;
  const zoom = elements.zoomInput.valueAsNumber;
  const bearing = elements.bearingInput.valueAsNumber;

  state.center = [
    Number.isFinite(longitude) ? longitude : state.center[0],
    Number.isFinite(latitude) ? latitude : state.center[1],
  ];
  state.zoom = Number.isFinite(zoom) ? clamp(zoom, 0, 24) : state.zoom;
  state.bearing = Number.isFinite(bearing) ? bearing : normalize ? 0 : state.bearing;
  if (normalize) reflectCameraInputs();
  map.jumpTo({ center: state.center, zoom: state.zoom, bearing: state.bearing, pitch: 0 });
  const centerChanged = state.center.some((coordinate, index) =>
    Math.abs(coordinate - previousCenter[index]) > 0.0000001
  );
  if (centerChanged) scheduleNameSuggestionRefresh({ preferClosest: true });
}

function changeCanvasSize(direction) {
  const nextSize = stepCanvasSize(state.canvasSize, direction);
  if (nextSize === state.canvasSize) {
    return;
  }

  const camera = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: 0,
  };

  setCanvasSize(nextSize);
  map.resize();
  map.jumpTo(camera);
  syncStateFromMap();
}

function applyOutputSizeFromInput() {
  state.outputSize = clamp(
    Math.round(Number(elements.sizeInput.value)) || 3840,
    128,
    8192,
  );
  syncDerivedExportState();
}

function nudgeOutputSize(direction, amount) {
  const currentSize = Number(elements.sizeInput.value) || state.outputSize;
  const nextSize = clamp(currentSize + direction * amount, 128, 8192);
  elements.sizeInput.value = String(nextSize);
  applyOutputSizeFromInput();
}

function nudgeBearing(direction) {
  const currentBearing = Number.isFinite(elements.bearingInput.valueAsNumber)
    ? elements.bearingInput.valueAsNumber
    : state.bearing;
  elements.bearingInput.value = String(currentBearing + direction * 5);
  applyCameraFromInputs({ normalize: false });
}

function nudgeCoordinate(input, stateIndex, direction) {
  const currentCoordinate = Number.isFinite(input.valueAsNumber)
    ? input.valueAsNumber
    : state.center[stateIndex];
  input.value = (currentCoordinate + direction * 0.001).toFixed(4);
  applyCameraFromInputs({ normalize: false });
}

function registerBlurCommit(input, handler) {
  input.addEventListener("blur", handler);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      input.blur();
    }
  });
}

function copySupported() {
  return Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== "undefined";
}

function setButtonsBusy(isBusy, copyMode = false) {
  elements.screenshotButton.disabled = isBusy;
  elements.copyButton.disabled = isBusy || !copySupported();
  const screenshotLabel = isBusy && !copyMode ? "Rendering…" : "Download PNG";
  const copyLabel = isBusy && copyMode ? "Copying…" : "Copy PNG";
  elements.screenshotButton.setAttribute("aria-label", screenshotLabel);
  elements.screenshotButton.title = screenshotLabel;
  elements.copyButton.setAttribute("aria-label", copyLabel);
  elements.copyButton.title = copyLabel;
  elements.screenshotButton.dataset.state = isBusy && !copyMode ? "loading" : "idle";
  elements.copyButton.dataset.state = isBusy && copyMode ? "loading" : "idle";
}

function showButtonSuccess(button, label) {
  button.disabled = false;
  button.dataset.state = "success";
  button.setAttribute("aria-label", `${label} complete`);
  button.title = `${label} complete`;
  window.setTimeout(() => {
    button.dataset.state = "idle";
    button.setAttribute("aria-label", label);
    button.title = label;
  }, 1400);
}

function waitForIdle(exportMap) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("The export timed out while loading map tiles."));
    }, EXPORT_TIMEOUT_MS);

    exportMap.once("idle", () => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
}

function waitForStyle(exportMap) {
  if (exportMap.isStyleLoaded()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => exportMap.once("style.load", resolve));
}

function getSpriteSheetUrls() {
  const match = STYLE_URL.match(/^mapbox:\/\/styles\/([^/]+)\/([^/?]+)/);
  if (!match) {
    throw new Error("The map style URL cannot be used to load its pattern sprites.");
  }

  const [, owner, styleId] = match;
  const baseUrl = `https://api.mapbox.com/styles/v1/${owner}/${styleId}/sprite@2x`;
  const tokenQuery = `access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
  return {
    metadata: `${baseUrl}.json?${tokenQuery}`,
    image: `${baseUrl}.png?${tokenQuery}`,
  };
}

async function loadSpriteSheet() {
  if (!spriteSheetPromise) {
    spriteSheetPromise = (async () => {
      const urls = getSpriteSheetUrls();
      const [metadataResponse, imageResponse] = await Promise.all([
        fetch(urls.metadata),
        fetch(urls.image),
      ]);

      if (!metadataResponse.ok || !imageResponse.ok) {
        throw new Error("Mapbox did not return the style's pattern sprites.");
      }

      const [metadata, imageBlob] = await Promise.all([
        metadataResponse.json(),
        imageResponse.blob(),
      ]);

      return {
        metadata,
        image: await createImageBitmap(imageBlob),
      };
    })();
  }

  return spriteSheetPromise;
}

function cropSpriteImage(spriteSheet, metadata) {
  const canvas = document.createElement("canvas");
  canvas.width = metadata.width;
  canvas.height = metadata.height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("The browser could not prepare a map pattern for export.");
  }

  context.drawImage(
    spriteSheet,
    metadata.x,
    metadata.y,
    metadata.width,
    metadata.height,
    0,
    0,
    metadata.width,
    metadata.height,
  );
  return context.getImageData(0, 0, metadata.width, metadata.height);
}

async function installScaledPatterns(exportMap, style, scale) {
  const hasPatterns = (style.layers ?? []).some((layer) =>
    layer.paint?.["fill-pattern"] !== undefined ||
    layer.paint?.["line-pattern"] !== undefined,
  );
  if (!hasPatterns) {
    return;
  }

  const spriteSheet = await loadSpriteSheet();
  const patternPlan = createPatternExportPlan(style, spriteSheet.metadata, scale);

  for (const image of patternPlan.images) {
    exportMap.addImage(
      image.exportId,
      cropSpriteImage(spriteSheet.image, image.metadata),
      {
        pixelRatio: image.pixelRatio,
        sdf: Boolean(image.metadata.sdf),
      },
    );
  }

  for (const update of patternPlan.layerUpdates) {
    exportMap.setPaintProperty(update.layerId, update.property, update.value);
  }
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("The browser could not encode the rendered map as PNG."));
      }
    }, "image/png");
  });
}

async function renderExportBlob() {
  const plan = getExportPlan();

  if (state.zoom + plan.zoomDelta > 24) {
    throw new RangeError("This output resolution exceeds Mapbox's maximum zoom. Reduce the map zoom or output size.");
  }

  const container = document.createElement("div");
  container.className = "export-map";
  container.style.width = `${plan.cssSize}px`;
  container.style.height = `${plan.cssSize}px`;
  document.body.appendChild(container);

  const sourceStyle = map.getStyle();
  const scaledStyle = scaleStyleForExport(sourceStyle, plan.styleScale);
  const exportMap = new mapboxgl.Map({
    container,
    style: scaledStyle,
    center: state.center,
    zoom: state.zoom + plan.zoomDelta,
    bearing: state.bearing,
    pitch: 0,
    maxZoom: 24,
    interactive: false,
    attributionControl: false,
    antialias: true,
    preserveDrawingBuffer: true,
    fadeDuration: 0,
  });

  try {
    await waitForStyle(exportMap);
    await installScaledPatterns(exportMap, sourceStyle, plan.styleScale);
    await waitForIdle(exportMap);
    exportMap.triggerRepaint();
    await new Promise((resolve) => exportMap.once("render", resolve));

    const sourceCanvas = exportMap.getCanvas();
    if (!sourceCanvas.width || !sourceCanvas.height) {
      throw new Error("The export renderer produced an empty canvas.");
    }

    if (sourceCanvas.width === plan.outputSize && sourceCanvas.height === plan.outputSize) {
      return { blob: await canvasToBlob(sourceCanvas), size: plan.outputSize };
    }

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = plan.outputSize;
    outputCanvas.height = plan.outputSize;
    const context = outputCanvas.getContext("2d");

    if (!context) {
      throw new Error("The browser could not create the PNG output canvas.");
    }

    context.drawImage(sourceCanvas, 0, 0, plan.outputSize, plan.outputSize);
    return { blob: await canvasToBlob(outputCanvas), size: plan.outputSize };
  } finally {
    exportMap.remove();
    container.remove();
  }
}

async function downloadPng() {
  setButtonsBusy(true, false);
  setStatus("Rendering the high-resolution map…");
  let completed = false;

  try {
    const { blob, size } = await renderExportBlob();
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = createDownloadFilename({
      suggestionName: activePngName(),
      namingEnabled: elements.nameToggle.checked,
      center: state.center,
      zoom: state.zoom,
      bearing: state.bearing,
      size,
    });
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus();
    completed = true;
  } catch (error) {
    setStatus(error.message, "error");
    throw error;
  } finally {
    setButtonsBusy(false, false);
    if (completed) showButtonSuccess(elements.screenshotButton, "Download PNG");
  }
}

async function copyPng() {
  setButtonsBusy(true, true);
  setStatus("Rendering the high-resolution map…");
  let completed = false;

  try {
    const { blob, size } = await renderExportBlob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setStatus();
    completed = true;
  } catch (error) {
    setStatus(error.message, "error");
    throw error;
  } finally {
    setButtonsBusy(false, false);
    if (completed) showButtonSuccess(elements.copyButton, "Copy PNG");
  }
}

mapboxgl.accessToken = ACCESS_TOKEN;
applyTheme(document.documentElement.dataset.theme || "light");
setCanvasSize(state.canvasSize);

map = new mapboxgl.Map({
  container: elements.mapContainer,
  style: STYLE_URL,
  center: state.center,
  zoom: state.zoom,
  bearing: state.bearing,
  pitch: 0,
  maxZoom: 24,
  attributionControl: true,
  antialias: true,
});

map.addControl(new mapboxgl.NavigationControl({ showCompass: true, showZoom: true }), "top-right");
map.on("load", () => {
  updatePreviewScale();
  map.resize();
  syncStateFromMap();
  scheduleNameSuggestionRefresh({ preferClosest: true });
});
map.on("moveend", () => {
  if (syncStateFromMap()) {
    scheduleNameSuggestionRefresh({ preferClosest: true });
  }
});
map.on("error", (event) => {
  if (event?.error) {
    console.error(event.error);
  }
});

registerBlurCommit(elements.lngInput, applyCameraFromInputs);
registerBlurCommit(elements.latInput, applyCameraFromInputs);
registerBlurCommit(elements.zoomInput, applyCameraFromInputs);
registerBlurCommit(elements.bearingInput, applyCameraFromInputs);
registerBlurCommit(elements.sizeInput, applyOutputSizeFromInput);

for (const input of [
  elements.lngInput,
  elements.latInput,
  elements.zoomInput,
  elements.bearingInput,
]) {
  input.addEventListener("input", () => applyCameraFromInputs({ normalize: false }));
}

elements.bearingInput.addEventListener("keydown", (event) => {
  if (!event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
    return;
  }

  event.preventDefault();
  nudgeBearing(event.key === "ArrowUp" ? 1 : -1);
});

for (const [input, stateIndex] of [
  [elements.lngInput, 0],
  [elements.latInput, 1],
]) {
  input.addEventListener("keydown", (event) => {
    if (!event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
      return;
    }

    event.preventDefault();
    nudgeCoordinate(input, stateIndex, event.key === "ArrowUp" ? 1 : -1);
  });
}

elements.sizeInput.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    return;
  }

  event.preventDefault();
  nudgeOutputSize(event.key === "ArrowUp" ? 1 : -1, event.shiftKey ? 100 : 10);
});

elements.screenshotButton.addEventListener("click", () => {
  downloadPng().catch(console.error);
});

elements.copyButton.addEventListener("click", () => {
  copyPng().catch(console.error);
});
elements.themeButton.addEventListener("click", toggleTheme);
elements.expandCanvasButton.addEventListener("click", () => changeCanvasSize("expand"));
elements.contractCanvasButton.addEventListener("click", () => changeCanvasSize("contract"));
elements.nameToggle.addEventListener("change", () => {
  syncNameControls();
});
elements.nameEditButton.addEventListener("mousedown", (event) => event.preventDefault());
elements.nameEditButton.addEventListener("click", () => {
  if (hasCustomName) {
    resetSuggestedName();
  } else {
    editSuggestedName();
  }
});
elements.nameInput.addEventListener("blur", () => {
  const normalizedName = slugifySuggestedName(elements.nameInput.value);
  if (normalizedName) {
    elements.nameInput.value = normalizedName;
  } else {
    resetSuggestedName();
  }
});
elements.nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") elements.nameInput.blur();
});

if (!copySupported()) {
  elements.copyButton.disabled = true;
  elements.copyButton.title = "Clipboard PNG copy is not supported in this browser.";
}

window.addEventListener("resize", () => {
  schedulePreviewResize();
  syncDerivedExportState();
});

if (typeof ResizeObserver !== "undefined") {
  const previewResizeObserver = new ResizeObserver(schedulePreviewResize);
  previewResizeObserver.observe(elements.previewShell);
  previewResizeObserver.observe(elements.stageScroll);
}

reflectCameraInputs();
syncDerivedExportState();
