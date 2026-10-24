package com.andreavecchia.evplanner

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

// Ricostruzione di viaggi, rifornimenti e ricariche dalla storia di Home Assistant.
// Viaggi: dal motore o dall'alta tensione accesi fino al loro spegnimento. Km = odometro finale − iniziale.
// Energia: differenza di carica della batteria (%) × capacità; la corrente serve solo a riconoscere la ricarica dal motore.
// Litri: calo del carburante in marcia; rifornimento = aumento di carburante a motore spento.
// Ricarica: dal collegamento della spina alla sua rimozione; "a casa" dal sensore at_home all'inizio.
// Tutto resta sul telefono, in file privati dell'app.
object TripLog {

    private const val FILE_TRIPS = "trips.json"
    private const val FILE_EVENTS = "events.json"
    private const val FILE_SYNC = "sync.json"
    private const val WINDOW_MS = 9L * 24 * 3600 * 1000 // il recorder di Home Assistant conserva 10 giorni
    private const val REFRESH_WAIT_MS = 45_000L // tempo perché l'auto risponda al pulsante di aggiornamento
    private const val MIN_TRIP_KM = 0.1
    private const val TOLERANCE = 0.5 // odometro e carburante sono letti in unità intere
    private const val BATTERY_KWH = 18.0 // capacità della batteria della Jaecoo7
    private const val CHARGING_CURRENT_A = -5.0 // corrente negativa = energia che entra nella batteria (da verificare)
    private const val REFUEL_MIN_L = 3.0 // aumento di carburante minimo per un rifornimento
    private const val CHARGE_MIN_PCT = 1.0 // guadagno minimo di carica per registrare una ricarica

    private const val REFRESH_BUTTON = "button.chery_connect_refresh_full_status"

    // Sensori letti dalla storia, con la chiave interna.
    private val ENTITIES = mapOf(
        "sensor.chery_connect_odometer" to "odometer",
        "sensor.chery_connect_fuel_remaining" to "fuel",
        "sensor.chery_connect_hybrid_mileage" to "hybridKm",
        "sensor.chery_connect_battery" to "soc",
        "sensor.chery_connect_hv_battery_current" to "current",
        "binary_sensor.chery_connect_engine" to "engine",
        "binary_sensor.chery_connect_high_voltage_active" to "hv",
        "binary_sensor.chery_connect_charging_cable" to "cable",
        "binary_sensor.chery_connect_at_home" to "home",
    )

    private data class Event(val ms: Long, val key: String, val state: String)

    // Stato completo dei sensori in un istante, per calcolare le differenze tra due istanti.
    private class Snap(val ms: Long, val values: Map<String, String>) {
        fun num(key: String): Double? = values[key]?.toDoubleOrNull()
        val moving: Boolean get() = values["engine"] == "on" || values["hv"] == "on"
    }

    // Sincronizza: chiede all'auto i dati completi, poi legge la storia solo se odometro, carburante o
    // batteria sono cambiati dall'ultima volta. Non fa nulla se Home Assistant non è configurato.
    fun sync(context: Context) {
        val settings = HaClient.loadSettings(context)
        if (!settings.isComplete) return
        pressRefresh(settings)
        Thread.sleep(REFRESH_WAIT_MS)
        val now = System.currentTimeMillis()
        val odometer = fetchNumber(settings, "sensor.chery_connect_odometer") ?: return
        val fuel = fetchNumber(settings, "sensor.chery_connect_fuel_remaining")
        val soc = fetchNumber(settings, "sensor.chery_connect_battery")

        val last = loadSync(context)
        if (last != null && fuel != null && soc != null &&
            abs(odometer - last.getDouble("odometer")) < TOLERANCE &&
            abs(fuel - last.getDouble("fuel")) < TOLERANCE &&
            abs(soc - last.getDouble("soc")) < TOLERANCE
        ) return

        // dalla fine dell'ultimo viaggio o dall'ultima sincronizzazione, la più vecchia delle due
        val lastTripEnd = load(context).optJSONObject(0)?.getLong("endMs") ?: (now - WINDOW_MS)
        val lastSync = last?.getLong("syncMs") ?: (now - WINDOW_MS)
        val from = max(min(lastTripEnd, lastSync), now - WINDOW_MS)
        val (trips, log) = detect(fetchHistory(settings, from, now))
        mergeInto(context, FILE_TRIPS, trips)
        mergeInto(context, FILE_EVENTS, log)
        saveSync(context, now, odometer, fuel, soc)
    }

    // Viaggi salvati, dal più recente.
    fun load(context: Context): JSONArray = readArray(context, FILE_TRIPS)

