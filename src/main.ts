import maplibregl from 'maplibre-gl';
import type { GeoJSONSource, LngLat, LngLatLike, Map as MlMap, Marker, Popup } from 'maplibre-gl';
import type { Feature, FeatureCollection, Point, Polygon, Position } from 'geojson';
import { VectorTile } from '@mapbox/vector-tile';
import * as pbfModule from 'pbf';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

// Različite verzije biblioteke "pbf" izvoze klasu na različite načine, ovo radi za sve
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Pbf: any = (pbfModule as any).default ?? (pbfModule as any).Pbf ?? (pbfModule as any).PbfReader;

// ---------- Postavke ----------
// Svi podaci dolaze iz pločica karte (OpenFreeMap / OpenStreetMap).
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const MAX_AREA_KM2 = 400;
const RADAR_ZOOM = 15.5;

// ---------- Stilovi (teme) ----------
// Vlastita imena umjesto imena igara - slobodno ih preimenuj u "label".
type Theme = {
  label: string;
  land: string;
  water: string;
  green: string;
  building: string;
  shadow: number; // jačina sjene zgrada
  road: string;
  mainRoad: string;
  highway: string;
  text: string;
  textHalo: string;
  accent: string; // boja okvira, gumba i naslova
  mask: string;
};

const THEMES: Record<string, Theme> = {
  // inspirirano Vice Cityjem: pijesak, tirkizno more, neon roza
  neon: {
    label: "Neon '86",
    land: '#d9c9a3',
    water: '#4fb4cc',
    green: '#93b06e',
    building: '#c3ae86',
    shadow: 0.25,
    road: '#f6f0e2',
    mainRoad: '#fffaf0',
    highway: '#ff5fa8',
    text: '#ff4f9e',
    textHalo: '#2a0f2a',
    accent: '#ff4f9e',
    mask: '#1b0f22',
  },
  // inspirirano San Andreasom: prašnjave zemljane boje, tamnoplavo more
  pustinja: {
    label: "Pustinja '92",
    land: '#958e73',
    water: '#2c4c84',
    green: '#6c7c47',
    building: '#7d7760',
    shadow: 0.35,
    road: '#d2ccb6',
    mainRoad: '#e9e3cd',
    highway: '#e3c26f',
    text: '#ffffff',
    textHalo: '#000000',
    accent: '#e8a33c',
    mask: '#15130e',
  },
  // inspirirano GTA V: tamno sivo, prigušeno
  moderna: {
    label: 'Moderna',
    land: '#2a2f33',
    water: '#3b5f80',
    green: '#30513a',
    building: '#3d4449',
    shadow: 0.45,
    road: '#9aa1a6',
    mainRoad: '#d0d4d8',
    highway: '#e0b84f',
    text: '#ffffff',
    textHalo: '#000000',
    accent: '#e0b84f',
    mask: '#0d0f10',
  },
  // inspirirano GTA VI: ljubičasta noć, tirkiz i roza
  tropik: {
    label: "Tropik '26",
    land: '#231c36',
    water: '#18a9c2',
    green: '#2d6a55',
    building: '#3b2f57',
    shadow: 0.5,
    road: '#b9a7e0',
    mainRoad: '#ffd0ea',
    highway: '#ff8a3d',
    text: '#ffd0ea',
    textHalo: '#2a0b3a',
    accent: '#ff4fa3',
    mask: '#0e0a18',
  },
};

function loadSavedTheme(): string {
  try {
    const saved = localStorage.getItem('mapa-tema');
    if (saved && THEMES[saved]) return saved;
  } catch {
    // localStorage nije dostupan, nije bitno
  }
  return 'moderna';
}

let themeId = loadSavedTheme();
const T = () => THEMES[themeId];

// Vrste mjesta koje prikazujemo kao "blipove"
const POI_TYPES = ['hospital', 'clinic', 'police', 'fire_station', 'fuel', 'pharmacy'];
const POI_ZOOM = 14; // najdetaljnija razina pločica, tu su sva mjesta
const PARALLEL_DOWNLOADS = 6;

// ---------- Elementi sučelja ----------
const btnDraw = document.querySelector<HTMLButtonElement>('#btn-draw')!;
const btnGenerate = document.querySelector<HTMLButtonElement>('#btn-generate')!;
const btnReset = document.querySelector<HTMLButtonElement>('#btn-reset')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const legendEl = document.querySelector<HTMLUListElement>('#legend')!;
const gtaEl = document.querySelector<HTMLDivElement>('#gta-map')!;
const hudEl = document.querySelector<HTMLDivElement>('#hud')!;

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

