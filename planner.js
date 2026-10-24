// Logica di pianificazione senza dipendenze di rete.
// Il consumo è un profilo a segmenti lungo il percorso: ogni passo OSRM ha la sua tipologia di strada
// (autostrada, superstrada, centro abitato) e il suo dislivello. Le costanti in MODEL sono euristiche da tarare.

export const ROAD_RATES = {
  motorway: 22, // kWh/100 km, autostrada
  expressway: 18, // kWh/100 km, superstrada
  urban: 15, // kWh/100 km, centro abitato
};

export const MODEL = {
  comfortLowC: 20,
  comfortHighC: 25,
  coldPerDegC: 0.01, // +1% consumo per grado sotto i 20 °C
  hotPerDegC: 0.005, // +0,5% consumo per grado sopra i 25 °C
  massKg: 1900, // massa del veicolo in marcia, da verificare sulla carta di circolazione
  drivetrainEfficiency: 0.85, // energia dalla batteria alle ruote in salita
  regenEfficiency: 0.6, // energia recuperata in discesa
  minRateFactor: 0.2, // il consumo in discesa non scende sotto il 20% della tariffa di strada
  chargeEfficiency: 0.9, // energia da rete -> batteria
  averageChargeFactor: 0.6, // potenza media sulla sessione rispetto al picco (curva di carica)
  minChargerKw: 39, // solo colonnine con potenza superiore a questo valore
};

const EARTH_RADIUS_KM = 6371;
const GRAVITY = 9.81;
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

// Fattore di temperatura: freddo e caldo aumentano il consumo.
export function tempFactor(tempC) {
  let factor = 1;
  if (tempC < MODEL.comfortLowC) factor += (MODEL.comfortLowC - tempC) * MODEL.coldPerDegC;
  else if (tempC > MODEL.comfortHighC) factor += (tempC - MODEL.comfortHighC) * MODEL.hotPerDegC;
  return factor;
}

// Energia (kWh) per salire o scendere di climbM metri: in salita si spende, in discesa si recupera in parte.
export function climbEnergyKwh(climbM, massKg = MODEL.massKg) {
  const kwh = (massKg * GRAVITY * climbM) / 3.6e6;
  return climbM > 0 ? kwh / MODEL.drivetrainEfficiency : kwh * MODEL.regenEfficiency;
}

// Classificazione della strada di un passo OSRM: prima dal codice (A/E autostrada, SS/SP/SR superstrada),
// poi dalla velocità media del passo. È una stima: strade miste possono essere classificate diversamente.
export function classifyRoad(step) {
  const ref = (step.ref ?? '').trim();
  if (/^[AE]\s?\d/i.test(ref)) return 'motorway';
  if (/^(SS|SP|SR|RA|SC)\s?\d/i.test(ref)) return 'expressway';
  const speedKmh = step.duration > 0 ? (step.distance / step.duration) * 3.6 : 0;
  if (speedKmh >= 85) return 'motorway';
  if (speedKmh >= 55) return 'expressway';
  return 'urban';
}

// Funzione altitudine (m) interpolata da campioni {km, alt} lungo il percorso.
export function makeAltitudeAt(sampleKm, sampleAlt) {
  return (km) => {
    if (km <= sampleKm[0]) return sampleAlt[0];
    const last = sampleKm.length - 1;
    if (km >= sampleKm[last]) return sampleAlt[last];
    let i = 1;
    while (sampleKm[i] < km) i++;
    const span = sampleKm[i] - sampleKm[i - 1];
    const t = span === 0 ? 0 : (km - sampleKm[i - 1]) / span;
    return sampleAlt[i - 1] + t * (sampleAlt[i] - sampleAlt[i - 1]);
  };
}

// Profilo di consumo e tempo: un segmento per passo OSRM, con energia totale (kWh) e minuti.
// Le distanze dei passi vengono riscalate sulla lunghezza reale del tracciato.
export function buildProfile(
  steps,
  { totalKm, tempC, altitudeAt = null, massKg = MODEL.massKg, rates = ROAD_RATES, learnedFactor = 1 },
) {
  const sumKm = steps.reduce((sum, step) => sum + step.distance / 1000, 0);
  const scale = sumKm > 0 ? totalKm / sumKm : 1;
  const factor = tempFactor(tempC);
  const segments = [];
  let km = 0;
  for (const step of steps) {
    const lengthKm = (step.distance / 1000) * scale;
    if (lengthKm <= 0) continue;
    const from = km;
    const to = km + lengthKm;
    const base = lengthKm * (rates[classifyRoad(step)] / 100) * factor;
    let kwh = base;
    if (altitudeAt) {
      kwh += climbEnergyKwh(altitudeAt(to) - altitudeAt(from), massKg);
      kwh = Math.max(kwh, base * MODEL.minRateFactor);
    }
    // learnedFactor: correzione ricavata dai consumi reali del viaggio in corso
    segments.push({ from, to, kwh: kwh * learnedFactor, minutes: step.duration / 60, road: classifyRoad(step) });
    km = to;
  }
  return segments;
}

