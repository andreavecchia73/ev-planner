import { planTrip } from './planner.js';

const STORAGE_KEY = 'ev-planner-settings';
const FIELDS = [
  'from', 'to', 'batteryKwh', 'consumptionWhPerKm', 'maxDcKw', 'startPct',
  'arriveMinPct', 'chargeToPct', 'reservePct', 'tempC', 'avgKmh', 'ocmKey',
];
const DEFAULTS = {
  batteryKwh: 60,
  consumptionWhPerKm: 180,
  maxDcKw: 150,
  startPct: 90,
  arriveMinPct: 10,
  chargeToPct: 80,
  reservePct: 5,
  tempC: 15,
  avgKmh: 100,
};

const $ = (id) => document.getElementById(id);
const num = (id) => Number($(id).value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// Servizi esterni: Nominatim per la geocodifica, OSRM per il percorso, OpenChargeMap per le colonnine.
async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'it' } });
  if (!res.ok) throw new Error(`Geocodifica fallita (HTTP ${res.status})`);
  const data = await res.json();
  if (!data.length) throw new Error(`Luogo non trovato: ${query}`);
  return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
}

async function fetchRoute(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Percorso fallito (HTTP ${res.status})`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('Nessun percorso stradale trovato');
  return data.routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
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
    kw: Math.max(0, ...(poi.Connections ?? []).map((c) => c.PowerKW ?? 0)),
  }));
}

// Mappa
const map = L.map('map').setView([45, 9], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap',
}).addTo(map);
const layer = L.layerGroup().addTo(map);

function renderMap(points, stops) {
  layer.clearLayers();
  const line = L.polyline(points.map((p) => [p.lat, p.lon]), { color: '#0a7d4f' });
  layer.addLayer(line);
  for (const stop of stops) {
    const label = document.createElement('div');
    label.textContent = `${stop.name} (${stop.kw} kW)`;
    L.marker([stop.lat, stop.lon]).bindPopup(label).addTo(layer);
  }
  map.fitBounds(line.getBounds(), { padding: [20, 20] });
}

// Risultato: tutto il testo passa da textContent, perché i nomi delle colonnine vengono da fonti esterne.
function renderResult(result) {
  const summary = [
    ['Distanza', `${result.totalKm.toFixed(0)} km`],
    ['Tempo di guida', formatMinutes(result.drivingMinutes)],
    ['Tempo di ricarica', formatMinutes(result.chargeMinutes)],
    ['Tempo totale', formatMinutes(result.totalMinutes)],
    ['Consumo stimato', `${(result.consumptionKwhPerKm * 1000).toFixed(0)} Wh/km`],
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
      `${Math.round(stop.chargeMinutes)} min`;
    list.append(li);
  }
  $('result').hidden = false;
}

function formatMinutes(total) {
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

async function onSubmit(event) {
  event.preventDefault();
  const form = { ...Object.fromEntries(FIELDS.map((f) => [f, $(f).value])) };
  saveSettings(form);

  const button = $('plan');
  button.disabled = true;
  $('result').hidden = true;
  setStatus('Calcolo in corso…');

  try {
    const from = await geocode(form.from);
    await sleep(1100); // Nominatim: massimo una richiesta al secondo
    const to = await geocode(form.to);
    const points = await fetchRoute(from, to);

    const key = form.ocmKey.trim();
    const result = await planTrip({
      points,
      vehicle: {
        batteryKwh: num('batteryKwh'),
        consumptionWhPerKm: num('consumptionWhPerKm'),
        maxDcKw: num('maxDcKw'),
      },
      conditions: { tempC: num('tempC'), avgKmh: num('avgKmh') },
      startPct: num('startPct'),
      arriveMinPct: num('arriveMinPct'),
      chargeToPct: num('chargeToPct'),
      reservePct: num('reservePct'),
      findChargers: (point, radiusKm) => fetchChargers(point, radiusKm, key),
    });

    renderResult(result);
    renderMap(points, result.stops);
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    button.disabled = false;
  }
}

fillForm();
$('trip').addEventListener('submit', onSubmit);
