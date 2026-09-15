import * as mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";

import {
  MAX_CANVAS_SIZE,
  MIN_CANVAS_SIZE,
  createExportPlan,
  createPatternExportPlan,
  scaleStyleForExport,
} from "./export-model.js";
import {
  createDownloadFilename,
  createNameSuggestions,
  slugifySuggestedName,
} from "./name-suggestions.js";
import { getMoscowMetroEnglishName, isKnownMoscowMetroStation } from "./moscow-metro-names.js";
import { DEFAULT_LANGUAGE, translate } from "./translations.js";
import "./styles.css";

const STYLE_URL = "mapbox://styles/veave/clxnace1t003701r00j380e5e";
const ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const DEFAULT_CANVAS_SIZE = 960;
const EXPORT_TIMEOUT_MS = 30_000;
const MAP_TILE_SIZE = 512;
const MAX_MERCATOR_LATITUDE = 85.051129;
const ZOOM_STEP = 0.5;
const CANVAS_SIZE_STEP = 1.2;
const CAMERA_STORAGE_KEY = "mapbox-screenshotter-camera";
const MOSCOW_REGION_BOUNDS = [35.147, 54.256, 40.25, 56.99];
const MOSCOW_SEARCH_TYPES = "poi,district,place,locality,neighborhood,address";
const GEOCODER_COUNTRY_NAMES = new Set(["Россия", "Russia"]);
const OVERPASS_API_URL = "https://overpass-api.de/api/interpreter";

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
  languageMenu: document.querySelector(".language-menu"),
  languageButtons: document.querySelectorAll("[data-language]"),
  canvasSizeControls: document.querySelector(".canvas-size-controls"),
  canvasSizeSlider: document.querySelector("#canvasSizeSlider"),
  canvasSizeDefaultOffset: document.querySelector("#canvasSizeDefaultOffset"),
  canvasSizeDefaultOffsetSign: document.querySelector("#canvasSizeDefaultOffsetSign"),
  canvasSizeDefaultOffsetValue: document.querySelector("#canvasSizeDefaultOffsetValue"),
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
  zoom: 15.5,
  bearing: 0,
  canvasSize: DEFAULT_CANVAS_SIZE,
  outputSize: 4000,
  language: DEFAULT_LANGUAGE,
};

let map;
let geocoder;
let mapMinimumZoom = 0;
let spriteSheetPromise;
let previewResizeFrame;
let nameSearchController;
let nameSearchTimer;
let hasCustomName = false;
let moscowMetroSearchFeatures = [];
let hasAdjustedCanvasSize = false;
let pendingCanvasSize;
let canvasSizeApplyTimer;

const canvasSizeLevels = createCanvasSizeLevels();

function createCanvasSizeLevels() {
  const smallerSizes = [];
  let smallerSize = DEFAULT_CANVAS_SIZE;
  while (smallerSize > MIN_CANVAS_SIZE) {
    smallerSize = Math.max(MIN_CANVAS_SIZE, Math.round(smallerSize / CANVAS_SIZE_STEP));
    smallerSizes.push(smallerSize);
  }

  const largerSizes = [];
  let largerSize = DEFAULT_CANVAS_SIZE;
  while (largerSize < MAX_CANVAS_SIZE) {
    largerSize = Math.min(MAX_CANVAS_SIZE, Math.round(largerSize * CANVAS_SIZE_STEP));
    largerSizes.push(largerSize);
  }

  return [...smallerSizes.reverse(), DEFAULT_CANVAS_SIZE, ...largerSizes].slice(4, -3);
}

function getCanvasSizeLevel(size) {
  return canvasSizeLevels.reduce((closestLevel, levelSize, level) =>
    Math.abs(levelSize - size) < Math.abs(canvasSizeLevels[closestLevel] - size)
      ? level
      : closestLevel, 0);
}

