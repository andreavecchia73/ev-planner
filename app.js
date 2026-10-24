import {
  EV_FLOOR_PCT,
  MODEL,
  laneAngle,
  maneuverKind,
  planTrip,
  cumulativeKm,
  routeSteps,
  locateOnRoute,
  nextAhead,
  viewRadiusKm,
  zoomForRadius,
  haversineKm,
  bearingDeg,
  smoothAngle,
  buildProfile,
  makeAltitudeAt,
  energyBetween,
  minutesBetween,
} from './planner.js';

const STORAGE_KEY = 'ev-planner-settings';
const FIELDS = [
  'from', 'to', 'vehicle', 'batteryKwh', 'maxDcKw', 'startPct', 'chargeToPct', 'petrolMotorway',
  'petrolExpressway', 'petrolUrban', 'petrolPrice',
  'reservePct', 'tempC', 'evdcPrice', 'ocmKey', 'tomtomKey', 'haUrl', 'haEntity', 'haToken',
  'sheetUrl', 'sheetSecret',
];
// Consumi per tipo di strada in kWh/100 km. Il modello PHEV usa il consumo misto anche per superstrada e centro.
const VEHICLES = {
  phev: {
    label: 'Jaecoo 7 PHEV',
    batteryKwh: 18,
    maxDcKw: 40,
    rates: { motorway: 20, expressway: 14, urban: 14 },
  },
  proace: {
    label: 'Toyota Proace City Electric',
    batteryKwh: 50,
    maxDcKw: 100, // da verificare sulla scheda tecnica
    rates: { motorway: 22, expressway: 18, urban: 15 },
  },
};
const DEFAULTS = {
  vehicle: 'phev',
  batteryKwh: 18,
  maxDcKw: 40,
  startPct: 90,
  petrolMotorway: 18, // L/100 km
  petrolExpressway: 20,
  petrolUrban: 24,
  petrolPrice: 2, // €/L, modificabile
  chargeToPct: 80,
  reservePct: 5,
  tempC: 15,
};
const ANNOUNCE_KM = 0.3; // annuncio vocale quando la manovra è a 300 m
const ZOOM_HYSTERESIS = 0.75; // lo zoom cambia solo se la scala ideale si discosta di questo valore
const MIN_HEADING_KM = 0.015; // sotto 15 m il rumore del GPS non dice nulla sulla direzione
const RECALC_COOLDOWN_MS = 60000; // evita ricalcoli ripetuti mentre la carica resta sotto la scorta
const FUEL_KWH_PER_L = 8.9; // energia contenuta in un litro di benzina (valore standard)
const RECORD_INTERVAL_MS = 30000; // un campione dei sensori ogni 30 secondi durante il viaggio
const DEFAULT_SPEED_KMH = 30; // velocità assunta finché il GPS non la fornisce
const ALTITUDE_STEP_KM = 2; // un campione di altitudine ogni 2 km
// Dati fissi per la scelta delle soste.
const STOP_TARGET_PCT = 20; // carica di arrivo alla colonnina da privilegiare
const STOP_MAX_OFFROUTE_KM = 3; // distanza massima della colonnina dal percorso
const LEARN_MIN_KM = 1; // distanza minima tra due letture per stimare il consumo reale
const LEARN_MIN_KWH = 0.2; // energia prevista minima per una stima affidabile

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stato del viaggio pianificato e della navigazione in corso.
let trip = null;
let nav = null;
let lastCarPct = null; // ultima batteria letta da Home Assistant, anche se arriva prima dell'avvio

// Impostazioni per-utente: utili ma non essenziali, quindi ogni accesso è protetto.
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // archiviazione non disponibile: il calcolo funziona lo stesso
  }
}

function fillForm() {
  const saved = loadSettings();
  for (const field of FIELDS) {
    $(field).value = saved[field] ?? DEFAULTS[field] ?? '';
  }
  // Prima apertura: i valori di batteria e potenza seguono il modello, non quelli salvati prima.
  if (!saved.vehicle) applyVehicle(DEFAULTS.vehicle);
}

function applyVehicle(key) {
  const vehicle = VEHICLES[key] ?? VEHICLES[DEFAULTS.vehicle];
  $('vehicle').value = key in VEHICLES ? key : DEFAULTS.vehicle;
  $('batteryKwh').value = vehicle.batteryKwh;
  $('maxDcKw').value = vehicle.maxDcKw;
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// Servizi esterni: Nominatim per la geocodifica, OSRM per il percorso, OpenChargeMap per le colonnine,
// Open-Meteo per l'altimetria.
async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'it' } });
  if (!res.ok) throw new Error(`Geocodifica fallita (HTTP ${res.status})`);
  const data = await res.json();
  if (!data.length) throw new Error(`Luogo non trovato: ${query}`);
  return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
}

