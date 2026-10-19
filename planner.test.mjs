import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineKm,
  consumptionKwhPerKm,
  planTrip,
  cumulativeKm,
  describeStep,
  routeSteps,
  locateOnRoute,
  nextAhead,
  reachRadiusKm,
  zoomForRadius,
  bearingDeg,
  smoothAngle,
} from './planner.js';

// Percorso lungo un meridiano con un punto ogni km (1 grado di latitudine ≈ 111,195 km).
const line = (km) => Array.from({ length: km + 1 }, (_, i) => ({ lat: 45 + i / 111.195, lon: 9 }));
const at = (km) => ({ lat: 45 + km / 111.195, lon: 9 });

const vehicle = { batteryKwh: 50, consumptionWhPerKm: 180, maxDcKw: 100 };
const conditions = { tempC: 20, avgKmh: 90 };
const base = {
  vehicle,
  conditions,
  startPct: 100,
  arriveMinPct: 10,
  chargeToPct: 80,
  reservePct: 5,
};

test('haversine: un grado di latitudine vale circa 111,2 km', () => {
  const d = haversineKm({ lat: 45, lon: 9 }, { lat: 46, lon: 9 });
  assert.ok(Math.abs(d - 111.2) < 0.1, `got ${d}`);
});

test('consumo: nessuna correzione in condizioni di riferimento', () => {
  assert.ok(Math.abs(consumptionKwhPerKm(vehicle, conditions) - 0.18) < 1e-9);
});

test('consumo: il freddo e l\'autostrada aumentano il consumo', () => {
  const cold = consumptionKwhPerKm(vehicle, { tempC: -5, avgKmh: 90 });
  const fast = consumptionKwhPerKm(vehicle, { tempC: 20, avgKmh: 120 });
  assert.ok(cold > 0.18);
  assert.ok(fast > 0.18);
});

test('viaggio breve: nessuna sosta, SoC finale calcolato', async () => {
  const res = await planTrip({
    ...base,
    points: line(100),
    findChargers: async () => [],
  });
  assert.equal(res.stops.length, 0);
  // 100 km × 0,18 kWh/km = 18 kWh = 36% di 50 kWh
  assert.ok(Math.abs(res.finalPct - 64) < 0.01, `got ${res.finalPct}`);
});

test('viaggio lungo: una sosta sulla colonnina più potente raggiungibile', async () => {
  const res = await planTrip({
    ...base,
    points: line(300),
    findChargers: async () => [
      { ...at(200), name: 'A 150 kW', kw: 150 },
      { ...at(50), name: 'B 50 kW', kw: 50 },
    ],
  });
  assert.equal(res.stops.length, 1);
  assert.equal(res.stops[0].name, 'A 150 kW');
  assert.ok(Math.abs(res.stops[0].km - 200) < 0.5, `km ${res.stops[0].km}`);
  // arrivo alla sosta: 100 - 72 = 28%; ricarica a 80%; poi 100 km = 36% → 44% all'arrivo
  assert.ok(Math.abs(res.stops[0].arrivalPct - 28) < 0.01);
  assert.ok(Math.abs(res.finalPct - 44) < 0.01, `got ${res.finalPct}`);
  assert.ok(res.chargeMinutes > 0);
});

test('ricalcolo verso la sosta più vicina invece della più potente', async () => {
  const chargers = async () => [
    { ...at(200), name: 'Lontana 150 kW', kw: 150 },
    { ...at(50), name: 'Vicina 50 kW', kw: 50 },
  ];
  const powerFirst = await planTrip({ ...base, points: line(300), findChargers: chargers });
  const nearest = await planTrip({ ...base, points: line(300), findChargers: chargers, nearestFirst: true });
  assert.equal(powerFirst.stops[0].name, 'Lontana 150 kW');
  assert.equal(nearest.stops[0].name, 'Vicina 50 kW');
  assert.ok(Math.abs(nearest.stops[0].km - 50) < 0.5);
});