function t(key, values) {
  return translate(state.language, key, values);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getGeocoderResultName(feature) {
  return typeof feature?.text === "string" && feature.text
    ? feature.text
    : feature?.place_name || "";
}

function renderGeocoderResult(feature) {
  const name = getGeocoderResultName(feature);
  const context = typeof feature?.place_name === "string"
    ? feature.place_name
      .split(",")
      .map((segment) => segment.trim())
      .filter((segment) => !GEOCODER_COUNTRY_NAMES.has(segment) && segment !== name)
      .join(", ")
    : "";
  const title = `<div class="mapboxgl-ctrl-geocoder--suggestion-title">${escapeHtml(name)}</div>`;
  const address = context
    ? `<div class="mapboxgl-ctrl-geocoder--suggestion-address">${escapeHtml(context)}</div>`
    : "";

  return `<div class="mapboxgl-ctrl-geocoder--suggestion">${title}${address}</div>`;
}

function normalizedSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .trim();
}

function createOsmMetroSearchFeature(element) {
  const tags = element?.tags ?? {};
  const name = tags.name;
  const englishName = tags["name:en"] ?? getMoscowMetroEnglishName(name);
  const longitude = element?.lon ?? element?.center?.lon;
  const latitude = element?.lat ?? element?.center?.lat;
  const isMetro = tags.station === "subway" || tags.subway === "yes" ||
    tags.railway === "subway" || /московский метрополитен|moscow metro/i.test(tags.network ?? "") ||
    isKnownMoscowMetroStation(name);

  if (!name || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return undefined;

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    center: [longitude, latitude],
    text: name,
    searchText: `${name} ${englishName ?? ""}`,
    place_name: `${name}, метро, Москва`,
    place_type: ["poi"],
    properties: {
      mapbox_id: `osm-${element.type}-${element.id}`,
      poi_category_ids: [isMetro ? "metro_station" : "railway_station"],
      name,
    },
    _source: "openstreetmap",
  };
}

function findMoscowMetroStations(query) {
  const searchText = normalizedSearchText(query);
  if (searchText.length < 2) return [];

  const stations = moscowMetroSearchFeatures;
  const seenStationIds = new Set();

  return stations.filter((feature) => {
    const id = feature.properties.mapbox_id;
    if (
      seenStationIds.has(id) ||
      !normalizedSearchText(feature.searchText ?? feature.text).includes(searchText)
    ) {
      return false;
    }
    seenStationIds.add(id);
    return true;
  });
}

function isAtCurrentMoscowMetroStation(feature) {
  const [longitude, latitude] = feature?.geometry?.coordinates ?? [];
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;

  return moscowMetroSearchFeatures.some((station) => {
    const [stationLongitude, stationLatitude] = station.geometry.coordinates;
    const longitudeDistance = (longitude - stationLongitude) * Math.cos(latitude * Math.PI / 180);
    return Math.hypot(longitudeDistance, latitude - stationLatitude) < 0.003;
  });
}

async function loadMoscowMetroSearchFeatures() {
  try {
    const query = `[out:json][timeout:25];(nwr["station"="subway"](54.256,35.147,56.99,40.25);nwr["subway"="yes"](54.256,35.147,56.99,40.25);nwr["railway"="station"]["network"~"Московский метрополитен|Moscow Metro"](54.256,35.147,56.99,40.25););out center tags;`;
    const response = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ data: query }),
    });
    if (!response.ok) throw new Error(`OSM station search failed: ${response.status}`);

    const data = await response.json();
    moscowMetroSearchFeatures = (data.elements ?? [])
      .map(createOsmMetroSearchFeature)
      .filter(Boolean);
    scheduleNameSuggestionRefresh({ preferClosest: true });
  } catch (error) {
    // The regular Mapbox geocoder remains available when this supplemental list fails.
    console.error(error);
  }
}

function translateDocument() {
  document.documentElement.lang = state.language;
  document.title = t("documentTitle");

  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  }
  for (const element of document.querySelectorAll("[data-i18n-title]")) {
    element.title = t(element.dataset.i18nTitle);
  }

  elements.themeButton.setAttribute("aria-label", t("switchTheme"));
  geocoder?.setLanguage(state.language);
  geocoder?.setPlaceholder(t("mapSearchPlaceholder"));
  elements.languageMenu.querySelector("summary").setAttribute("aria-label", t("languageMenuLabel"));
  elements.languageMenu.querySelector("summary").title = t("languageMenuLabel");
  elements.languageMenu.querySelector("[role=group]").setAttribute("aria-label", t("languageMenuLabel"));
  for (const button of elements.languageButtons) {
    button.textContent = t(button.dataset.language === "ru" ? "languageOptionRussian" : "languageOptionEnglish");
    button.setAttribute("aria-current", String(button.dataset.language === state.language));
  }
  for (const group of elements.nameSelect.querySelectorAll("[data-suggestion-group]")) {
    group.label = t(`group${group.dataset.suggestionGroup}`);
  }
  const suggestionMessage = elements.nameSelect.querySelector("[data-i18n-suggestion-message]");
  if (suggestionMessage) {
    suggestionMessage.textContent = t(suggestionMessage.dataset.i18nSuggestionMessage);
  }
  applyTheme(document.documentElement.dataset.theme || "light");
  setCanvasSize(state.canvasSize);
  setNameEditMode(hasCustomName);
  setButtonsBusy(false, false);
}

