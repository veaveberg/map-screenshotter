import { getMoscowMetroEnglishName } from "./moscow-metro-names.js";

const EARTH_RADIUS_METERS = 6_371_000;
const AIRPORT_MAX_DISTANCE_METERS = 1_000;
const MAX_RESULTS_PER_GROUP = 4;
const GROUP_RESULT_LIMITS = { Airport: 1 };

const GENERIC_NAME_WORDS = [
  "international airport",
  "railway station",
  "railway terminal",
  "railroad station",
  "train station",
  "train terminal",
  "metro station",
  "subway station",
  "airport",
  "terminal",
  "station",
  "railway",
  "railroad",
  "metro",
  "subway",
  "district",
  "neighborhood",
  "neighbourhood",
  "borough",
  "locality",
  "municipal district",
  "vokzal",
  "raion",
  "железнодорожная станция",
  "железнодорожный вокзал",
  "станция метро",
  "муниципальный округ",
  "метрополитен",
  "аэропорт",
  "вокзал",
  "станция",
  "метро",
  "район",
  "округ",
];

const GENERIC_NAME_PATTERN = new RegExp(
  `(^|[\\s,·|/()\\[\\]{}—–-])(?:${GENERIC_NAME_WORDS
    .sort((left, right) => right.length - left.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?=$|[\\s,·|/()\\[\\]{}—–-])`,
  "giu",
);

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

export function distanceInMeters(origin, destination) {
  const [originLongitude, originLatitude] = origin;
  const [destinationLongitude, destinationLatitude] = destination;
  const latitudeDelta = toRadians(destinationLatitude - originLatitude);
  const longitudeDelta = toRadians(destinationLongitude - originLongitude);
  const startLatitude = toRadians(originLatitude);
  const endLatitude = toRadians(destinationLatitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) *
    Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

export function cleanSuggestedName(name) {
  let cleaned = String(name ?? "").normalize("NFKC");
  let previous;

  do {
    previous = cleaned;
    cleaned = cleaned.replace(GENERIC_NAME_PATTERN, "$1");
  } while (cleaned !== previous);

  return cleaned
    .replace(/[\s,·|/()\[\]{}—–-]+/g, " ")
    .trim();
}

function featureName(feature) {
  return feature?.properties?.name_preferred ??
    feature?.properties?.name ??
    feature?.text ??
    "";
}

function featureDistance(feature, origin) {
  const apiDistance = Number(feature?.properties?.distance);
  if (Number.isFinite(apiDistance)) {
    return apiDistance;
  }

  const coordinates = feature?.geometry?.coordinates;
  return Array.isArray(coordinates) && coordinates.length >= 2
    ? distanceInMeters(origin, coordinates)
    : Number.POSITIVE_INFINITY;
}

function isMetroFeature(feature) {
  const categoryIds = feature?.properties?.poi_category_ids ?? [];
  const maki = feature?.properties?.maki;
  return categoryIds.some((id) =>
    id === "light_rail_station" || id === "metro_station" || id === "subway_station"
  ) || maki === "rail-light" || maki === "rail-metro";
}

function makeSuggestion(feature, group, origin) {
  const rawName = cleanSuggestedName(featureName(feature));
  const englishName = group === "Metro"
    ? getMoscowMetroEnglishName(rawName)
    : undefined;
  const name = slugifySuggestedName(englishName ?? rawName);
  if (!name) return undefined;

  return {
    id: `${group}:${feature?.properties?.mapbox_id ?? feature?.id ?? name}`,
    group,
    name,
    distance: featureDistance(feature, origin),
  };
}

function deduplicate(suggestions) {
  const usedNames = new Set();
  return suggestions.filter((suggestion) => {
    const key = suggestion.name.toLocaleLowerCase();
    if (usedNames.has(key)) return false;
    usedNames.add(key);
    return true;
  });
}

function nearestInGroup(suggestions) {
  const validSuggestions = suggestions.filter(Boolean);
  const limit = GROUP_RESULT_LIMITS[validSuggestions[0]?.group] ?? MAX_RESULTS_PER_GROUP;
  return validSuggestions
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit);
}

export function createNameSuggestions({ railFeatures = [], airportFeatures = [], districtFeatures = [], origin }) {
  const metros = railFeatures
    .filter(isMetroFeature)
    .map((feature) => makeSuggestion(feature, "Metro", origin));
  const railways = railFeatures
    .filter((feature) => !isMetroFeature(feature))
    .map((feature) => makeSuggestion(feature, "Railway", origin));
  const airports = airportFeatures
    .map((feature) => makeSuggestion(feature, "Airport", origin))
    .filter((suggestion) => suggestion?.distance <= AIRPORT_MAX_DISTANCE_METERS);
  const districts = districtFeatures
    .map((feature) => makeSuggestion(feature, "District", origin));

  return deduplicate(
    [metros, railways, airports, districts].flatMap(nearestInGroup),
  );
}

export function slugifySuggestedName(name) {
  return cleanSuggestedName(name)
    .replace(/['’]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export function createDownloadFilename({ suggestionName, namingEnabled, center, zoom, bearing, size }) {
  if (namingEnabled) {
    const slug = slugifySuggestedName(suggestionName);
    if (slug) return `${slug}-${size}px.png`;
  }

  const rotation = Math.round(bearing);
  const rotationPart = rotation === 0 ? "" : `-${rotation}`;
  return `map-${center[0].toFixed(4)}-${center[1].toFixed(4)}-${zoom.toFixed(2)}${rotationPart}-${size}px.png`;
}