test('nessuna colonnina disponibile: errore esplicito', async () => {
  await assert.rejects(
    planTrip({ ...base, points: line(400), findChargers: async () => [] }),
    /Nessuna colonnina/,
  );
});

test('istruzioni: svolta, rotonda, arrivo e passi con distanza progressiva', () => {
  const steps = [
    { name: 'Via Roma', distance: 1500, maneuver: { type: 'depart', modifier: 'straight', location: [9, 45] } },
    { name: 'SS11', distance: 4000, maneuver: { type: 'turn', modifier: 'left', location: [9.01, 45.01] } },
    { name: '', distance: 500, maneuver: { type: 'roundabout', exit: 2, location: [9.02, 45.02] } },
    { name: 'Via Torino', distance: 0, maneuver: { type: 'arrive', location: [9.03, 45.03] } },
  ];
  assert.equal(describeStep(steps[0]), 'Parti su Via Roma');
  assert.equal(describeStep(steps[1]), 'Svolta a sinistra su SS11');
  assert.equal(describeStep(steps[2]), 'Alla rotonda, uscita 2');
  assert.equal(describeStep(steps[3]), 'Sei arrivato a destinazione');

  const items = routeSteps(steps);
  assert.deepEqual(items.map((i) => i.km), [0, 1.5, 5.5, 6]);
  assert.deepEqual([items[1].lat, items[1].lon], [45.01, 9.01]);
});

test('posizione GPS: proiezione sul percorso e nessun salto indietro', () => {
  const points = line(100);
  const cum = cumulativeKm(points);
  // fix a 40 km, appena fuori dalla strada (circa 20 m)
  const fix = { lat: 45 + 40 / 111.195, lon: 9.0002 };
  const loc = locateOnRoute(points, cum, fix, 0);
  assert.ok(Math.abs(loc.km - 40) < 0.5, `km ${loc.km}`);
  assert.ok(loc.offRouteKm < 0.05);

  // con un suggerimento avanti (60 km) il risultato resta sul tratto corretto
  const again = locateOnRoute(points, cum, fix, 60);
  assert.ok(Math.abs(again.km - 40) < 0.5, `km ${again.km}`);
});

test('prossimo elemento davanti alla posizione', () => {
  const items = [{ km: 10 }, { km: 25 }, { km: 40 }];
  assert.equal(nextAhead(items, 0).km, 10);
  assert.equal(nextAhead(items, 10).km, 25);
  assert.equal(nextAhead(items, 40), null);
});

test('vista di navigazione: raggio a 5 minuti e zoom che lo mostra', () => {
  assert.ok(Math.abs(reachRadiusKm(100) - 8.33) < 0.01);
  assert.equal(reachRadiusKm(0), 0.5);
  const z1 = zoomForRadius(8.33, 45, 400);
  const z2 = zoomForRadius(4.17, 45, 400);
  assert.ok(Math.abs(z1 - 11.37) < 0.05, `zoom ${z1}`);
  // velocità dimezzata: raggio dimezzato, zoom di una unità in più
  assert.ok(Math.abs(z2 - z1 - 1) < 0.01);
});

test('direzione di marcia: rumore e rotazione angolare', () => {
  assert.ok(Math.abs(bearingDeg({ lat: 45, lon: 9 }, { lat: 46, lon: 9 })) < 0.01);
  assert.ok(Math.abs(bearingDeg({ lat: 45, lon: 9 }, { lat: 45, lon: 10 }) - 90) < 1);
  assert.ok(Math.abs(bearingDeg({ lat: 45, lon: 9 }, { lat: 44, lon: 9 }) - 180) < 0.01);
  assert.ok(Math.abs(smoothAngle(350, 10, 0.5) - 0) < 0.01);
  assert.ok(Math.abs(smoothAngle(10, 350, 0.5) - 0) < 0.01);
  assert.ok(Math.abs(smoothAngle(90, 180, 0.5) - 135) < 0.01);
});