function applyLanguage(language) {
  if (language !== "en" && language !== "ru") return;
  state.language = language;
  translateDocument();
  elements.languageMenu.open = false;

  try {
    localStorage.setItem("mapbox-screenshotter-language", language);
  } catch {
    // The selected language still applies for the current page.
  }

}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  elements.themeButtonLabel.textContent = theme === "dark" ? t("themeLight") : t("themeDark");
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

function parseStoredCamera(value) {
  const camera = JSON.parse(value);
  if (!camera || typeof camera !== "object" || !Array.isArray(camera.center)) return null;

  const [longitude, latitude] = camera.center;
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(camera.zoom) ||
    !Number.isFinite(camera.bearing) ||
    longitude < -180 || longitude > 180 ||
    latitude < -MAX_MERCATOR_LATITUDE || latitude > MAX_MERCATOR_LATITUDE ||
    camera.zoom < 0 || camera.zoom > 24
  ) {
    return null;
  }

  return { center: [longitude, latitude], zoom: camera.zoom, bearing: camera.bearing };
}

function restoreStoredCamera() {
  try {
    const camera = parseStoredCamera(localStorage.getItem(CAMERA_STORAGE_KEY));
    if (camera) Object.assign(state, camera);
  } catch {
    // The default camera remains in use when storage is unavailable or invalid.
  }
}

function saveCamera() {
  try {
    localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({
      center: state.center,
      zoom: state.zoom,
      bearing: state.bearing,
    }));
  } catch {
    // The current camera still works when browser storage is unavailable.
  }
}

function getMinimumZoomForCenter() {
  if (!map) return 0;

  const latitude = clamp(
    state.center[1],
    -MAX_MERCATOR_LATITUDE,
    MAX_MERCATOR_LATITUDE,
  );
  const latitudeRadians = latitude * Math.PI / 180;
  const mercatorY = (1 - Math.log(
    Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians),
  ) / Math.PI) / 2;
  const nearestWorldEdge = Math.min(mercatorY, 1 - mercatorY);
  const minimumWorldSize = map.getContainer().clientHeight / (2 * nearestWorldEdge);
  const minimumZoom = Math.log2(minimumWorldSize / MAP_TILE_SIZE);

  return clamp(Math.ceil(minimumZoom / ZOOM_STEP) * ZOOM_STEP, 0, 24);
}