// ---------- Obična karta ----------
const map = new maplibregl.Map({
  container: 'map',
  style: STYLE_URL,
  center: [16.4, 44.6],
  zoom: 6.3,
  maxBounds: [
    [12.0, 41.5],
    [20.5, 47.2],
  ],
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

// Stanje nakon generiranja
let gtaMap: MlMap | null = null; // GTA prikaz preko označenog područja
let radar: MlMap | null = null; // minimapa
let gtaBox: BBox | null = null;
let player: Marker | null = null;
let popup: Popup | null = null;

// ---------- Odabir područja ----------
type BBox = { south: number; west: number; north: number; east: number };

let drawMode = false;
let start: LngLat | null = null;
let bbox: BBox | null = null;

function bboxFromPoints(a: LngLat, b: LngLat): BBox {
  return {
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
    west: Math.min(a.lng, b.lng),
    east: Math.max(a.lng, b.lng),
  };
}

function bboxRing(b: BBox): Position[] {
  return [
    [b.west, b.south],
    [b.east, b.south],
    [b.east, b.north],
    [b.west, b.north],
    [b.west, b.south],
  ];
}

function bboxCenter(b: BBox): [number, number] {
  return [(b.west + b.east) / 2, (b.south + b.north) / 2];
}

function inBox(b: BBox, lng: number, lat: number) {
  return lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north;
}

function areaKm2(b: BBox): number {
  const midLat = ((b.north + b.south) / 2) * (Math.PI / 180);
  const heightKm = (b.north - b.south) * 111.32;
  const widthKm = (b.east - b.west) * 111.32 * Math.cos(midLat);
  return heightKm * widthKm;
}

map.on('load', () => {
  map.addSource('selection', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'selection-fill',
    type: 'fill',
    source: 'selection',
    paint: { 'fill-color': '#e0b84f', 'fill-opacity': 0.15 },
  });
  map.addLayer({
    id: 'selection-line',
    type: 'line',
    source: 'selection',
    paint: { 'line-color': '#e0b84f', 'line-width': 2, 'line-dasharray': [2, 1] },
  });
});

btnDraw.addEventListener('click', () => {
  drawMode = true;
  btnDraw.classList.add('active');
  map.dragPan.disable();
  map.getCanvas().style.cursor = 'crosshair';
  setStatus('Povuci mišem pravokutnik preko područja.');
});

map.on('mousedown', (e) => {
  if (!drawMode) return;
  e.preventDefault();
  start = e.lngLat;
});

map.on('mousemove', (e) => {
  // Crtanje pravokutnika
  if (drawMode && start) {
    const b = bboxFromPoints(start, e.lngLat);
    const feature: Feature<Polygon> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [bboxRing(b)] },
    };
    (map.getSource('selection') as GeoJSONSource).setData(feature);
    return;
  }
  // Ruka kad je miš iznad blipa
  if (gtaMap?.getLayer('gta-poi')) {
    const hit = gtaMap.queryRenderedFeatures(e.point, { layers: ['gta-poi'] }).length > 0;
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
  }
});

map.on('mouseup', (e) => {
  if (!drawMode || !start) return;
  bbox = bboxFromPoints(start, e.lngLat);
  start = null;
  drawMode = false;
  btnDraw.classList.remove('active');
  map.dragPan.enable();
  map.getCanvas().style.cursor = '';

  const area = areaKm2(bbox);
  if (area > MAX_AREA_KM2) {
    setStatus(`Područje ima ${area.toFixed(0)} km², a najviše može ${MAX_AREA_KM2} km². Označi manje.`);
    btnGenerate.disabled = true;
  } else if (area < 0.01) {
    setStatus('Područje je premalo, povuci veći pravokutnik.');
    btnGenerate.disabled = true;
  } else {
    setStatus(`Odabrano ${area.toFixed(2)} km². Klikni "Generiraj mapu".`);
    btnGenerate.disabled = false;
  }
});

// ---------- GTA stil ----------

// Pronađi ime vektorskog izvora u stilu karte (kod OpenFreeMapa je to "openmaptiles")
function vectorSourceId(m: MlMap): string {
  const sources = m.getStyle().sources;
  const entry = Object.entries(sources).find(([, s]) => s.type === 'vector');
  if (!entry) throw new Error('Karta nema vektorski izvor podataka.');
  return entry[0];
}

