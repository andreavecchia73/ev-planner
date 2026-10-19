import { planTrip, cumulativeKm, routeSteps, locateOnRoute, nextAhead } from './planner.js';

const STORAGE_KEY = 'ev-planner-settings';
const FIELDS = [
  'from', 'to', 'batteryKwh', 'consumptionKwh100', 'maxDcKw', 'startPct',
  'arriveMinPct', 'chargeToPct', 'reservePct', 'tempC', 'avgKmh', 'ocmKey',
];
const DEFAULTS = {
  batteryKwh: 60,
  consumptionKwh100: 18,
  maxDcKw: 150,
  startPct: 90,
  arriveMinPct: 10,
  chargeToPct: 80,
  reservePct: 5,
  tempC: 15,
  avgKmh: 100,
};
const ANNOUNCE_KM = 0.3; // annuncio vocale quando la manovra è a 300 m

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stato del viaggio pianificato e della navigazione in corso.
let trip = null;
let nav = null;

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

// Parametri del pianificatore a partire dal form (campi salvati come stringhe).
function planParams(form, startPct) {
  return {
    vehicle: {
      batteryKwh: Number(form.batteryKwh),
      consumptionWhPerKm: Number(form.consumptionKwh100) * 10, // kWh/100 km → Wh/km
      maxDcKw: Number(form.maxDcKw),
    },
    conditions: { tempC: Number(form.tempC), avgKmh: Number(form.avgKmh) },
    startPct,
    arriveMinPct: Number(form.arriveMinPct),
    chargeToPct: Number(form.chargeToPct),
    reservePct: Number(form.reservePct),
    findChargers: (point, radiusKm) => fetchChargers(point, radiusKm, form.ocmKey.trim()),
  };
}

// Percorso da un punto a un altro, con soste di ricarica e passi di guida.
async function planRoute(from, to, form, startPct) {
  const { points, steps } = await fetchRoute(from, to);
  const result = await planTrip({ points, ...planParams(form, startPct) });
  return { points, cum: cumulativeKm(points), steps: routeSteps(steps), result };
}

// Mappa
const map = L.map('map').setView([45, 9], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap',
}).addTo(map);
const layer = L.layerGroup().addTo(map);

function renderMap(points, stops, fit = true) {
  layer.clearLayers();
  const line = L.polyline(points.map((p) => [p.lat, p.lon]), { color: '#0a7d4f' });
  layer.addLayer(line);
  for (const stop of stops) {
    const label = document.createElement('div');
    label.textContent = `${stop.name} (${stop.kw} kW)`;
    L.marker([stop.lat, stop.lon]).bindPopup(label).addTo(layer);
  }
  if (fit) map.fitBounds(line.getBounds(), { padding: [20, 20] });
}

// Risultato: tutto il testo passa da textContent, perché i nomi delle colonnine vengono da fonti esterne.
function renderResult(result) {
  const summary = [
    ['Distanza', `${result.totalKm.toFixed(0)} km`],
    ['Tempo di guida', formatMinutes(result.drivingMinutes)],
    ['Tempo di ricarica', formatMinutes(result.chargeMinutes)],
    ['Tempo totale', formatMinutes(result.totalMinutes)],
    ['Consumo stimato', `${(result.consumptionKwhPerKm * 100).toFixed(1)} kWh/100 km`],
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

    trip = { ...planned, destination: to, form };
    renderResult(planned.result);
    renderMap(planned.points, planned.result.stops);
    $('startNav').hidden = false;
    setStatus('');
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
  nav = { hint: 0, announced: null, lastFix: null, watchId: null, wakeLock: null, marker: null };
  $('navPct').value = trip.form.startPct;
  $('nav').hidden = false;
  setNavWarn('In attesa del segnale GPS…');
  nav.watchId = navigator.geolocation.watchPosition(onFix, onGpsError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 20000,
  });
  keepScreenOn();
}

function onFix(pos) {
  if (!nav || !trip) return;
  const fix = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  nav.lastFix = fix;

  const loc = locateOnRoute(trip.points, trip.cum, fix, nav.hint);
  nav.hint = loc.index;
  const km = loc.km;
  const totalKm = trip.cum.at(-1);

  const step = nextAhead(trip.steps, km);
  $('nav-next').textContent = step ? step.text : 'Percorso completato';
  $('nav-dist').textContent = step ? `tra ${formatDistance(step.km - km)}` : '';
  if (step && step.km - km < ANNOUNCE_KM && nav.announced !== step.km) {
    nav.announced = step.km;
    speak(`${step.text}, tra ${formatDistance(step.km - km)}`);
  }

  const stop = nextAhead(trip.result.stops, km);
  $('nav-stop').textContent = stop
    ? `Colonnina: ${stop.name} · ${formatDistance(stop.km - km)} · arrivo ${stop.arrivalPct.toFixed(0)}% → ${stop.departPct.toFixed(0)}% · ${Math.round(stop.chargeMinutes)} min`
    : 'Nessuna sosta prevista';

  const remainingKm = totalKm - km;
  const chargeLeft = trip.result.stops
    .filter((s) => s.km > km)
    .reduce((sum, s) => sum + s.chargeMinutes, 0);
  const minutes = (remainingKm / Number(trip.form.avgKmh)) * 60 + chargeLeft;
  $('nav-eta').textContent = `Restano ${formatDistance(remainingKm)} · arrivo tra ${formatMinutes(minutes)}`;

  if (loc.offRouteKm > 0.1) {
    setNavWarn(`Fuori percorso di circa ${Math.round(loc.offRouteKm * 1000)} m: premi "Ricalcola da qui"`);
  } else {
    setNavWarn('');
  }
  $('nav-gps').textContent = `Precisione GPS ±${Math.round(pos.coords.accuracy)} m`;

  if (!nav.marker) {
    nav.marker = L.circleMarker([fix.lat, fix.lon], { radius: 8, color: '#1a73e8', fillOpacity: 1 }).addTo(map);
  } else {
    nav.marker.setLatLng([fix.lat, fix.lon]);
  }
}

function onGpsError(err) {
  const text =
    err.code === 1
      ? 'Permesso di posizione negato: abilitalo nelle impostazioni del browser'
      : `GPS non disponibile (${err.message})`;
  setNavWarn(text);
}

// Ricalcolo dalla posizione attuale, con la batteria inserita nel pannello.
async function recalculate() {
  if (!nav?.lastFix) {
    setNavWarn('Attendi un segnale GPS prima di ricalcolare');
    return;
  }
  setNavWarn('Ricalcolo del percorso…');
  try {
    const pct = Number($('navPct').value);
    const planned = await planRoute(nav.lastFix, trip.destination, trip.form, pct);
    trip = { ...planned, destination: trip.destination, form: trip.form };
    nav.hint = 0;
    nav.announced = null;
    renderMap(trip.points, trip.result.stops, false);
    setNavWarn('');
  } catch (err) {
    setNavWarn(err.message);
  }
}

function stopNavigation() {
  if (!nav) return;
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
}

fillForm();
$('trip').addEventListener('submit', onSubmit);
$('startNav').addEventListener('click', startNavigation);
$('recalc').addEventListener('click', recalculate);
$('stopNav').addEventListener('click', stopNavigation);
