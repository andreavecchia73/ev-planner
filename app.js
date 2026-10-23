import {
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
  'from', 'to', 'batteryKwh', 'maxDcKw', 'startPct', 'arriveMinPct', 'chargeToPct',
  'reservePct', 'tempC', 'ocmKey',
];
// Valori di partenza: Toyota Proace City Electric, batteria 50 kWh. La potenza DC va verificata sulla scheda tecnica.
const DEFAULTS = {
  batteryKwh: 50,
  maxDcKw: 100,
  startPct: 90,
  arriveMinPct: 10,
  chargeToPct: 80,
  reservePct: 5,
  tempC: 15,
};
const ANNOUNCE_KM = 0.3; // annuncio vocale quando la manovra è a 300 m
const ZOOM_HYSTERESIS = 0.75; // lo zoom cambia solo se la scala ideale si discosta di questo valore
const MIN_HEADING_KM = 0.015; // sotto 15 m il rumore del GPS non dice nulla sulla direzione
const RECALC_COOLDOWN_MS = 60000; // evita ricalcoli ripetuti mentre la carica resta sotto la scorta
const DEFAULT_SPEED_KMH = 30; // velocità assunta finché il GPS non la fornisce
const ALTITUDE_STEP_KM = 2; // un campione di altitudine ogni 2 km

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
    kw: Math.max(0, ...(poi.Connections ?? []).map((c) => c.PowerKW ?? 0)),
  }));
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
    arriveMinPct: Number(form.arriveMinPct),
    chargeToPct: Number(form.chargeToPct),
    reservePct: Number(form.reservePct),
    findChargers: (point, radiusKm) => fetchChargers(point, radiusKm, form.ocmKey.trim()),
  };
}

// Percorso da un punto a un altro: profilo di consumo per tipo di strada e dislivello, soste di ricarica.
async function planRoute(from, to, form, startPct, { nearestFirst = false } = {}) {
  const { points, steps } = await fetchRoute(from, to);
  const cum = cumulativeKm(points);
  const totalKm = cum.at(-1);
  const altitudeAt = await fetchAltitudeAt(points, cum);
  const profile = buildProfile(steps, { totalKm, tempC: Number(form.tempC), altitudeAt });
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
const map = L.map('map').setView([45, 9], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap',
  keepBuffer: 4, // più tile ai bordi: meno vuoti durante la rotazione
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
    soc: null, // carica stimata o riallineata, in %
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
    prevFix: null,
    panelH: 0,
    socSource: 'stimata', // 'reale' quando arriva la batteria da Home Assistant
  };
  $('nav').hidden = false;
  document.body.classList.add('navigating');
  // controlli Leaflet rimossi in guida: ruoterebbero con la mappa
  map.zoomControl?.remove();
  map.attributionControl?.remove();
  map.dragging.disable();
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

  const speedMs = speedFor(fix, pos);
  updateHeading(fix, pos);
  $('nav-gps').textContent = `Precisione GPS ±${Math.round(pos.coords.accuracy)} m · © OpenStreetMap`;
  if (nav.follow) followMap(fix, speedMs);
  else placeMarker(fix);
  if ($('nav').offsetHeight !== nav.panelH) layoutMap(); // il pannello cambia altezza: la freccia si riposiziona
  refresh();
}

// Bridge verso l'app Android (display dell'auto): nel browser non esiste e viene ignorato.
function pushToCar(state) {
  try {
    window.EvBridge?.update(JSON.stringify(state));
  } catch {
    // bridge non disponibile
  }
}

// Batteria letta da Home Assistant (app Android, ogni 2 minuti): riallinea la stima e ripianifica le soste.
window.evSetBattery = (pct) => {
  if (!nav || !trip || !Number.isFinite(pct)) return;
  nav.soc = pct;
  nav.socSource = 'reale';
  recalculate();
};