// Sakrij sve slojeve osnovne karte osim mora/rijeka, i obojaj kopno
function applyGtaBase(m: MlMap) {
  for (const layer of m.getStyle().layers) {
    const id = layer.id;
    if (layer.type === 'background') {
      m.setPaintProperty(id, 'background-color', T().land);
      continue;
    }
    if (layer.type === 'fill' && id.startsWith('water')) {
      m.setPaintProperty(id, 'fill-color', T().water);
      m.setPaintProperty(id, 'fill-opacity', 1);
      continue;
    }
    m.setLayoutProperty(id, 'visibility', 'none');
  }
}

function addGtaLayers(m: MlMap) {
  const src = vectorSourceId(m);

  // Parkovi
  m.addLayer({
    id: 'gta-park',
    type: 'fill',
    source: src,
    'source-layer': 'park',
    paint: { 'fill-color': T().green },
  });

  // Šume i travnjaci
  m.addLayer({
    id: 'gta-landcover',
    type: 'fill',
    source: src,
    'source-layer': 'landcover',
    filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass']]],
    paint: { 'fill-color': T().green, 'fill-opacity': 0.8 },
  });

  // Rijeke i potoci
  m.addLayer({
    id: 'gta-waterways',
    type: 'line',
    source: src,
    'source-layer': 'waterway',
    paint: { 'line-color': T().water, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 4] },
  });

  // Sjena zgrada (pomaknuta dolje-desno) - daje dojam blokova kao u igri
  m.addLayer({
    id: 'gta-building-shadow',
    type: 'fill',
    source: src,
    'source-layer': 'building',
    minzoom: 13,
    paint: {
      'fill-color': '#000000',
      'fill-opacity': T().shadow,
      'fill-translate': [3, 3],
    },
  });

  // Zgrade
  m.addLayer({
    id: 'gta-buildings',
    type: 'fill',
    source: src,
    'source-layer': 'building',
    minzoom: 13,
    paint: { 'fill-color': T().building, 'fill-antialias': true },
  });

  // Ceste - debljina i boja ovise o vrsti ceste
  m.addLayer({
    id: 'gta-roads',
    type: 'line',
    source: src,
    'source-layer': 'transportation',
    filter: [
      'all',
      ['==', ['geometry-type'], 'LineString'],
      [
        'in',
        ['get', 'class'],
        ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']],
      ],
    ],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': [
        'match',
        ['get', 'class'],
        ['motorway', 'trunk'],
        T().highway,
        ['primary', 'secondary'],
        T().mainRoad,
        T().road,
      ],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        10,
        ['match', ['get', 'class'], ['motorway', 'trunk'], 2, ['primary', 'secondary'], 1.5, 0.5],
        17,
        [
          'match',
          ['get', 'class'],
          ['motorway', 'trunk'],
          16,
          ['primary', 'secondary'],
          12,
          ['tertiary', 'minor'],
          8,
          4,
        ],
      ],
    },
  });

  // Imena kvartova i naselja - velikim slovima, kao u GTA
  m.addLayer({
    id: 'gta-districts',
    type: 'symbol',
    source: src,
    'source-layer': 'place',
    filter: [
      'in',
      ['get', 'class'],
      ['literal', ['town', 'village', 'suburb', 'quarter', 'neighbourhood', 'hamlet']],
    ],
    layout: {
      'text-field': ['upcase', ['get', 'name']],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 16, 18],
      'text-letter-spacing': 0.2,
      'text-max-width': 8,
    },
    paint: {
      'text-color': T().text,
      'text-opacity': 0.9,
      'text-halo-color': T().textHalo,
      'text-halo-width': 2,
    },
  });
}

// ---------- Važna mjesta (blipovi) ----------