async function fetchRoute(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Percorso fallito (HTTP ${res.status})`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('Nessun percorso stradale trovato');
  const route = data.routes[0];
  return {
    points: route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    steps: route.legs.flatMap((leg) => leg.steps),
  };
}

// Altitudini campionate ogni ALTITUDE_STEP_KM. Se il servizio non risponde il calcolo prosegue in piano.
async function fetchAltitudeAt(points, cum) {
  const indexes = [];
  let next = 0;
  for (let i = 0; i < points.length; i++) {
    if (cum[i] >= next) {
      indexes.push(i);
      next += ALTITUDE_STEP_KM;
    }
  }
  if (indexes.at(-1) !== points.length - 1) indexes.push(points.length - 1);

  try {
    const altitudes = [];
    for (let start = 0; start < indexes.length; start += 100) {
      const chunk = indexes.slice(start, start + 100).map((i) => points[i]);
      const params = new URLSearchParams({
        latitude: chunk.map((p) => p.lat.toFixed(5)).join(','),
        longitude: chunk.map((p) => p.lon.toFixed(5)).join(','),
      });
      const res = await fetch(`https://api.open-meteo.com/v1/elevation?${params}`);
      if (!res.ok) throw new Error(`Altimetria: HTTP ${res.status}`);
      const data = await res.json();
      altitudes.push(...data.elevation);
    }
    return makeAltitudeAt(indexes.map((i) => cum[i]), altitudes);
  } catch {
    return null;
  }
}

async function fetchChargers(point, radiusKm, key) {
  const params = new URLSearchParams({
    output: 'json',
    latitude: point.lat,
    longitude: point.lon,
    distance: radiusKm,
    distanceunit: 'KM',
    maxresults: 100,
  });
  if (key) params.set('key', key);
  const res = await fetch(`https://api.openchargemap.io/v3/poi/?${params}`);
  if (!res.ok) throw new Error(`OpenChargeMap: HTTP ${res.status}`);
  const pois = await res.json();
  return pois.map((poi) => ({
    lat: poi.AddressInfo.Latitude,
    lon: poi.AddressInfo.Longitude,
    name: poi.AddressInfo.Title,
    usageCost: poi.UsageCost ?? '',
    kw: Math.max(0, ...(poi.Connections ?? []).map((c) => c.PowerKW ?? 0)),
  }));
}

// Ritardo dovuto al traffico tra due punti (TomTom Routing). Senza chiave non fa nulla.
async function fetchTraffic(from, to, key) {
  if (!key) return null;
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${from.lat},${from.lon}:${to.lat},${to.lon}/json?key=${encodeURIComponent(key)}&traffic=true&computeTravelTimeFor=all&routeType=fastest`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TomTom: HTTP ${res.status}`);
  const data = await res.json();
  const summary = data.routes?.[0]?.summary;
  if (!summary) return null;
  return {
    travelMin: summary.travelTimeInSeconds / 60,
    delayMin: (summary.trafficDelayInSeconds ?? 0) / 60,
  };
}

// Parametri del pianificatore a partire dal form (campi salvati come stringhe).
function planParams(form, startPct) {
  return {
    vehicle: {
      batteryKwh: Number(form.batteryKwh),
      maxDcKw: Number(form.maxDcKw),
    },
    conditions: { tempC: Number(form.tempC) },
    startPct,
    chargeToPct: Number(form.chargeToPct),
    reservePct: Number(form.reservePct),
    targetArrivalPct: STOP_TARGET_PCT,
    maxOffRouteKm: STOP_MAX_OFFROUTE_KM,
    fuel: {
      l100: {
        motorway: Number(form.petrolMotorway),
        expressway: Number(form.petrolExpressway),
        urban: Number(form.petrolUrban),
      },
      pricePerL: Number(form.petrolPrice),
      chargePrice: (stop) => priceFromText(stop.usageCost) ?? (Number(form.evdcPrice) || null),
    },
    findChargers: (point, radiusKm) => fetchChargers(point, radiusKm, form.ocmKey.trim()),
  };
}

// Percorso da un punto a un altro: profilo di consumo per tipo di strada e dislivello, soste di ricarica.
async function planRoute(from, to, form, startPct, { nearestFirst = false, learnedFactor = 1 } = {}) {
  const { points, steps } = await fetchRoute(from, to);
  const cum = cumulativeKm(points);
  const totalKm = cum.at(-1);
  const altitudeAt = await fetchAltitudeAt(points, cum);
  const rates = (VEHICLES[form.vehicle] ?? VEHICLES[DEFAULTS.vehicle]).rates;
  const profile = buildProfile(steps, { totalKm, tempC: Number(form.tempC), altitudeAt, rates, learnedFactor });
  const result = await planTrip({ points, profile, nearestFirst, ...planParams(form, startPct) });
  return {
    points,
    cum,
    steps: routeSteps(steps),
    profile,
    result,
    startPct,
    altitudeFound: altitudeAt !== null,
  };
}

// Mappa
// Mappa vettoriale (MapLibre): in guida si alterna la vista 2D e 3D con edifici toccando la mappa.
const EMPTY_LINE = { type: 'FeatureCollection', features: [] };
const ROUTE_SOURCE = 'route';
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [9, 45],
  zoom: 6,
});
let routeReady = false;
let stopMarkers = [];

