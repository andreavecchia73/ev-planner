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

    candidates.sort((a, b) => b.kw - a.kw || b.km - a.km);
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