function lon2tile(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function lat2tile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

// Adresa pločica, npr. https://.../{z}/{x}/{y}.pbf
async function tileUrlTemplate(): Promise<string> {
  const s = map.getStyle().sources[vectorSourceId(map)] as { tiles?: string[]; url?: string };
  if (s.tiles?.length) return s.tiles[0];
  if (!s.url) throw new Error('Ne mogu pronaći adresu pločica karte.');
  const tileJson = await (await fetch(s.url)).json();
  return tileJson.tiles[0];
}

// Skini sve pločice za područje i izvuci iz njih bolnice, policiju, benzinske...
async function loadPois(b: BBox): Promise<FeatureCollection<Point>> {
  const template = await tileUrlTemplate();
  const z = POI_ZOOM;

  const jobs: [number, number][] = [];
  for (let x = lon2tile(b.west, z); x <= lon2tile(b.east, z); x++) {
    for (let y = lat2tile(b.north, z); y <= lat2tile(b.south, z); y++) {
      jobs.push([x, y]);
    }
  }
  const total = jobs.length;
  let done = 0;

  const seen = new Set<string>();
  const features: Feature<Point>[] = [];

  async function worker() {
    while (jobs.length) {
      const [x, y] = jobs.pop()!;
      try {
        const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        const res = await fetch(url);
        if (res.ok) {
          const tile = new VectorTile(new Pbf(await res.arrayBuffer()));
          const layer = tile.layers['poi'];
          for (let i = 0; layer && i < layer.length; i++) {
            const f = layer.feature(i);
            const subclass = String(f.properties.subclass ?? '');
            if (!POI_TYPES.includes(subclass)) continue;

            const geom = f.toGeoJSON(x, y, z).geometry;
            if (geom.type !== 'Point') continue;
            const [lon, lat] = geom.coordinates;
            if (!inBox(b, lon, lat)) continue;

            const name = String(f.properties.name ?? '');
            const key = `${subclass}|${name}|${lon.toFixed(4)}|${lat.toFixed(4)}`;
            if (seen.has(key)) continue; // isto mjesto može biti na rubu dviju pločica
            seen.add(key);

            features.push({
              type: 'Feature',
              properties: { subclass, name },
              geometry: { type: 'Point', coordinates: [lon, lat] },
            });
          }
        }
      } catch {
        // jedna neuspjela pločica ne smije srušiti sve
      }
      done++;
      setStatus(`Tražim bolnice, policiju, benzinske... ${done}/${total}`);
    }
  }

  await Promise.all(Array.from({ length: PARALLEL_DOWNLOADS }, worker));
  return { type: 'FeatureCollection', features };
}

// ---------- Ikonice ----------
// Vlastite jednostavne ikone, nacrtane kao SVG: krug u boji + bijeli simbol.

const POI_STYLE: Record<string, { color: string; label: string; glyph: (c: string) => string }> = {
  hospital: {
    color: '#d93636',
    label: 'Bolnica',
    glyph: () => '<path d="M20 12h8v8h8v8h-8v8h-8v-8h-8v-8h8z" fill="#fff"/>',
  },
  clinic: {
    color: '#d93636',
    label: 'Klinika',
    glyph: () => '<path d="M20 12h8v8h8v8h-8v8h-8v-8h-8v-8h8z" fill="#fff"/>',
  },
  police: {
    color: '#3466d9',
    label: 'Policija',
    glyph: (c) =>
        '<path d="M24 10l11 4v9c0 7.5-5 12.5-11 15-6-2.5-11-7.5-11-15v-9z" fill="#fff"/>' +
        `<path d="M24 17l2.1 4.4 4.8.6-3.5 3.3.9 4.8-4.3-2.4-4.3 2.4.9-4.8-3.5-3.3 4.8-.6z" fill="${c}"/>`,
  },
  fire_station: {
    color: '#e07b28',
    label: 'Vatrogasci',
    glyph: () =>
        '<path d="M24 9c2.5 6 10 9.5 10 18a10 10 0 0 1-20 0c0-4.5 2.2-7.6 4.5-9.6 0 3.3 1.6 5.6 3.8 5.6-1.2-5.3 0-10 1.7-14z" fill="#fff"/>',
  },
  fuel: {
    color: '#4b5157',
    label: 'Benzinska',
    glyph: (c) =>
        '<rect x="14" y="12" width="13" height="24" rx="2" fill="#fff"/>' +
        `<rect x="16.5" y="15" width="8" height="6" rx="1" fill="${c}"/>` +
        '<path d="M27 19h2.5a2 2 0 0 1 2 2v9a2 2 0 0 0 4 0V19.5L32 16" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  pharmacy: {
    color: '#2c9e52',
    label: 'Ljekarna',
    glyph: (c) =>
        '<g transform="rotate(-45 24 24)">' +
        '<rect x="12" y="18.5" width="24" height="11" rx="5.5" fill="#fff"/>' +
        `<path d="M24 20.5h6.5a3.5 3.5 0 0 1 0 7H24z" fill="${c}"/>` +
        '</g>',
  },
};

function iconSvg(type: string): string {
  const p = POI_STYLE[type];
  return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
      `<circle cx="24" cy="24" r="21" fill="${p.color}" stroke="#fff" stroke-width="3"/>` +
      p.glyph(p.color) +
      '</svg>'
  );
}