map.on('load', () => {
  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: EMPTY_LINE });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: ROUTE_SOURCE,
    paint: { 'line-color': '#0a7d4f', 'line-width': 6 },
  });
  // edifici in 3D: visibili solo nella vista inclinata
  map.addLayer({
    id: 'buildings-3d',
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 14,
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': '#d6d2c8',
      'fill-extrusion-height': ['get', 'render_height'],
      'fill-extrusion-base': ['get', 'render_min_height'],
      'fill-extrusion-opacity': 0.85,
    },
  });
  routeReady = true;
  if (trip) renderMap(trip.points, trip.result.stops);
});

function renderMap(points, stops, fit = true) {
  if (!routeReady) return;
  const coords = points.map((p) => [p.lon, p.lat]);
  map.getSource(ROUTE_SOURCE).setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }],
  });
  for (const marker of stopMarkers) marker.remove();
  stopMarkers = stops.map((stop) => {
    const el = document.createElement('div');
    el.className = 'stop-marker';
    el.textContent = '⚡';
    const popup = new maplibregl.Popup({ offset: 16 }).setText(`${stop.name} (${stop.kw} kW)`);
    return new maplibregl.Marker({ element: el }).setLngLat([stop.lon, stop.lat]).setPopup(popup).addTo(map);
  });
  if (fit) {
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: 20 });
  }
}

// Risultato: tutto il testo passa da textContent, perché i nomi delle colonnine vengono da fonti esterne.
// Costo totale delle soste; se per qualche colonnina manca il prezzo, il totale è parziale.
function chargeCostLabel(result) {
  const costs = result.stops.map(stopCost);
  if (!costs.length) return '—';
  const known = costs.filter((c) => c !== null);
  if (!known.length) return 'prezzo non disponibile';
  const total = known.reduce((sum, c) => sum + c, 0).toFixed(2);
  return known.length === costs.length ? `${total} €` : `${total} € (parziale)`;
}

function renderResult(result, traffic = null) {
  const summary = [
    ['Distanza', `${result.totalKm.toFixed(0)} km`],
    ['Tempo di guida', formatMinutes(result.drivingMinutes)],
    ['Tempo di ricarica', formatMinutes(result.chargeMinutes)],
    ['Costo ricarica', chargeCostLabel(result)],
    ['Costo totale', `${result.totalCostEur.toFixed(2)} €`],
    ...(result.petrol ? [['Benzina', `${result.petrol.litres.toFixed(1)} L da km ${result.petrol.fromKm.toFixed(0)} · ${result.petrol.cost.toFixed(2)} €`]] : []),
    ...(traffic ? [['Ritardo traffico', `+${Math.round(traffic.delayMin)} min`]] : []),
    ['Tempo totale', formatMinutes(result.totalMinutes)],
    ['Consumo medio', `${(result.consumptionKwhPerKm * 100).toFixed(1)} kWh/100 km`],
    ['SoC all\'arrivo', `${result.finalPct.toFixed(0)}%`],
    ['Soste', String(result.stops.length)],
  ];
  const dl = $('summary');
  dl.replaceChildren();
  for (const [term, value] of summary) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  const list = $('stops');
  list.replaceChildren();
  for (const stop of result.stops) {
    const li = document.createElement('li');
    li.textContent =
      `${stop.name} · km ${stop.km.toFixed(0)} · ${stop.kw} kW · ` +
      `arrivo ${stop.arrivalPct.toFixed(0)}% → ${stop.departPct.toFixed(0)}% · ` +
      `${Math.round(stop.chargeMinutes)} min` +
      (stopCost(stop) === null ? '' : ` · ${stopCost(stop).toFixed(2)} €`);
    list.append(li);
  }
  $('result').hidden = false;
}

// Prezzo in €/kWh da un testo come "0,79 €/kWh" o "0.69 EUR per kWh"; null se non c'è.
function priceFromText(text) {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:€|EUR)?\s*(?:\/|per)\s*kWh/i.exec(text ?? '');
  return m ? Number(m[1].replace(',', '.')) : null;
}

// Costo della ricarica alla colonnina: prezzo della colonnina, altrimenti quello predefinito.
function stopCost(stop) {
  return stop.costEur ?? null;
}

