// Logica di pianificazione senza dipendenze di rete.
// Tutti i parametri arrivano dall'utente (consumo misurato sulla propria auto,
// capacità batteria, potenza DC massima). Le costanti in MODEL sono euristiche da tarare.

export const MODEL = {
  comfortLowC: 20,
  comfortHighC: 25,
  coldPerDegC: 0.01, // +1% consumo per grado sotto i 20 °C
  hotPerDegC: 0.005, // +0,5% consumo per grado sopra i 25 °C
  highwayKmh: 90,
  highwayPerKmh: 0.006, // +0,6% consumo per km/h di media sopra i 90 km/h
  chargeEfficiency: 0.9, // energia da rete -> batteria
  averageChargeFactor: 0.6, // potenza media sulla sessione rispetto al picco (curva di carica)
};

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// Distanza progressiva in km di ogni punto del percorso.
export function cumulativeKm(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + haversineKm(points[i - 1], points[i]));
  }
  return out;
}

// Punto del percorso alla distanza km indicata (interpolazione lineare).
export function pointAt(points, cum, km) {
  if (km <= 0) return points[0];
  const last = cum.length - 1;
  if (km >= cum[last]) return points[last];
  let i = 1;
  while (cum[i] < km) i++;
  const segment = cum[i] - cum[i - 1];
  const t = segment === 0 ? 0 : (km - cum[i - 1]) / segment;
  return {
    lat: points[i - 1].lat + t * (points[i].lat - points[i - 1].lat),
    lon: points[i - 1].lon + t * (points[i].lon - points[i - 1].lon),
  };
}

// Indice del vertice del percorso più vicino a un punto (per proiettare la colonnina sul percorso).
function nearestIndex(points, p) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = haversineKm(points[i], p);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// Consumo stimato in kWh/km a partire dal consumo misurato in Wh/km.
export function consumptionKwhPerKm(vehicle, conditions) {
  const { tempC, avgKmh } = conditions;
  let factor = 1;
  if (tempC < MODEL.comfortLowC) factor += (MODEL.comfortLowC - tempC) * MODEL.coldPerDegC;
  else if (tempC > MODEL.comfortHighC) factor += (tempC - MODEL.comfortHighC) * MODEL.hotPerDegC;
  factor += Math.max(0, avgKmh - MODEL.highwayKmh) * MODEL.highwayPerKmh;
  return (vehicle.consumptionWhPerKm / 1000) * factor;
}

// Pianifica il viaggio con soste di ricarica greedy: a ogni sosta sceglie la colonnina
// più potente raggiungibile con la riserva, poi ricarica fino a chargeToPct.
// findChargers(point, radiusKm) deve restituire [{ lat, lon, name, kw }].
export async function planTrip({
  points,
  vehicle,
  conditions,
  startPct,
  arriveMinPct,
  chargeToPct,
  reservePct,
  findChargers,
  nearestFirst = false, // primo stop: la colonnina più vicina invece della più potente
  maxStops = 15,
}) {
  const cum = cumulativeKm(points);
  const totalKm = cum[cum.length - 1];
  const cons = consumptionKwhPerKm(vehicle, conditions);
  const kmFor = (fromPct, floorPct) =>
    Math.max(0, ((fromPct - floorPct) / 100) * vehicle.batteryKwh) / cons;
  const pctUsed = (km) => ((km * cons) / vehicle.batteryKwh) * 100;

  const stops = [];
  let pos = 0;
  let soc = startPct;

  while (pos + kmFor(soc, arriveMinPct) < totalKm) {
    if (stops.length >= maxStops) {
      throw new Error(`Servono più di ${maxStops} soste: controlla consumo e parametri`);
    }

    const reachKm = pos + kmFor(soc, reservePct);
    const searchKm = pos + (reachKm - pos) * 0.85;
    const at = pointAt(points, cum, searchKm);

    let found = await findChargers(at, 25);
    if (!found.length) found = await findChargers(at, 60);

    const candidates = found
      .map((c) => ({ ...c, kw: c.kw ?? 0, km: cum[nearestIndex(points, c)] }))
      .filter((c) => c.kw > 0 && c.km > pos && c.km <= reachKm);
    if (!candidates.length) {
      throw new Error(`Nessuna colonnina con potenza nota raggiungibile intorno al km ${searchKm.toFixed(0)}`);
    }

    if (nearestFirst && stops.length === 0) candidates.sort((a, b) => a.km - b.km);
    else candidates.sort((a, b) => b.kw - a.kw || b.km - a.km);
    const best = candidates[0];

    const arrivalPct = soc - pctUsed(best.km - pos);
    const departPct = Math.max(arrivalPct, chargeToPct);
    const needKwh = ((departPct - arrivalPct) / 100) * vehicle.batteryKwh;
    const avgKw = Math.min(vehicle.maxDcKw, best.kw) * MODEL.averageChargeFactor;
    const chargeMinutes = (needKwh / MODEL.chargeEfficiency / avgKw) * 60;

    stops.push({
      name: best.name,
      lat: best.lat,
      lon: best.lon,
      km: best.km,
      kw: best.kw,
      arrivalPct,
      departPct,
      chargeMinutes,
    });
    soc = departPct;
    pos = best.km;
  }

  const finalPct = soc - pctUsed(totalKm - pos);
  const drivingMinutes = (totalKm / conditions.avgKmh) * 60;
  const chargeMinutes = stops.reduce((sum, s) => sum + s.chargeMinutes, 0);

  return {
    totalKm,
    drivingMinutes,
    chargeMinutes,
    totalMinutes: drivingMinutes + chargeMinutes,
    finalPct,
    consumptionKwhPerKm: cons,
    stops,
  };
}