function iconUrl(type: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(type));
}

// Pretvori SVG ikone u slike koje karta može koristiti
async function loadIcons(): Promise<Record<string, HTMLImageElement>> {
  const result: Record<string, HTMLImageElement> = {};
  await Promise.all(
      Object.keys(POI_STYLE).map(async (type) => {
        const img = new Image(48, 48);
        img.src = iconUrl(type);
        await img.decode();
        result[type] = img;
      }),
  );
  return result;
}

// Legenda u izborniku koristi iste ikone
function renderLegend() {
  const shown = ['hospital', 'police', 'fire_station', 'fuel', 'pharmacy'];
  legendEl.innerHTML = shown
      .map((t) => `<li><img src="${iconUrl(t)}" alt="" width="24" height="24"> ${POI_STYLE[t].label}</li>`)
      .join('');
}

function addPoiLayers(m: MlMap, pois: FeatureCollection<Point>, icons: Record<string, HTMLImageElement>) {
  for (const [type, img] of Object.entries(icons)) {
    if (!m.hasImage(`blip-${type}`)) m.addImage(`blip-${type}`, img, { pixelRatio: 2 });
  }
  m.addSource('gta-pois', { type: 'geojson', data: pois });

  m.addLayer({
    id: 'gta-poi',
    type: 'symbol',
    source: 'gta-pois',
    layout: {
      'icon-image': ['concat', 'blip-', ['get', 'subclass']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.55, 13, 0.85, 17, 1.2],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}

// Promijeni boje GTA karte bez ponovnog učitavanja
function applyTheme(m: MlMap) {
  const t = T();
  for (const layer of m.getStyle().layers) {
    if (layer.type === 'background') m.setPaintProperty(layer.id, 'background-color', t.land);
    if (layer.type === 'fill' && layer.id.startsWith('water')) m.setPaintProperty(layer.id, 'fill-color', t.water);
  }
  const set = (layer: string, prop: string, value: unknown) => {
    if (m.getLayer(layer)) m.setPaintProperty(layer, prop, value);
  };
  set('gta-park', 'fill-color', t.green);
  set('gta-landcover', 'fill-color', t.green);
  set('gta-waterways', 'line-color', t.water);
  set('gta-building-shadow', 'fill-opacity', t.shadow);
  set('gta-buildings', 'fill-color', t.building);
  set('gta-roads', 'line-color', [
    'match',
    ['get', 'class'],
    ['motorway', 'trunk'],
    t.highway,
    ['primary', 'secondary'],
    t.mainRoad,
    t.road,
  ]);
  set('gta-districts', 'text-color', t.text);
  set('gta-districts', 'text-halo-color', t.textHalo);
  set('gta-border', 'line-color', t.accent);
  set('gta-mask', 'fill-color', t.mask);
}

// Boje sučelja (gumbi, naslov, minimapa) prate temu
function applyThemeToUi() {
  document.documentElement.style.setProperty('--gold', T().accent);
  document.body.dataset.theme = themeId;
  document.querySelectorAll<HTMLButtonElement>('.theme-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === themeId);
  });
}

function setTheme(id: string) {
  themeId = id;
  try {
    localStorage.setItem('mapa-tema', id);
  } catch {
    // nije bitno
  }
  applyThemeToUi();
  if (gtaMap) applyTheme(gtaMap);
  if (radar) applyTheme(radar);
}

// Gumbi za odabir stila
const themesEl = document.querySelector<HTMLDivElement>('#themes')!;
themesEl.innerHTML = Object.entries(THEMES)
    .map(([id, t]) => `<button class="theme-btn" data-theme="${id}">${t.label}</button>`)
    .join('');
themesEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.theme-btn');
  if (btn?.dataset.theme) setTheme(btn.dataset.theme);
});
applyThemeToUi();
renderLegend();

// Zlatni okvir oko GTA područja
function addBorder(m: MlMap, b: BBox) {
  m.addSource('gta-border', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: bboxRing(b) } },
  });
  m.addLayer({
    id: 'gta-border',
    type: 'line',
    source: 'gta-border',
    paint: { 'line-color': T().accent, 'line-width': 3 },
  });
}