function formatMinutes(total) {
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function formatDistance(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

async function onSubmit(event) {
  event.preventDefault();
  const form = Object.fromEntries(FIELDS.map((f) => [f, $(f).value]));
  saveSettings(form);

  const button = $('plan');
  button.disabled = true;
  $('result').hidden = true;
  $('startNav').hidden = true;
  setStatus('Calcolo in corso…');

  try {
    const from = await geocode(form.from);
    await sleep(1100); // Nominatim: massimo una richiesta al secondo
    const to = await geocode(form.to);
    const planned = await planRoute(from, to, form, Number(form.startPct));
    const traffic = await fetchTraffic(from, to, form.tomtomKey.trim()).catch(() => null);

    trip = { ...planned, destination: to, form, traffic };
    renderResult(planned.result, traffic);
    renderMap(planned.points, planned.result.stops);
    $('startNav').hidden = false;
    setStatus(planned.altitudeFound ? '' : 'Altimetria non disponibile: consumo calcolato senza dislivelli.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    button.disabled = false;
  }
}

// --- Navigazione GPS ---------------------------------------------------------

// Lettura vocale: se il browser non la supporta, la navigazione resta solo visiva.
function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'it-IT';
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  } catch {
    // voce non disponibile
  }
}

function setNavWarn(text) {
  $('nav-warn').textContent = text;
}

// Percentuale di batteria consumata tra due km del percorso, con il profilo del viaggio corrente.
function pctBetween(a, b) {
  return (energyBetween(trip.profile, a, b) / Number(trip.form.batteryKwh)) * 100;
}

async function keepScreenOn() {
  try {
    if (nav) nav.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Wake Lock non supportato: lo schermo può spegnersi durante il percorso
  }
}

document.addEventListener('visibilitychange', () => {
  if (nav && document.visibilityState === 'visible') keepScreenOn();
});

function startNavigation() {
  if (!trip) return;
  if (!window.isSecureContext || !navigator.geolocation) {
    setStatus('La navigazione richiede HTTPS e un browser con geolocalizzazione.', true);
    return;
  }
  nav = {
    hint: 0,
    km: null, // posizione lungo il percorso, in km
    soc: lastCarPct, // batteria reale da Home Assistant se già disponibile, altrimenti stimata
    socSource: lastCarPct === null ? 'stimata' : 'reale',
    record: startRecord(),
    announced: null,
    lastFix: null,
    lastRecalc: 0,
    busy: false,
    offRouteKm: 0,
    notice: '', // ultimo esito del ricalcolo: resta visibile finché non cambia
    watchId: null,
    wakeLock: null,
    marker: null,
    follow: true, // la mappa segue la posizione finché non la sblocchi
    zoom: null,
    speedMs: null,
    prevTime: null,
    heading: 0, // rotta in gradi, 0 = nord
    view3d: false, // vista 2D o 3D con edifici
    traffic: null, // ritardo da traffico dalla posizione attuale
    trafficAt: 0,
    trafficBusy: false,
    prevFix: null,
    panelH: 0,
    learnedFactor: 1, // correzione dei consumi ricavata dalle letture reali
    anchor: null, // ultimo punto noto (km e carica) da cui misurare il consumo reale
  };
  $('nav').hidden = false;
  document.body.classList.add('navigating');
  // in guida la mappa non si sposta col dito: si segue la posizione
  map.dragPan.disable();
  map.on('click', toggleView3d);
  layoutMap();
  setNavWarn('In attesa del segnale GPS…');
  nav.watchId = navigator.geolocation.watchPosition(onFix, onGpsError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 20000,
  });
  keepScreenOn();
}

// Velocità dal GPS, oppure stimata dagli ultimi due fix se il dispositivo non la fornisce.
function speedFor(fix, pos) {
  if (pos.coords.speed != null && pos.coords.speed >= 0) return pos.coords.speed;
  if (!nav.prevFix || nav.prevTime === null || pos.timestamp <= nav.prevTime) return null;
  return (haversineKm(nav.prevFix, fix) * 1000) / ((pos.timestamp - nav.prevTime) / 1000);
}

function onFix(pos) {
  if (!nav || !trip) return;
  const fix = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  nav.lastFix = fix;

  const loc = locateOnRoute(trip.points, trip.cum, fix, nav.hint);
  nav.hint = loc.index;
  nav.offRouteKm = loc.offRouteKm;

  // La carica si stima dal profilo del viaggio, con la batteria riallineata dallo slider.
  if (nav.soc === null) nav.soc = trip.startPct - pctBetween(0, loc.km);
  else if (nav.km !== null && loc.km > nav.km) nav.soc -= pctBetween(nav.km, loc.km);
  nav.km = loc.km;
  if (!nav.anchor) nav.anchor = { km: nav.km, pct: nav.soc };

  const speedMs = speedFor(fix, pos);
  recordSample();
  updateHeading(fix, pos);
  $('nav-gps').textContent = `Precisione GPS ±${Math.round(pos.coords.accuracy)} m · © OpenStreetMap`;
  if (nav.follow) followMap(fix, speedMs);
  else placeMarker(fix);
  if ($('nav').offsetHeight !== nav.panelH) layoutMap(); // il pannello cambia altezza: la freccia si riposiziona
  refresh();
}

// Tipo di manovra per il display dell'auto: arrivo, rotonda, uscita, svolta sinistra/destra, dritto.
function stepType(step) {
  const { kind, angle } = maneuverKind(step);
  if (kind === 'arrive') return 'arrive';
  if (kind === 'roundabout') return 'roundabout';
  if (kind === 'exit') return 'exit';
  if (angle <= -20) return 'left';
  if (angle >= 20) return 'right';
  return 'straight';
}

// Credenziali di Home Assistant: la pagina le passa all'app Android, che le salva sul telefono.
function syncHomeAssistant() {
  try {
    window.EvBridge?.saveHomeAssistant(JSON.stringify({
      url: $('haUrl').value.trim(),
      entity: $('haEntity').value.trim(),
      token: $('haToken').value.trim(),
    }));
  } catch {
    // bridge non disponibile nel browser
  }
}

// Bridge verso l'app Android (display dell'auto): nel browser non esiste e viene ignorato.
function pushToCar(state) {
  try {
    window.EvBridge?.update(JSON.stringify(state));
  } catch {
    // bridge non disponibile
  }
}