function updateMinimumZoom() {
  const minimumZoom = getMinimumZoomForCenter();
  elements.zoomInput.min = String(minimumZoom);

  if (minimumZoom !== mapMinimumZoom) {
    mapMinimumZoom = minimumZoom;
    map.setMinZoom(minimumZoom);
  }

  return minimumZoom;
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
  const verticalControlGutter = window.matchMedia("(max-width: 520px)").matches ? 80 : 88;
  const fallbackSide = Math.max(1, Math.min(shellRect.width - 32, 960));
  const availableWidth = scrollRect.width > 0
    ? scrollRect.width - 32
    : fallbackSide;
  const availableHeight = scrollRect.height > 0
    ? scrollRect.height - verticalControlGutter
    : fallbackSide - verticalControlGutter + 32;
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

function updateCanvasSizeControl(size) {
  const canvasSize = clamp(
    Math.round(size) || DEFAULT_CANVAS_SIZE,
    MIN_CANVAS_SIZE,
    MAX_CANVAS_SIZE,
  );
  const canvasSizeLevel = getCanvasSizeLevel(canvasSize);
  const defaultCanvasSizeLevel = getCanvasSizeLevel(DEFAULT_CANVAS_SIZE);
  elements.canvasSizeSlider.max = String(canvasSizeLevels.length - 1);
  elements.canvasSizeSlider.value = String(canvasSizeLevel);
  elements.canvasSizeControls.style.setProperty(
    "--canvas-size-progress",
    String(canvasSizeLevel / (canvasSizeLevels.length - 1)),
  );
  const canvasSizeOffset = canvasSizeLevel - defaultCanvasSizeLevel;
  elements.canvasSizeDefaultOffsetSign.textContent = canvasSizeOffset > 0 ? "+" : canvasSizeOffset < 0 ? "−" : "";
  elements.canvasSizeDefaultOffsetValue.textContent = String(Math.abs(canvasSizeOffset));
  elements.canvasSizeDefaultOffset.classList.toggle("is-visible", hasAdjustedCanvasSize);
  elements.canvasSizeControls.dataset.canvasSizeAtDefault = String(canvasSizeOffset === 0);
  elements.canvasSizeControls.dataset.canvasSizeOffset = String(canvasSizeOffset);
  elements.canvasSizeControls.style.setProperty(
    "--canvas-size-steps",
    String(canvasSizeLevels.length - 1),
  );
  elements.expandCanvasButton.disabled = canvasSizeLevel === canvasSizeLevels.length - 1;
  elements.contractCanvasButton.disabled = canvasSizeLevel === 0;
  elements.expandCanvasButton.setAttribute("aria-label", t("expandCanvasTitle"));
  elements.contractCanvasButton.setAttribute("aria-label", t("contractCanvasTitle"));
  elements.canvasSizeSlider.setAttribute(
    "aria-valuetext",
    t("canvasSizeValue", { size: canvasSize }),
  );
}

function setCanvasSize(size) {
  state.canvasSize = clamp(
    Math.round(size) || DEFAULT_CANVAS_SIZE,
    MIN_CANVAS_SIZE,
    MAX_CANVAS_SIZE,
  );
  elements.mapStage.style.width = `${state.canvasSize}px`;
  elements.mapStage.style.height = `${state.canvasSize}px`;
  updateCanvasSizeControl(state.canvasSize);
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
  updateMinimumZoom();
  reflectCameraInputs({ preserveFocused: true });
  saveCamera();
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
    throw new Error(t("mapboxSearchFailed", { status: response.status }));
  }
  return response.json();
}

function renderNameSuggestions(suggestions, selectedName = "", preferClosest = false) {
  elements.nameSelectLabel.dataset.loading = "false";
  elements.nameSelect.replaceChildren();

  if (suggestions.length === 0) {
    setNameSuggestionMessage("noNearbyNames");
    syncNameControls();
    return;
  }

  const groups = new Map();
  for (const suggestion of suggestions) {
    if (!groups.has(suggestion.group)) {
      const optionGroup = document.createElement("optgroup");
      optionGroup.dataset.suggestionGroup = suggestion.group;
      optionGroup.label = t(`group${suggestion.group}`);
      groups.set(suggestion.group, optionGroup);
      elements.nameSelect.appendChild(optionGroup);
    }
    groups.get(suggestion.group).appendChild(new Option(suggestion.name, suggestion.name));
  }

  const hasPreviousSelection = suggestions.some(({ name }) => name === selectedName);
  if (!preferClosest && hasPreviousSelection) elements.nameSelect.value = selectedName;
  syncNameControls();
}