// Zatamni sve izvan područja (za minimapu)
function addMask(m: MlMap, b: BBox) {
  const world: Position[] = [
    [-180, -85],
    [180, -85],
    [180, 85],
    [-180, 85],
    [-180, -85],
  ];
  m.addSource('gta-mask', {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [world, [...bboxRing(b)].reverse()] },
    },
  });
  m.addLayer({
    id: 'gta-mask',
    type: 'fill',
    source: 'gta-mask',
    paint: { 'fill-color': T().mask, 'fill-opacity': 0.85 },
  });
}

// Napravi novu kartu u GTA stilu i pričekaj da se učita
function createGtaMap(container: string, center: LngLatLike, zoom: number): Promise<MlMap> {
  const m = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center,
    zoom,
    interactive: false,
    attributionControl: false,
  });
  return new Promise((resolve) => {
    m.once('load', () => {
      applyGtaBase(m);
      addGtaLayers(m);
      resolve(m);
    });
  });
}

// GTA sloj prati običnu kartu i izrezuje se točno na označeno područje
function syncGta() {
  if (!gtaMap || !gtaBox) return;
  gtaMap.jumpTo({
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  });
  const b = gtaBox;
  const corners: [number, number][] = [
    [b.west, b.north],
    [b.east, b.north],
    [b.east, b.south],
    [b.west, b.south],
  ];
  const pts = corners.map((c) => map.project(c));
  gtaEl.style.clipPath = `polygon(${pts.map((p) => `${p.x}px ${p.y}px`).join(', ')})`;
}

// Klik: na blip pokaži ime, inače pomakni igrača
map.on('click', (e) => {
  if (!gtaMap || !gtaBox || !radar || drawMode) return;

  if (gtaMap.getLayer('gta-poi')) {
    const hit = gtaMap.queryRenderedFeatures(e.point, { layers: ['gta-poi'] })[0];
    if (hit) {
      popup?.remove();
      const name = (hit.properties?.name as string) || 'Bez imena';
      popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 })
          .setLngLat((hit.geometry as Point).coordinates as [number, number])
          .setText(name)
          .addTo(gtaMap);
      return;
    }
  }

  popup?.remove();
  popup = null;
  if (inBox(gtaBox, e.lngLat.lng, e.lngLat.lat)) {
    player?.setLngLat(e.lngLat);
    radar.easeTo({ center: e.lngLat, duration: 700 });
  }
});

// ---------- Generiranje ----------
btnGenerate.addEventListener('click', async () => {
  const b = bbox;
  if (!b) return;
  btnGenerate.disabled = true;
  btnDraw.disabled = true;

  try {
    setStatus('Pripremam mapu...');

    // Obična karta: makni žuti odabir i stani na područje
    map.setLayoutProperty('selection-fill', 'visibility', 'none');
    map.setLayoutProperty('selection-line', 'visibility', 'none');
    map.fitBounds(
        [
          [b.west, b.south],
          [b.east, b.north],
        ],
        { padding: 80, duration: 0 },
    );

    // GTA sloj i minimapa
    gtaEl.hidden = false;
    hudEl.hidden = false;
    const [gm, rm] = await Promise.all([
      createGtaMap('gta-map', map.getCenter(), map.getZoom()),
      createGtaMap('radar', bboxCenter(b), RADAR_ZOOM),
    ]);
    gtaMap = gm;
    radar = rm;
    gtaBox = b;

    addBorder(gm, b);
    addMask(rm, b);
    rm.setLayoutProperty('gta-districts', 'visibility', 'none');

    syncGta();
    map.on('move', syncGta);
    map.on('resize', syncGta);
    document.body.classList.add('gta-mode');

    // Blipovi
    const [pois, icons] = await Promise.all([loadPois(b), loadIcons()]);
    addPoiLayers(gm, pois, icons);
    addPoiLayers(rm, pois, icons);
    gm.moveLayer('gta-border');

    // Igrač u sredini područja
    const el = document.createElement('div');
    el.className = 'player-marker';
    player = new maplibregl.Marker({ element: el }).setLngLat(bboxCenter(b)).addTo(gm);

    setStatus(`Pronađeno ${pois.features.length} mjesta. Klikni na mapu da pomakneš igrača, klik na ikonu pokazuje ime.`);
    legendEl.hidden = false;
    btnDraw.hidden = true;
    btnGenerate.hidden = true;
    btnReset.hidden = false;
  } catch (err) {
    setStatus(`Greška: ${(err as Error).message}`);
    btnGenerate.disabled = false;
    btnDraw.disabled = false;
  }
});

btnReset.addEventListener('click', () => location.reload());