// --- Navigazione -------------------------------------------------------------

const MODIFIER_IT = {
  left: 'a sinistra',
  right: 'a destra',
  'sharp left': 'stretta a sinistra',
  'sharp right': 'stretta a destra',
  'slight left': 'leggermente a sinistra',
  'slight right': 'leggermente a destra',
  uturn: 'a U',
};

// Testo italiano per un passo OSRM (step con maneuver, name, distance).
export function describeStep(step) {
  const { type, modifier, exit } = step.maneuver;
  const road = step.name ? ` su ${step.name}` : '';
  if (type === 'depart') return `Parti${road}`;
  if (type === 'arrive') return 'Sei arrivato a destinazione';
  if (type === 'roundabout' || type === 'rotary') {
    return exit ? `Alla rotonda, uscita ${exit}${road}` : `Alla rotonda${road}`;
  }
  if (modifier === 'straight') return `Prosegui dritto${road}`;
  const side = MODIFIER_IT[modifier];
  return side ? `Svolta ${side}${road}` : `Prosegui${road}`;
}

// Passi con distanza progressiva (km) dall'inizio del percorso.
export function routeSteps(steps) {
  let km = 0;
  return steps.map((step) => {
    const item = {
      km,
      text: describeStep(step),
      lat: step.maneuver.location[1],
      lon: step.maneuver.location[0],
    };
    km += step.distance / 1000;
    return item;
  });
}

// Posizione GPS proiettata sul percorso: vertice più vicino, cercato in avanti a partire da hint
// per non saltare indietro. Se il punto è lontano dal percorso, ripete la ricerca su tutto il tracciato.
export function locateOnRoute(points, cum, fix, hint = 0) {
  const scan = (from, to) => {
    let best = from;
    let bestDist = Infinity;
    for (let i = from; i < to; i++) {
      const d = haversineKm(points[i], fix);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return { index: best, offRouteKm: bestDist };
  };
  let found = scan(hint, Math.min(points.length, hint + 3000));
  if (found.offRouteKm > 0.1) found = scan(0, points.length);
  return { index: found.index, km: cum[found.index], offRouteKm: found.offRouteKm };
}

// Primo elemento (passo o colonnina, con campo km) davanti alla posizione attuale.
export function nextAhead(items, km, marginKm = 0.05) {
  return items.find((item) => item.km > km + marginKm) ?? null;
}

// Raggio (km) di ciò che si raggiunge in `minutes` alla velocità indicata, con un minimo da fermo.
export function reachRadiusKm(speedKmh, minutes = 5) {
  return Math.max((speedKmh * minutes) / 60, 0.5);
}

// Zoom Leaflet che mostra un'area larga 2 × radiusKm, data la larghezza della mappa in pixel.
export function zoomForRadius(radiusKm, lat, mapWidthPx) {
  const metersPerPixel = (2 * radiusKm * 1000) / mapWidthPx;
  const zoom = Math.log2((156543.03392 * Math.cos(toRad(lat))) / metersPerPixel);
  return Math.min(18, Math.max(10, zoom));
}