function setNameSuggestionMessage(key) {
  const option = new Option(t(key), "");
  option.dataset.i18nSuggestionMessage = key;
  elements.nameSelect.replaceChildren(option);
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
  const label = isCustom ? t("resetSuggestedName") : t("editSuggestedName");
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
    setNameSuggestionMessage("findingNearbyNames");
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
    const suggestions = createNameSuggestions({
      railFeatures: [
        ...moscowMetroSearchFeatures,
        ...metroData.features.filter((feature) => !isAtCurrentMoscowMetroStation(feature)),
        ...railData.features.filter((feature) => !isAtCurrentMoscowMetroStation(feature)),
      ],
      airportFeatures: airportData.features,
      districtFeatures: districtData.features,
      origin: state.center,
    });
    renderNameSuggestions(suggestions, selectedName, preferClosest);
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error(error);
    elements.nameSelectLabel.dataset.loading = "false";
    setNameSuggestionMessage("namesUnavailable");
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

function applyCameraFromInput(input, { normalize = true } = {}) {
  const previousCenter = state.center;

  if (input === elements.lngInput) {
    const longitude = input.valueAsNumber;
    if (Number.isFinite(longitude)) state.center = [longitude, state.center[1]];
  } else if (input === elements.latInput) {
    const latitude = input.valueAsNumber;
    if (Number.isFinite(latitude)) state.center = [state.center[0], latitude];
  } else if (input === elements.zoomInput) {
    const zoom = input.valueAsNumber;
    if (Number.isFinite(zoom)) state.zoom = clamp(zoom, 0, 24);
  } else if (input === elements.bearingInput) {
    const bearing = input.valueAsNumber;
    state.bearing = Number.isFinite(bearing) ? bearing : normalize ? 0 : state.bearing;
  }

  state.zoom = Math.max(state.zoom, updateMinimumZoom());
  if (normalize) reflectCameraInputs();
  map.jumpTo({ center: state.center, zoom: state.zoom, bearing: state.bearing, pitch: 0 });
  const centerChanged = state.center.some((coordinate, index) =>
    Math.abs(coordinate - previousCenter[index]) > 0.0000001
  );
  if (centerChanged) scheduleNameSuggestionRefresh({ preferClosest: true });
}

function applyCanvasSizeFromSlider() {
  hasAdjustedCanvasSize = true;
  elements.canvasSizeControls.classList.add("is-adjusting");
  elements.canvasSizeDefaultOffset.classList.add("is-visible");
  const level = clamp(Math.round(Number(elements.canvasSizeSlider.value)), 0, canvasSizeLevels.length - 1);
  const nextSize = canvasSizeLevels[level];
  updateCanvasSizeControl(nextSize);
  pendingCanvasSize = nextSize;
  window.clearTimeout(canvasSizeApplyTimer);
  canvasSizeApplyTimer = window.setTimeout(applyPendingCanvasSize, 80);
}

function applyPendingCanvasSize() {
  canvasSizeApplyTimer = undefined;
  const nextSize = pendingCanvasSize;
  pendingCanvasSize = undefined;
  if (!nextSize || nextSize === state.canvasSize) return;

  const camera = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: 0,
  };

  setCanvasSize(nextSize);
  camera.zoom = Math.max(camera.zoom, updateMinimumZoom());
  map.resize();
  map.jumpTo(camera);
  syncStateFromMap();
}

function finishCanvasSizeAdjustment() {
  elements.canvasSizeControls.classList.remove("is-adjusting");
  const selectedLevel = clamp(
    Math.round(Number(elements.canvasSizeSlider.value)),
    0,
    canvasSizeLevels.length - 1,
  );
  if (selectedLevel !== getCanvasSizeLevel(DEFAULT_CANVAS_SIZE)) {
    return;
  }

  hasAdjustedCanvasSize = false;
  elements.canvasSizeDefaultOffset.classList.remove("is-visible");
}

function nudgeCanvasSize(direction) {
  const currentLevel = clamp(
    Math.round(Number(elements.canvasSizeSlider.value)),
    0,
    canvasSizeLevels.length - 1,
  );
  elements.canvasSizeSlider.value = String(clamp(
    currentLevel + direction,
    0,
    canvasSizeLevels.length - 1,
  ));
  applyCanvasSizeFromSlider();
  finishCanvasSizeAdjustment();
}

function applyOutputSizeFromInput() {
  state.outputSize = clamp(
    Math.round(Number(elements.sizeInput.value)) || 4000,
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
  applyCameraFromInput(elements.bearingInput, { normalize: false });
}

function nudgeCoordinate(input, stateIndex, direction) {
  const currentCoordinate = Number.isFinite(input.valueAsNumber)
    ? input.valueAsNumber
    : state.center[stateIndex];
  input.value = (currentCoordinate + direction * 0.001).toFixed(4);
  applyCameraFromInput(input, { normalize: false });
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
  const screenshotLabel = isBusy && !copyMode ? t("rendering") : t("downloadPng");
  const copyLabel = isBusy && copyMode ? t("copying") : t("copyPng");
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
  button.setAttribute("aria-label", `${label} ${t("complete")}`);
  button.title = `${label} ${t("complete")}`;
  window.setTimeout(() => {
    button.dataset.state = "idle";
    button.setAttribute("aria-label", label);
    button.title = label;
  }, 1400);
}

function waitForIdle(exportMap) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(t("exportTimedOut")));
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
    throw new Error(t("styleSpritesUnavailable"));
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
        throw new Error(t("patternSpritesUnavailable"));
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
    throw new Error(t("patternPreparationFailed"));
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
        reject(new Error(t("pngEncodingFailed")));
      }
    }, "image/png");
  });
}