// Sensori dell'auto inviati dall'app Android ogni 30 secondi (null se non disponibili).
let carState = null;
window.evSetCar = (car) => {
  carState = { ...car, at: Date.now() };
};

// Batteria letta da Home Assistant (app Android, ogni 2 minuti): riallinea la stima e ripianifica le soste.
// Confronta l'energia reale (calo di batteria) con quella prevista dal profilo, e corregge i consumi.
function learnFromReading(pct) {
  const anchor = nav.anchor;
  if (!anchor || nav.km === null) return;
  const travelled = nav.km - anchor.km;
  if (travelled < LEARN_MIN_KM) return;
  const measuredKwh = ((anchor.pct - pct) / 100) * Number(trip.form.batteryKwh);
  const predictedKwh = energyBetween(trip.profile, anchor.km, nav.km);
  if (measuredKwh <= 0 || predictedKwh < LEARN_MIN_KWH) return;
  const ratio = Math.min(1.8, Math.max(0.5, measuredKwh / predictedKwh));
  // correzione graduale: una lettura non deve ribaltare il modello
  nav.learnedFactor = Math.min(1.6, Math.max(0.6, nav.learnedFactor * (0.8 + 0.2 * ratio)));
}

window.evSetBattery = (pct) => {
  if (!Number.isFinite(pct)) return;
  lastCarPct = pct;
  if (!nav || !trip) return;
  learnFromReading(pct);
  nav.soc = pct;
  nav.socSource = 'reale';
  recalculate();
};

// Riquadro in alto a sinistra: icona della prossima manovra, con le corsie da prendere se ci sono.
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

function svgIcon(size, children) {
  const svg = svgEl('svg', { viewBox: '0 0 40 40', width: size, height: size, 'aria-hidden': 'true' });
  svg.append(...children);
  return svg;
}

// Freccia ruotata di angle gradi (0 = dritto).
function arrowChildren(angle) {
  const group = svgEl('g', { transform: `rotate(${angle} 20 20)` });
  group.append(
    svgEl('path', { d: 'M20 34 V10', stroke: 'currentColor', 'stroke-width': 4, 'stroke-linecap': 'round', fill: 'none' }),
    svgEl('path', {
      d: 'M11 19 L20 8 L29 19',
      stroke: 'currentColor',
      'stroke-width': 4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      fill: 'none',
    }),
  );
  return [group];
}

function turnIcon(step) {
  const { kind, angle, exit } = maneuverKind(step);
  if (kind === 'arrive') {
    return svgIcon(40, [svgEl('circle', { cx: 20, cy: 20, r: 10, fill: 'currentColor' })]);
  }
  if (kind === 'roundabout') {
    const svg = svgIcon(40, [svgEl('circle', { cx: 20, cy: 20, r: 12, stroke: 'currentColor', 'stroke-width': 3, fill: 'none' })]);
    if (exit) {
      const label = svgEl('text', { x: 20, y: 25, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 700, fill: 'currentColor' });
      label.textContent = String(exit);
      svg.append(label);
    }
    return svg;
  }
  const children = arrowChildren(angle);
  if (kind === 'exit') {
    // uscita autostradale: freccia con la sigla USC
    const label = svgEl('text', { x: 20, y: 39, 'text-anchor': 'middle', 'font-size': 8, 'font-weight': 700, fill: 'currentColor' });
    label.textContent = 'USC';
    children.push(label);
  }
  return svgIcon(40, children);
}

function renderLanes(lanes) {
  const box = $('turn-lanes');
  box.replaceChildren();
  box.hidden = lanes.length === 0;
  for (const lane of lanes) {
    const wrap = document.createElement('span');
    wrap.className = lane.valid ? 'lane valid' : 'lane';
    wrap.append(svgIcon(26, arrowChildren(laneAngle(lane.indications))));
    box.append(wrap);
  }
}

function updateTurn(step, km) {
  const box = $('nav-turn');
  box.hidden = !step;
  if (!step) return;
  $('turn-icon').replaceChildren(turnIcon(step));
  $('turn-text').textContent = `${step.text} · ${formatDistance(step.km - km)}`;
  renderLanes(step.lanes ?? []);
}

// Carica all'arrivo alla colonnina e tempo per arrivare al 100% con la potenza disponibile.
function stopChargeLabel(arrivalPct, kw) {
  const arrival = Math.max(0, arrivalPct);
  const avgKw = Math.min(Number(trip.form.maxDcKw), kw) * MODEL.averageChargeFactor;
  if (!(avgKw > 0)) return `${arrival.toFixed(0)}%`;
  const kwh = ((100 - arrival) / 100) * Number(trip.form.batteryKwh);
  const minutes = (kwh / MODEL.chargeEfficiency / avgKw) * 60;
  return `${arrival.toFixed(0)}% · 100% in ${formatMinutes(minutes)}`;
}

