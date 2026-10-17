import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, consumptionKwhPerKm, planTrip } from './planner.js';

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

test('nessuna colonnina disponibile: errore esplicito', async () => {
  await assert.rejects(
    planTrip({ ...base, points: line(400), findChargers: async () => [] }),
    /Nessuna colonnina/,
  );
});