async function renderExportBlob() {
  const plan = getExportPlan();

  if (state.zoom + plan.zoomDelta > 24) {
    throw new RangeError(t("outputZoomExceeded"));
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
    accessToken: ACCESS_TOKEN,
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
      throw new Error(t("emptyExport"));
    }

    if (sourceCanvas.width === plan.outputSize && sourceCanvas.height === plan.outputSize) {
      return { blob: await canvasToBlob(sourceCanvas), size: plan.outputSize };
    }

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = plan.outputSize;
    outputCanvas.height = plan.outputSize;
    const context = outputCanvas.getContext("2d");

    if (!context) {
      throw new Error(t("outputCanvasFailed"));
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
  setStatus(t("rendering"));
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
    if (completed) showButtonSuccess(elements.screenshotButton, t("downloadPng"));
  }
}

async function copyPng() {
  setButtonsBusy(true, true);
  setStatus(t("rendering"));
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
    if (completed) showButtonSuccess(elements.copyButton, t("copyPng"));
  }
}

try {
  state.language = localStorage.getItem("mapbox-screenshotter-language") === "ru" ? "ru" : DEFAULT_LANGUAGE;
} catch {
  // English remains the default when storage is unavailable.
}
restoreStoredCamera();

translateDocument();

for (const button of elements.languageButtons) {
  button.addEventListener("click", () => applyLanguage(button.dataset.language));
}

map = new mapboxgl.Map({
  container: elements.mapContainer,
  accessToken: ACCESS_TOKEN,
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
geocoder = new MapboxGeocoder({
  accessToken: ACCESS_TOKEN,
  mapboxgl,
  marker: false,
  flyTo: false,
  bbox: MOSCOW_REGION_BOUNDS,
  countries: "ru",
  types: MOSCOW_SEARCH_TYPES,
  language: state.language,
  placeholder: t("mapSearchPlaceholder"),
  clearAndBlurOnEsc: true,
  getItemValue: getGeocoderResultName,
  localGeocoder: findMoscowMetroStations,
  render: renderGeocoderResult,
});
geocoder.on("result", ({ result }) => {
  const [longitude, latitude] = Array.isArray(result?.center) ? result.center : [];
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;

  map.flyTo({
    center: [longitude, latitude],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    essential: true,
  });
});
map.addControl(geocoder, "top-left");
void loadMoscowMetroSearchFeatures();
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

registerBlurCommit(elements.lngInput, () => applyCameraFromInput(elements.lngInput));
registerBlurCommit(elements.latInput, () => applyCameraFromInput(elements.latInput));
registerBlurCommit(elements.zoomInput, () => applyCameraFromInput(elements.zoomInput));
registerBlurCommit(elements.bearingInput, () => applyCameraFromInput(elements.bearingInput));
registerBlurCommit(elements.sizeInput, applyOutputSizeFromInput);

for (const input of [
  elements.lngInput,
  elements.latInput,
  elements.zoomInput,
  elements.bearingInput,
]) {
  input.addEventListener("input", () => applyCameraFromInput(input, { normalize: false }));
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
elements.canvasSizeSlider.addEventListener("input", applyCanvasSizeFromSlider);
elements.canvasSizeSlider.addEventListener("change", finishCanvasSizeAdjustment);
elements.expandCanvasButton.addEventListener("click", () => nudgeCanvasSize(1));
elements.contractCanvasButton.addEventListener("click", () => nudgeCanvasSize(-1));
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
  elements.copyButton.title = t("clipboardUnsupported");
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
requestAnimationFrame(() => {
  document.documentElement.dataset.uiReady = "true";
});