// Ritardo da traffico dalla posizione attuale, aggiornato al massimo ogni 5 minuti.
const TRAFFIC_REFRESH_MS = 300000;
function refreshTraffic() {
  const key = trip.form.tomtomKey.trim();
  if (!key || !nav.lastFix || nav.trafficBusy || Date.now() - nav.trafficAt < TRAFFIC_REFRESH_MS) return;
  nav.trafficBusy = true;
  nav.trafficAt = Date.now();
  fetchTraffic(nav.lastFix, trip.destination, key)
    .then((traffic) => {
      if (nav) nav.traffic = traffic;
    })
    .catch(() => {})
    .finally(() => {
      if (nav) nav.trafficBusy = false;
    });
}

// Aggiorna manovra, dashboard e controllo della scorta.
function refresh() {
  if (!nav || nav.km === null || !trip) return;
  const km = nav.km;
  const totalKm = trip.cum.at(-1);
  const socAt = (targetKm) => nav.soc - pctBetween(km, targetKm);

  const step = nextAhead(trip.steps, km);
  const isLastStep = step && step === trip.steps.at(-1);
  $('nav-next').textContent = !step ? 'Percorso completato' : isLastStep ? 'Destinazione' : step.text;
  $('nav-dist').textContent = step ? `tra ${formatDistance(step.km - km)}` : '';
  if (step && step.km - km < ANNOUNCE_KM && nav.announced !== step.km) {
    nav.announced = step.km;
    speak(`${step.text}, tra ${formatDistance(step.km - km)}`);
  }

  refreshTraffic();

  const stop = nextAhead(trip.result.stops, km);
  const remainingKm = totalKm - km;
  const chargeLeft = trip.result.stops
    .filter((s) => s.km > km)
    .reduce((sum, s) => sum + s.chargeMinutes, 0);
  const minutes = minutesBetween(trip.profile, km, totalKm) + chargeLeft;

  const stopMinutes = stop ? minutesBetween(trip.profile, km, stop.km) : null;
  const rows = [
    ['Batteria', `${Math.max(0, Math.round(nav.soc))}% ${nav.socSource}${nav.socSource === 'stimata' ? ' · in attesa di Home Assistant' : ''}`],
    ['Traffico', nav.traffic ? `+${Math.round(nav.traffic.delayMin)} min` : '—'],
    ['Prossima tappa', stop ? `${formatDistance(stop.km - km)} · ${formatMinutes(stopMinutes)}` : 'nessuna'],
    ['Arrivo', `${formatDistance(remainingKm)} · ${formatMinutes(minutes)}`],
    ['Carica alla tappa', stop ? stopChargeLabel(socAt(stop.km), stop.kw) : '—'],
    ...(trip.result.petrol ? [['Benzina', `da km ${trip.result.petrol.fromKm.toFixed(0)} · ${trip.result.petrol.litres.toFixed(1)} L`]] : []),
  ];
  const dash = $('nav-dash');
  dash.replaceChildren();
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dash.append(dt, dd);
  }

  updateTurn(step, km);
  pushToCar({
    soc: Math.max(0, Math.round(nav.soc)),
    stopName: stop ? stop.name : null,
    stopKm: stop ? stop.km - km : null,
    stopMin: stop ? stopMinutes : null,
    arrivalKm: remainingKm,
    arrivalMin: minutes,
    stepText: step ? step.text : null,
    stepKm: step ? step.km - km : null,
    stepType: step ? stepType(step) : null,
  });

  if (!nav.busy) {
    setNavWarn(
      nav.offRouteKm > 0.1
        ? `Fuori percorso di circa ${Math.round(nav.offRouteKm * 1000)} m: premi "Ricalcola da qui"`
        : nav.notice,
    );
  }

  // Tappa saltata senza ricarica: il piano si ricalcola dalla posizione attuale.
  const skipped = trip.result.stops.some((s) => s.km < km - 0.3);
  if (skipped && !nav.busy && Date.now() - nav.lastRecalc > RECALC_COOLDOWN_MS) {
    recalculate();
  }

  // Carica prevista sotto la scorta alla prossima tappa (o all'arrivo, se non ci sono tappe).
  if (stop && socAt(stop.km) < EV_FLOOR_PCT && !nav.busy && Date.now() - nav.lastRecalc > RECALC_COOLDOWN_MS) {
    recalculate({ nearestFirst: true });
  }
}

function onGpsError(err) {
  const text =
    err.code === 1
      ? 'Permesso di posizione negato: abilitalo nelle impostazioni del browser'
      : `GPS non disponibile (${err.message})`;
  setNavWarn(text);
}

// Ricalcolo dalla posizione attuale con la carica riallineata. Con nearestFirst sceglie la sosta più vicina.
async function recalculate({ nearestFirst = false } = {}) {
  if (!nav?.lastFix) {
    setNavWarn('Attendi un segnale GPS prima di ricalcolare');
    return;
  }
  if (nav.busy) return;
  nav.busy = true;
  nav.lastRecalc = Date.now();
  const pct = Math.max(0, Math.round(nav.soc));
  setNavWarn(nearestFirst ? 'Carica sotto la scorta: cerco la sosta più vicina…' : 'Ricalcolo del piano di viaggio…');
  try {
    const planned = await planRoute(nav.lastFix, trip.destination, trip.form, pct, {
      nearestFirst,
      learnedFactor: nav.learnedFactor,
    });
    if (!nav) return; // navigazione terminata durante il calcolo
    trip = { ...planned, destination: trip.destination, form: trip.form };
    nav.hint = 0;
    nav.km = 0;
    nav.soc = pct;
    nav.anchor = { km: 0, pct };
    nav.announced = null;
    nav.notice = nearestFirst ? `Nuova sosta: ${trip.result.stops[0]?.name ?? 'nessuna'}` : '';
    renderMap(trip.points, trip.result.stops, false);
    refresh();
  } catch (err) {
    if (!nav) return;
    nav.notice = nearestFirst ? `Carica sotto la scorta, nessuna alternativa: ${err.message}` : err.message;
  } finally {
    if (nav) setNavWarn(nav.notice);
    if (nav) nav.busy = false;
  }
}