// Profilo uniforme per tratti senza dati di strada: consumo medio dal valore Wh/km.
export function uniformProfile(totalKm, vehicle, conditions) {
  const kwh = totalKm * (vehicle.consumptionWhPerKm / 1000) * tempFactor(conditions.tempC);
  return [{ from: 0, to: totalKm, kwh, minutes: (totalKm / conditions.avgKmh) * 60 }];
}

// Energia (kWh) tra due km del percorso.
export function energyBetween(profile, a, b) {
  let kwh = 0;
  for (const s of profile) {
    const overlap = Math.min(b, s.to) - Math.max(a, s.from);
    if (overlap > 0) kwh += (overlap / (s.to - s.from)) * s.kwh;
  }
  return kwh;
}

// Minuti di guida tra due km del percorso.
export function minutesBetween(profile, a, b) {
  let minutes = 0;
  for (const s of profile) {
    const overlap = Math.min(b, s.to) - Math.max(a, s.from);
    if (overlap > 0) minutes += (overlap / (s.to - s.from)) * s.minutes;
  }
  return minutes;
}

// Km raggiungibili partendo da fromKm con l'energia disponibile, seguendo il consumo di ogni tratto.
export function rangeKm(profile, fromKm, budgetKwh, totalKm) {
  let left = budgetKwh;
  let km = fromKm;
  for (const s of profile) {
    if (s.to <= km) continue;
    const start = Math.max(s.from, km);
    const rate = s.kwh / (s.to - s.from);
    if (rate <= 0) {
      km = s.to;
      continue;
    }
    const availableKwh = (s.to - start) * rate;
    if (availableKwh >= left) return start + left / rate;
    left -= availableKwh;
    km = s.to;
  }
  return totalKm;
}

// Pianifica il viaggio con soste di ricarica greedy: a ogni sosta sceglie la colonnina
// più potente raggiungibile con la riserva, poi ricarica fino a chargeToPct.
// profile: segmenti da buildProfile; se assente il consumo è uniforme (vehicle.consumptionWhPerKm).
// findChargers(point, radiusKm) deve restituire [{ lat, lon, name, kw }].
// Carica minima della batteria: fissa, non modificabile e non superabile quando si pianifica con la benzina.
export const EV_FLOOR_PCT = 20;

// Litri consumati tra due km, con i consumi a benzina per tipo di strada (l100: L/100 km).
export function litresBetween(profile, a, b, l100) {
  let litres = 0;
  for (const s of profile) {
    const overlap = Math.min(b, s.to) - Math.max(a, s.from);
    if (overlap > 0) litres += overlap * ((l100[s.road] ?? l100.urban) / 100);
  }
  return litres;
}