    // Rifornimenti e ricariche salvati, dal più recente.
    fun loadEvents(context: Context): JSONArray = readArray(context, FILE_EVENTS)

    private fun readArray(context: Context, file: String): JSONArray {
        return try {
            JSONArray(File(context.filesDir, file).readText())
        } catch (e: Exception) {
            JSONArray()
        }
    }

    private fun loadSync(context: Context): JSONObject? {
        return try {
            JSONObject(File(context.filesDir, FILE_SYNC).readText())
        } catch (e: Exception) {
            null
        }
    }

    private fun saveSync(context: Context, now: Long, odometer: Double, fuel: Double?, soc: Double?) {
        val state = JSONObject()
            .put("syncMs", now)
            .put("odometer", odometer)
            .put("fuel", fuel ?: JSONObject.NULL)
            .put("soc", soc ?: JSONObject.NULL)
        File(context.filesDir, FILE_SYNC).writeText(state.toString())
    }

    private fun pressRefresh(settings: HaClient.Settings) {
        val body = JSONObject().put("entity_id", REFRESH_BUTTON).toString()
        request(settings, "/api/services/button/press", "POST", body)
    }

    private fun fetchNumber(settings: HaClient.Settings, entity: String): Double? {
        val state = JSONObject(request(settings, "/api/states/$entity", "GET", null))
        return state.getString("state").toDoubleOrNull()
    }

    private fun fetchHistory(settings: HaClient.Settings, fromMs: Long, toMs: Long): List<Event> {
        val path = "/api/history/period/${isoUtc(fromMs)}" +
            "?filter_entity_id=${ENTITIES.keys.joinToString(",")}" +
            "&end_time=${isoUtc(toMs)}&no_attributes"
        val groups = JSONArray(request(settings, path, "GET", null))
        val events = mutableListOf<Event>()
        for (g in 0 until groups.length()) {
            val group = groups.getJSONArray(g)
            for (i in 0 until group.length()) {
                val item = group.getJSONObject(i)
                val key = ENTITIES[item.optString("entity_id")] ?: continue
                events.add(Event(parseIso(item.getString("last_changed")), key, item.getString("state")))
            }
        }
        return events.sortedBy { it.ms }
    }

    // Scorre la storia in ordine temporale e ricostruisce viaggi, rifornimenti e ricariche.
    private fun detect(events: List<Event>): Pair<List<JSONObject>, List<JSONObject>> {
        val trips = mutableListOf<JSONObject>()
        val log = mutableListOf<JSONObject>()
        val values = HashMap<String, String>()
        var start: Snap? = null
        var prev: Snap? = null
        var chargeStart: Snap? = null
        var engineChargePct = 0.0
        var litres = 0.0
        var refuelled = false

        for (e in events) {
            values[e.key] = e.state
            val snap = Snap(e.ms, values.toMap())
            val p = prev
            if (p != null) {
                val fuelBefore = p.num("fuel")
                val fuelNow = snap.num("fuel")
                if (start != null) {
                    // ricarica dal motore durante il viaggio: motore acceso, corrente di carica, batteria che sale
                    val socBefore = p.num("soc")
                    val socNow = snap.num("soc")
                    if (socBefore != null && socNow != null && p.values["engine"] == "on" &&
                        (p.num("current") ?: 0.0) < CHARGING_CURRENT_A && socNow > socBefore
                    ) {
                        engineChargePct += socNow - socBefore
                    }
                    // in marcia contano solo i cali di carburante
                    if (fuelBefore != null && fuelNow != null) {
                        if (fuelNow < fuelBefore) litres += fuelBefore - fuelNow
                        if (fuelNow > fuelBefore + REFUEL_MIN_L) refuelled = true
                    }
                }
                // rifornimento: il carburante sale a motore spento
                if (fuelBefore != null && fuelNow != null && fuelNow - fuelBefore >= REFUEL_MIN_L &&
                    p.values["engine"] != "on"
                ) {
                    log.add(refuelEvent(snap.ms, fuelNow - fuelBefore, fuelNow))
                }
            }
            if (start == null && snap.moving) {
                start = snap
                engineChargePct = 0.0
                litres = 0.0
                refuelled = false
            } else if (start != null && !snap.moving) {
                buildTrip(start, snap, engineChargePct, litres, refuelled)?.let { trips.add(it) }
                start = null
            }
            // ricarica: dalla spina inserita alla spina tolta
            if (chargeStart == null && snap.values["cable"] == "on") {
                chargeStart = snap
            } else if (chargeStart != null && snap.values["cable"] != "on") {
                chargeEvent(chargeStart, snap)?.let { log.add(it) }
                chargeStart = null
            }
            prev = snap
        }
        return Pair(trips, log)
    }