// Direzione di marcia: dal GPS quando ci si muove, altrimenti dal rumore tra due posizioni.
// La rotta viene attenuata per evitare che la mappa ruoti a scatti.
function updateHeading(fix, pos) {
  if (!nav.prevFix) {
    nav.prevFix = fix;
    nav.prevTime = pos.timestamp;
    return;
  }
  const moved = haversineKm(nav.prevFix, fix);
  const gpsHeading = pos.coords.heading;
  let target = null;
  if (gpsHeading != null && !Number.isNaN(gpsHeading) && (pos.coords.speed ?? 0) > 1.5) {
    target = gpsHeading;
  } else if (moved > MIN_HEADING_KM) {
    target = bearingDeg(nav.prevFix, fix);
  }
  if (target !== null) nav.heading = smoothAngle(nav.heading, target, 0.35);
  if (moved > MIN_HEADING_KM) {
    nav.prevFix = fix;
    nav.prevTime = pos.timestamp;
  }
}

function placeMarker(fix) {
  if (!nav.marker) {
    const el = document.createElement('div');
    el.className = 'user-dot';
    nav.marker = new maplibregl.Marker({ element: el }).setLngLat([fix.lon, fix.lat]).addTo(map);
  } else {
    nav.marker.setLngLat([fix.lon, fix.lat]);
  }
}

// Il punto di vista è centrato nell'area sopra il pannello: il padding della mappa lo tiene libero.
function arrowY() {
  return (window.innerHeight - $('nav').offsetHeight) / 2;
}

function layoutMap() {
  if (!nav) return;
  nav.panelH = $('nav').offsetHeight;
  map.setPadding({ top: 0, bottom: nav.panelH, left: 0, right: 0 });
  const arrow = $('nav-arrow');
  arrow.style.top = `${arrowY()}px`;
  arrow.hidden = !nav.follow;
  map.resize();
}

// Vista di guida: centro sulla posizione, zoom in base alla velocità, rotazione nel senso di marcia.
function followMap(fix, speedMs) {
  if (!nav) return;
  nav.speedMs = speedMs;
  const speedKmh = speedMs != null ? speedMs * 3.6 : DEFAULT_SPEED_KMH;

  const target = zoomForRadius(viewRadiusKm(speedKmh), fix.lat, window.innerWidth);
  if (nav.zoom === null || Math.abs(target - nav.zoom) >= ZOOM_HYSTERESIS) nav.zoom = Math.round(target);
  map.easeTo({
    center: [fix.lon, fix.lat],
    zoom: nav.zoom,
    bearing: nav.heading,
    pitch: nav.view3d ? 60 : 0,
    duration: 500,
    essential: true,
  });
}

// Tocco sulla mappa in guida: alterna la vista 2D e 3D con gli edifici.
function toggleView3d() {
  if (!nav) return;
  nav.view3d = !nav.view3d;
  map.setLayoutProperty('buildings-3d', 'visibility', nav.view3d ? 'visible' : 'none');
  if (nav.follow && nav.lastFix) followMap(nav.lastFix, nav.speedMs);
}

function toggleFollow() {
  if (!nav) return;
  nav.follow = !nav.follow;
  if (nav.follow) {
    map.dragPan.disable();
    if (nav.marker) {
      nav.marker.remove();
      nav.marker = null;
    }
    nav.zoom = null;
    layoutMap();
    if (nav.lastFix) followMap(nav.lastFix, nav.speedMs);
  } else {
    map.dragPan.enable();
    map.easeTo({ bearing: 0, pitch: 0, duration: 300 });
    layoutMap();
    if (nav.lastFix) {
      map.jumpTo({ center: [nav.lastFix.lon, nav.lastFix.lat] });
      placeMarker(nav.lastFix);
    }
  }
  $('recenter').textContent = nav.follow ? 'Vista libera' : 'Segui';
}

// --- Storico dei viaggi -----------------------------------------------------

function startRecord() {
  return {
    startedAt: new Date().toISOString(),
    from: trip.form.from,
    to: trip.form.to,
    plannedKwh100: trip.result.consumptionKwhPerKm * 100,
    plannedMinutes: trip.result.totalMinutes,
    stops: trip.result.stops.length,
    chargeCostEur: trip.result.chargeCostEur,
    samples: [],
  };
}