// Pianifica il viaggio con soste di ricarica greedy: a ogni sosta sceglie la colonnina preferita
// tra quelle raggiungibili e vicine al percorso. Con fuel la batteria non scende sotto EV_FLOOR_PCT:
// se la ricarica costa più della benzina sul tratto che copre, la colonnina viene saltata e il resto
// del viaggio prosegue a benzina.
// fuel: { l100: { motorway, expressway, urban }, pricePerL, chargePrice(stop) → €/kWh | null }
export async function planTrip({
  points,
  profile = null,
  vehicle,
  conditions,
  startPct,
  arriveMinPct,
  chargeToPct,
  reservePct,
  findChargers,
  nearestFirst = false, // primo stop: la colonnina più vicina invece della più potente
  targetArrivalPct = null, // carica di arrivo alla colonnina da privilegiare (es. 20)
  maxOffRouteKm = 5, // distanza massima della colonnina dal percorso
  maxStops = 15,
  fuel = null,
  noCharging = false, // nessuna sosta: tutto il viaggio con la batteria fino alla soglia, poi benzina
  forceCharging = false, // ricarica alle colonnine anche se costa più della benzina
}) {
  const cum = cumulativeKm(points);
  const totalKm = cum[cum.length - 1];
  const segs = profile ?? uniformProfile(totalKm, vehicle, conditions);
  const battery = vehicle.batteryKwh;
  const pctBetween = (a, b) => (energyBetween(segs, a, b) / battery) * 100;
  const reachFrom = (pos, floorPct, fromPct) =>
    rangeKm(segs, pos, (Math.max(0, fromPct - floorPct) / 100) * battery, totalKm);
  const floorPct = () => (fuel ? (fuel.evFloorPct ?? EV_FLOOR_PCT) : (arriveMinPct ?? EV_FLOOR_PCT));
  const reachFloor = (pos, soc) => reachFrom(pos, floorPct(), soc);

  // Colonnine oltre MODEL.minChargerKw, raggiungibili entro reachKm e vicine al percorso, in ordine di preferenza.
  const pick = (list, pos, soc, reachKm) =>
    list
      .map((c) => {
        const idx = nearestIndex(points, c);
        return { ...c, kw: c.kw ?? 0, km: cum[idx], offRouteKm: haversineKm(points[idx], c) };
      })
      .filter((c) => c.kw > MODEL.minChargerKw && c.km > pos && c.km <= reachKm && c.offRouteKm <= maxOffRouteKm)
      .sort((a, b) => {
        if (nearestFirst && stops.length === 0) return a.km - b.km;
        if (targetArrivalPct !== null) {
          const gap = (c) => Math.abs(soc - pctBetween(pos, c.km) - targetArrivalPct);
          return gap(a) - gap(b) || b.kw - a.kw;
        }
        return b.kw - a.kw || b.km - a.km;
      });

  // Conviene ricaricare alla colonnina c? Confronta il costo elettrico con quello della benzina sul tratto coperto.
  const worthCharging = (c) => {
    if (!fuel || forceCharging) return true;
    const price = fuel.chargePrice(c);
    if (price === null || price === undefined) return true; // prezzo ignoto: si ricarica
    const end = Math.min(totalKm, reachFrom(c.km, EV_FLOOR_PCT, chargeToPct));
    const evEur = (energyBetween(segs, c.km, end) / MODEL.chargeEfficiency) * price;
    const petrolEur = litresBetween(segs, c.km, end, fuel.l100) * fuel.pricePerL;
    return evEur <= petrolEur;
  };

  // conteggio delle colonnine trovate, per capire perché non ne vengono scelte
  const countCandidates = (list, pos, reachKm) => {
    const counts = { seen: list.length, powerOk: 0, nearRoute: 0, reachable: 0 };
    for (const c of list) {
      const idx = nearestIndex(points, c);
      const km = cum[idx];
      const off = haversineKm(points[idx], c);
      const powerOk = (c.kw ?? 0) > MODEL.minChargerKw;
      if (powerOk) counts.powerOk++;
      if (off <= maxOffRouteKm) counts.nearRoute++;
      if (powerOk && off <= maxOffRouteKm && km > pos && km <= reachKm) counts.reachable++;
    }
    return counts;
  };
  let diagnostics = null;

  const stops = [];
  let pos = 0;
  let soc = startPct;

  while (!noCharging && reachFloor(pos, soc) < totalKm) {
    if (stops.length >= maxStops) {
      throw new Error(`Servono più di ${maxStops} soste: controlla i parametri del veicolo`);
    }

    const reserveKm = reachFrom(pos, reservePct, soc);
    const floorKm = reachFloor(pos, soc);
    // cerca attorno al punto in cui si arriva al livello di carica desiderato, altrimenti a circa 85% della portata
    const targetKm =
      targetArrivalPct === null
        ? null
        : rangeKm(segs, pos, (Math.max(0, soc - targetArrivalPct) / 100) * battery, totalKm);
    const searchKm = targetKm !== null && targetKm > pos ? Math.min(targetKm, floorKm) : pos + (floorKm - pos) * 0.85;
    const at = pointAt(points, cum, searchKm);

    // colonnine entro 25 km e entro 60 km dal punto di ricerca, senza duplicati
    const found = [...(await findChargers(at, 25)), ...(await findChargers(at, 60))];
    const seen = new Set();
    const list = found.filter((c) => {
      const key = `${c.lat},${c.lon},${c.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!diagnostics) diagnostics = { ...countCandidates(list, pos, floorKm), maxOffRouteKm };
    let candidates = pick(list, pos, soc, floorKm);
    if (!candidates.length && !fuel) candidates = pick(list, pos, soc, reserveKm);
    if (!candidates.length && !fuel) {
      throw new Error(`Nessuna colonnina con potenza nota entro ${maxOffRouteKm} km dal percorso, raggiungibile intorno al km ${searchKm.toFixed(0)}`);
    }
    const best = candidates.find(worthCharging);
    if (!best) break; // nessuna ricarica conveniente: il resto del viaggio a benzina

    const arrivalPct = soc - pctBetween(pos, best.km);
    const departPct = Math.max(arrivalPct, chargeToPct);
    const needKwh = ((departPct - arrivalPct) / 100) * battery;
    const avgKw = Math.min(vehicle.maxDcKw, best.kw) * MODEL.averageChargeFactor;
    const chargeMinutes = (needKwh / MODEL.chargeEfficiency / avgKw) * 60;
    const gridKwh = needKwh / MODEL.chargeEfficiency;
    const priceEurKwh = fuel ? fuel.chargePrice(best) ?? null : null;

    stops.push({
      name: best.name,
      lat: best.lat,
      lon: best.lon,
      km: best.km,
      kw: best.kw,
      arrivalPct,
      departPct,
      chargeMinutes,
      gridKwh, // energia prelevata dalla rete
      priceEurKwh,
      costEur: priceEurKwh === null ? null : gridKwh * priceEurKwh,
      usageCost: best.usageCost ?? '',
    });
    soc = departPct;
    pos = best.km;
  }

  // Tratto a benzina: dal punto in cui la batteria arriva al 20% fino a destinazione.
  let petrol = null;
  let finalPct;
  if (fuel && reachFloor(pos, soc) < totalKm) {
    const fromKm = reachFloor(pos, soc);
    const litres = litresBetween(segs, fromKm, totalKm, fuel.l100);
    petrol = { fromKm, km: totalKm - fromKm, litres, cost: litres * fuel.pricePerL };
    finalPct = fuel.evFloorPct ?? EV_FLOOR_PCT;
  } else {
    finalPct = soc - pctBetween(pos, totalKm);
  }

  const drivingMinutes = minutesBetween(segs, 0, totalKm);
  const chargeMinutes = stops.reduce((sum, s) => sum + s.chargeMinutes, 0);
  const chargeCostEur = stops.reduce((sum, s) => sum + (s.costEur ?? 0), 0);

  return {
    totalKm,
    drivingMinutes,
    chargeMinutes,
    totalMinutes: drivingMinutes + chargeMinutes,
    finalPct,
    consumptionKwhPerKm: energyBetween(segs, 0, totalKm) / totalKm,
    stops,
    petrol,
    chargeCostEur,
    totalCostEur: chargeCostEur + (petrol?.cost ?? 0),
    diagnostics,
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

// Angolo (gradi, 0 = dritto) delle frecce di svolta e delle corsie.
const MODIFIER_ANGLE = {
  straight: 0,
  left: -90,
  right: 90,
  'slight left': -45,
  'slight right': 45,
  'sharp left': -135,
  'sharp right': 135,
  uturn: 180,
};

// Tipo di icona per un passo: freccia, rotonda con numero di uscita, uscita autostradale, arrivo.
export function maneuverKind(item) {
  const { type, modifier, exit } = item.maneuver;
  if (type === 'arrive') return { kind: 'arrive' };
  if (type === 'roundabout' || type === 'rotary') return { kind: 'roundabout', exit };
  return { kind: type === 'off ramp' ? 'exit' : 'arrow', angle: MODIFIER_ANGLE[modifier] ?? 0 };
}

// Angolo di una corsia dalle sue indicazioni (es. ['left'] o ['slight right']).
export function laneAngle(indications = []) {
  const first = indications[0] ?? 'straight';
  return MODIFIER_ANGLE[first.replace(/_/g, ' ')] ?? 0;
}

// Passi con distanza progressiva (km) dall'inizio del percorso, con tipo di manovra e corsie.
export function routeSteps(steps) {
  let km = 0;
  return steps.map((step) => {
    const item = {
      km,
      text: describeStep(step),
      lat: step.maneuver.location[1],
      lon: step.maneuver.location[0],
      maneuver: { type: step.maneuver.type, modifier: step.maneuver.modifier, exit: step.maneuver.exit },
      lanes: step.intersections?.[0]?.lanes ?? [],
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

// Raggio (km) della vista di guida. Sopra i 30 km/h è ciò che si raggiunge in `minutes`;
// sotto, il raggio si riduce fino a 300 m da fermo per mostrare più dettaglio in rotonde e svincoli.
export function viewRadiusKm(speedKmh, minutes = 5) {
  const detailKm = 0.3;
  const cruiseKm = 30;
  if (speedKmh >= cruiseKm) return (speedKmh * minutes) / 60;
  const cruiseRadiusKm = (cruiseKm * minutes) / 60;
  return detailKm + (cruiseRadiusKm - detailKm) * (Math.max(0, speedKmh) / cruiseKm);
}

// Zoom Leaflet che mostra un'area larga 2 × radiusKm, data la larghezza della mappa in pixel.
export function zoomForRadius(radiusKm, lat, mapWidthPx) {
  const metersPerPixel = (2 * radiusKm * 1000) / mapWidthPx;
  const zoom = Math.log2((156543.03392 * Math.cos(toRad(lat))) / metersPerPixel);
  return Math.min(18, Math.max(10, zoom));
}

// Rumbo in gradi (0 = nord, in senso orario) dal punto a al punto b.
export function bearingDeg(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Avvicina un angolo al target lungo il percorso più breve (k = frazione di passo, 0..1).
export function smoothAngle(current, target, k) {
  const delta = ((((target - current) % 360) + 540) % 360) - 180;
  return (((current + delta * k) % 360) + 360) % 360;
}