    private fun buildTrip(start: Snap, end: Snap, engineChargePct: Double, litres: Double, refuelled: Boolean): JSONObject? {
        val km = (end.num("odometer") ?: return null) - (start.num("odometer") ?: return null)
        if (km < MIN_TRIP_KM) return null
        val socStart = start.num("soc") ?: return null
        val socEnd = end.num("soc") ?: return null
        val kwh = (socStart - socEnd) / 100 * BATTERY_KWH
        val hybridKm = ((end.num("hybridKm") ?: 0.0) - (start.num("hybridKm") ?: 0.0)).coerceIn(0.0, km)
        // energia netta dalla batteria, poi quella usata in trazione: si aggiunge ciò che il motore
        // ha rimesso in batteria, perché quell'energia è stata poi spesa in marcia
        val engineChargeKwh = engineChargePct / 100 * BATTERY_KWH
        val tractionKwh = kwh + engineChargeKwh
        val startMs = start.ms
        return JSONObject().apply {
            put("key", "t$startMs")
            put("startMs", startMs)
            put("endMs", end.ms)
            put("odometerEnd", end.num("odometer"))
            put("km", round(km))
            put("hybridKm", round(hybridKm))
            put("electricKm", round(max(0.0, km - hybridKm)))
            put("socStart", socStart)
            put("socEnd", socEnd)
            put("kwh", round(kwh))
            put("engineChargeKwh", round(engineChargeKwh))
            put("tractionKwh", round(tractionKwh))
            put("kwhPer100Km", round(tractionKwh / km * 100))
            put("litres", round(litres))
            put("litresPer100Km", if (litres > 0) round(litres / km * 100) else JSONObject.NULL)
            put("kmPerLitre", if (litres > 0) round(km / litres) else JSONObject.NULL)
            put("refuelled", refuelled)
        }
    }

    private fun refuelEvent(ms: Long, litresAdded: Double, fuelAfter: Double): JSONObject =
        JSONObject().apply {
            put("key", "r$ms")
            put("type", "refuel")
            put("startMs", ms)
            put("litres", round(litresAdded))
            put("fuelAfter", round(fuelAfter))
        }

    private fun chargeEvent(start: Snap, end: Snap): JSONObject? {
        val socStart = start.num("soc") ?: return null
        val socEnd = end.num("soc") ?: return null
        val gain = socEnd - socStart
        if (gain < CHARGE_MIN_PCT) return null
        val startMs = start.ms
        return JSONObject().apply {
            put("key", "c$startMs")
            put("type", "charge")
            put("startMs", startMs)
            put("endMs", end.ms)
            put("home", start.values["home"] == "on")
            put("socStart", socStart)
            put("socEnd", socEnd)
            put("kwh", round(gain / 100 * BATTERY_KWH))
        }
    }

    // Unisce le voci nuove a quelle salvate: la stessa chiave sostituisce la versione precedente.
    private fun mergeInto(context: Context, file: String, fresh: List<JSONObject>) {
        val byKey = LinkedHashMap<String, JSONObject>()
        val saved = readArray(context, file)
        for (i in 0 until saved.length()) {
            val item = saved.getJSONObject(i)
            byKey[item.optString("key").ifEmpty { "t" + item.getLong("startMs") }] = item
        }
        for (item in fresh) byKey[item.getString("key")] = item
        val sorted = byKey.values.sortedByDescending { it.getLong("startMs") }
        val out = JSONArray()
        sorted.forEach { out.put(it) }
        File(context.filesDir, file).writeText(out.toString())
    }

    private fun request(settings: HaClient.Settings, path: String, method: String, body: String?): String {
        val conn = URL("${settings.url}$path").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("Authorization", "Bearer ${settings.token}")
            conn.setRequestProperty("Content-Type", "application/json")
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toByteArray()) }
            }
            if (conn.responseCode !in 200..299) throw IllegalStateException("Home Assistant HTTP ${conn.responseCode}")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    // Date in UTC, senza java.time (minSdk 23).
    private fun isoUtc(ms: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(java.util.Date(ms))

    // Home Assistant risponde con "2026-10-24T17:43:21.123456+00:00": si legge solo la parte iniziale, in UTC.
    private fun parseIso(text: String): Long =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            .parse(text.take(19))!!.time

    private fun round(value: Double): Double = Math.round(value * 100) / 100.0
}