// Campione dei sensori dell'auto e del piano, con lo stesso intervallo per tutto il viaggio.
function recordSample() {
  const rec = nav?.record;
  if (!rec || nav.km === null) return;
  const now = Date.now();
  if (rec.samples.length && now - rec.samples.at(-1).t < RECORD_INTERVAL_MS) return;
  const car = carState ?? {};
  rec.samples.push({
    t: now,
    km: nav.km,
    soc: nav.soc,
    odo: car.odometerKm ?? null,
    fuelL: car.fuelL ?? null,
    engineOn: car.engineOn ?? null,
    currentA: car.currentA ?? null,
    voltageV: car.voltageV ?? null,
  });
}

// Energia delle batteria dalla tensione e dalla corrente (positiva in scarica, negativa in carica).
function batteryKwhFromCurrent(samples) {
  let kwh = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.voltageV == null || b.voltageV == null || a.currentA == null || b.currentA == null) continue;
    const powerKw = ((a.voltageV * a.currentA + b.voltageV * b.currentA) / 2) / 1000;
    kwh += powerKw * ((b.t - a.t) / 3600000);
  }
  return kwh;
}

// Riepilogo del viaggio con i consumi reali. E ruote = benzina + batteria netta − ricarica alle colonnine.
function tripSummary(rec) {
  const first = rec.samples[0];
  const last = rec.samples.at(-1);
  const batteryKwh = Number(trip.form.batteryKwh);
  const odoKm = first.odo != null && last.odo != null ? last.odo - first.odo : null;
  const km = odoKm ?? last.km - first.km;
  const litres = first.fuelL != null && last.fuelL != null ? first.fuelL - last.fuelL : 0;
  const fuelKwh = litres * FUEL_KWH_PER_L;
  const netBatteryKwh = batteryKwhFromCurrent(rec.samples);
  // ricarica alle colonnine prelevata dalla rete: stimata dalle soste passate durante il viaggio
  const gridKwh = trip.result.stops
    .filter((s) => s.km <= last.km + first.km + 0.5 && s.gridKwh)
    .reduce((sum, s) => sum + s.gridKwh, 0);
  const wheelKwh = fuelKwh + netBatteryKwh - gridKwh;
  const engineMin = rec.samples.reduce((sum, s, i) => {
    if (i === 0 || !rec.samples[i - 1].engineOn) return sum;
    return sum + (s.t - rec.samples[i - 1].t) / 60000;
  }, 0);
  return {
    'data inizio': rec.startedAt,
    da: rec.from,
    a: rec.to,
    'km totali': round(km, 1),
    'km percorso': round(last.km, 1),
    'soc inizio %': first.soc != null ? round(first.soc, 0) : '',
    'soc fine %': last.soc != null ? round(last.soc, 0) : '',
    'benzina usata L': round(litres, 2),
    'motore acceso min': round(engineMin, 1),
    'batteria netta kWh': round(netBatteryKwh, 2),
    'ricarica rete kWh stimata': round(gridKwh, 2),
    'energia ruote kWh': round(wheelKwh, 2),
    'consumo reale kWh/100km': km > 0 ? round((wheelKwh / km) * 100, 2) : '',
    'consumo previsto kWh/100km': round(rec.plannedKwh100, 2),
    'tempo previsto min': round(rec.plannedMinutes, 0),
    soste: rec.stops,
    'costo ricarica €': rec.chargeCostEur != null ? round(rec.chargeCostEur, 2) : '',
    'batteria kWh': batteryKwh,
  };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// Invio del riepilogo al foglio Google (Apps Script). Senza indirizzo non fa nulla.
function finishRecord() {
  const rec = nav?.record;
  if (!rec || rec.samples.length < 2) return;
  const url = trip.form.sheetUrl.trim();
  if (!url) return;
  const row = tripSummary(rec);
  fetch(url, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ secret: trip.form.sheetSecret.trim(), row }),
  }).catch(() => {});
}

function stopNavigation() {
  if (!nav) return;
  finishRecord();
  navigator.geolocation.clearWatch(nav.watchId);
  nav.wakeLock?.release().catch(() => {});
  if (nav.marker) nav.marker.remove();
  try {
    speechSynthesis.cancel();
  } catch {
    // voce non disponibile
  }
  nav = null;
  $('nav').hidden = true;
  $('nav-arrow').hidden = true;
  $('nav-turn').hidden = true;
  document.body.classList.remove('navigating');
  map.dragPan.enable();
  map.off('click', toggleView3d);
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  map.easeTo({ bearing: 0, pitch: 0, duration: 300 });
  map.setLayoutProperty('buildings-3d', 'visibility', 'none');
  if (trip) renderMap(trip.points, trip.result.stops);
}

fillForm();
syncHomeAssistant();
for (const id of ['haUrl', 'haEntity', 'haToken']) $(id).addEventListener('change', syncHomeAssistant);
$('trip').addEventListener('submit', onSubmit);
$('startNav').addEventListener('click', startNavigation);
$('recalc').addEventListener('click', () => recalculate());
$('stopNav').addEventListener('click', stopNavigation);
$('recenter').addEventListener('click', toggleFollow);
$('vehicle').addEventListener('change', () => applyVehicle($('vehicle').value));
window.addEventListener('resize', () => layoutMap());