// Aggiorna manovra, dashboard e controllo della scorta.
function refresh() {
  if (!nav || nav.km === null || !trip) return;
  const km = nav.km;
  const totalKm = trip.cum.at(-1);
  const socAt = (targetKm) => nav.soc - pctBetween(km, targetKm);
  const reserve = Number(trip.form.reservePct);

  const step = nextAhead(trip.steps, km);
  const isLastStep = step && step === trip.steps.at(-1);
  $('nav-next').textContent = !step ? 'Percorso completato' : isLastStep ? 'Destinazione' : step.text;
  $('nav-dist').textContent = step ? `tra ${formatDistance(step.km - km)}` : '';
  if (step && step.km - km < ANNOUNCE_KM && nav.announced !== step.km) {
    nav.announced = step.km;
    speak(`${step.text}, tra ${formatDistance(step.km - km)}`);
  }

  const stop = nextAhead(trip.result.stops, km);
  const remainingKm = totalKm - km;
  const chargeLeft = trip.result.stops
    .filter((s) => s.km > km)
    .reduce((sum, s) => sum + s.chargeMinutes, 0);
  const minutes = minutesBetween(trip.profile, km, totalKm) + chargeLeft;

  const stopMinutes = stop ? minutesBetween(trip.profile, km, stop.km) : null;
  const rows = [
    ['Batteria', `${Math.round(nav.soc)}% ${nav.socSource}`],
    ['Prossima tappa', stop ? `${formatDistance(stop.km - km)} · ${formatMinutes(stopMinutes)}` : 'nessuna'],
    ['Arrivo', `${formatDistance(remainingKm)} · ${formatMinutes(minutes)}`],
    ['Carica alla tappa', stop ? `${socAt(stop.km).toFixed(0)}%` : '—'],
    ['Scorta', `${reserve}%`],
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

  pushToCar({
    soc: Math.round(nav.soc),
    stopName: stop ? stop.name : null,
    stopKm: stop ? stop.km - km : null,
    stopMin: stop ? stopMinutes : null,
    arrivalKm: remainingKm,
    arrivalMin: minutes,
  });

  if (!nav.busy) {
    setNavWarn(
      nav.offRouteKm > 0.1
        ? `Fuori percorso di circa ${Math.round(nav.offRouteKm * 1000)} m: premi "Ricalcola da qui"`
        : nav.notice,
    );
  }

  // Carica prevista sotto la scorta alla prossima tappa (o all'arrivo, se non ci sono tappe).
  const socAtTarget = stop ? socAt(stop.km) : socAt(totalKm);
  if (socAtTarget < reserve && !nav.busy && Date.now() - nav.lastRecalc > RECALC_COOLDOWN_MS) {
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
    const planned = await planRoute(nav.lastFix, trip.destination, trip.form, pct, { nearestFirst });
    if (!nav) return; // navigazione terminata durante il calcolo
    trip = { ...planned, destination: trip.destination, form: trip.form };
    nav.hint = 0;
    nav.km = 0;
    nav.soc = pct;
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
    nav.marker = L.circleMarker([fix.lat, fix.lon], { radius: 8, color: '#1a73e8', fillOpacity: 1 }).addTo(map);
  } else {
    nav.marker.setLatLng([fix.lat, fix.lon]);
  }
}

// Vista di guida: il contenitore della mappa è più grande dello schermo e ruota attorno alla freccia,
// fissa al centro dell'area sopra il pannello. Così la rotazione non lascia angoli vuoti.
function arrowY() {
  return (window.innerHeight - $('nav').offsetHeight) / 2;
}

function layoutMap() {
  if (!nav) return;
  const el = map.getContainer();
  const arrow = $('nav-arrow');
  nav.panelH = $('nav').offsetHeight;
  if (nav.follow) {
    const size = Math.ceil(2 * Math.hypot(window.innerWidth / 2, window.innerHeight * 0.75));
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left = `${window.innerWidth / 2 - size / 2}px`;
    el.style.top = `${arrowY() - size / 2}px`;
    arrow.style.top = `${arrowY()}px`;
  } else {
    for (const prop of ['width', 'height', 'left', 'top', 'transform']) el.style[prop] = '';
  }
  arrow.hidden = !nav.follow;
  map.invalidateSize({ pan: false });
}

// Centro sulla posizione e zoom che mostra l'area raggiungibile in 5 minuti alla velocità attuale,
// con più dettaglio sotto i 30 km/h (rotonde, svincoli). Lo zoom cambia a livelli interi e solo oltre
// una soglia: niente cambi a ogni fix, niente lampeggi.
function followMap(fix, speedMs) {
  if (!nav) return;
  nav.speedMs = speedMs;
  const speedKmh = speedMs != null ? speedMs * 3.6 : DEFAULT_SPEED_KMH;

  const target = zoomForRadius(viewRadiusKm(speedKmh), fix.lat, window.innerWidth);
  let animate = false;
  if (nav.zoom === null) {
    nav.zoom = Math.round(target);
  } else if (Math.abs(target - nav.zoom) >= ZOOM_HYSTERESIS) {
    const next = Math.round(target);
    animate = next !== nav.zoom;
    nav.zoom = next;
  }
  map.setView(fix, nav.zoom, { animate });
  map.getContainer().style.transform = `rotate(${-nav.heading}deg)`;
}

function toggleFollow() {
  if (!nav) return;
  nav.follow = !nav.follow;
  if (nav.follow) {
    map.dragging.disable();
    if (nav.marker) {
      nav.marker.remove();
      nav.marker = null;
    }
    nav.zoom = null;
    layoutMap();
    if (nav.lastFix) followMap(nav.lastFix, nav.speedMs);
  } else {
    map.dragging.enable();
    layoutMap();
    if (nav.lastFix) {
      map.setView(nav.lastFix, map.getZoom(), { animate: false });
      placeMarker(nav.lastFix);
    }
  }
  $('recenter').textContent = nav.follow ? 'Vista libera' : 'Segui';
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
  $('nav-arrow').hidden = true;
  document.body.classList.remove('navigating');
  map.dragging.enable();
  map.zoomControl?.addTo(map);
  map.attributionControl?.addTo(map);
  for (const prop of ['width', 'height', 'left', 'top', 'transform']) map.getContainer().style[prop] = '';
  map.invalidateSize();
  if (trip) renderMap(trip.points, trip.result.stops);
}

fillForm();
$('trip').addEventListener('submit', onSubmit);
$('startNav').addEventListener('click', startNavigation);
$('recalc').addEventListener('click', () => recalculate());
$('stopNav').addEventListener('click', stopNavigation);
$('recenter').addEventListener('click', toggleFollow);
window.addEventListener('resize', () => layoutMap());
