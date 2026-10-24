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

// Ricostruzione dei viaggi dalla storia di Home Assistant. Un viaggio va dal motore o dall'alta tensione
// accesi fino al loro spegnimento. Km = odometro finale − iniziale; litri = calo del carburante;
// kWh = tensione × corrente nel tempo. I viaggi restano sul telefono, in un file privato dell'app.
object TripLog {

    private const val FILE = "trips.json"
    private const val WINDOW_MS = 9L * 24 * 3600 * 1000 // il recorder di Home Assistant conserva 10 giorni
    private const val REFRESH_WAIT_MS = 45_000L // tempo perché l'auto risponda al pulsante di aggiornamento
    private const val MIN_TRIP_KM = 0.1
    private const val ODOMETER_TOLERANCE_KM = 0.5 // l'odometro è in km interi

    private const val REFRESH_BUTTON = "button.chery_connect_refresh_full_status"

    // Sensori usati per i viaggi, con la chiave interna.
    private val ENTITIES = mapOf(
        "sensor.chery_connect_odometer" to "odometer",
        "sensor.chery_connect_fuel_remaining" to "fuel",
        "sensor.chery_connect_hybrid_mileage" to "hybridKm",
        "sensor.chery_connect_hv_battery_voltage" to "voltage",
        "sensor.chery_connect_hv_battery_current" to "current",
        "binary_sensor.chery_connect_engine" to "engine",
        "binary_sensor.chery_connect_high_voltage_active" to "hv",
    )

    private data class Event(val ms: Long, val key: String, val state: String)

    // Stato completo dei sensori in un istante, per calcolare i delta tra due istanti.
    private class Snap(val ms: Long, val values: Map<String, String>) {
        fun num(key: String): Double? = values[key]?.toDoubleOrNull()
        val moving: Boolean get() = values["engine"] == "on" || values["hv"] == "on"
        val powerKw: Double get() = (num("voltage") ?: 0.0) * abs(num("current") ?: 0.0) / 1000
    }

    // Sincronizza i viaggi: l'aggiornamento serve solo a recuperare i viaggi fatti con l'app chiusa.
    // Se l'odometro è uguale a quello dell'ultimo viaggio salvato non c'è altro da fare. Altrimenti
    // ricostruisce i viaggi dalla fine dell'ultimo salvato in poi. Non fa nulla se Home Assistant non è configurato.
    fun sync(context: Context) {
        val settings = HaClient.loadSettings(context)
        if (!settings.isComplete) return
        pressRefresh(settings)
        Thread.sleep(REFRESH_WAIT_MS)
        val now = System.currentTimeMillis()
        val current = fetchOdometer(settings) ?: return
        val last = load(context).optJSONObject(0)
        if (last != null && abs(current - last.getDouble("odometerEnd")) < ODOMETER_TOLERANCE_KM) return
        val from = if (last != null) max(last.getLong("endMs"), now - WINDOW_MS) else now - WINDOW_MS
        merge(context, detect(fetchHistory(settings, from, now)))
    }

    private fun fetchOdometer(settings: HaClient.Settings): Double? {
        val state = JSONObject(request(settings, "/api/states/sensor.chery_connect_odometer", "GET", null))
        return state.getString("state").toDoubleOrNull()
    }

    // Elenco dei viaggi salvati, dal più recente.
    fun load(context: Context): JSONArray {
        return try {
            JSONArray(File(context.filesDir, FILE).readText())
        } catch (e: Exception) {
            JSONArray()
        }
    }

    private fun pressRefresh(settings: HaClient.Settings) {
        val body = JSONObject().put("entity_id", REFRESH_BUTTON).toString()
        request(settings, "/api/services/button/press", "POST", body)
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

    // Scorre la storia in ordine temporale e ricostruisce i viaggi.
    private fun detect(events: List<Event>): List<JSONObject> {
        val trips = mutableListOf<JSONObject>()
        val values = HashMap<String, String>()
        var start: Snap? = null
        var prev: Snap? = null
        var kwh = 0.0
        var litres = 0.0
        var refuelled = false

        for (e in events) {
            values[e.key] = e.state
            val snap = Snap(e.ms, values.toMap())
            val p = prev
            if (start != null && p != null) {
                // energia e carburante tra due letture consecutive, con il valore della lettura precedente
                kwh += p.powerKw * (snap.ms - p.ms) / 3_600_000.0
                val before = p.num("fuel")
                val now = snap.num("fuel")
                if (before != null && now != null) {
                    if (now < before) litres += before - now
                    if (now > before + 3.0) refuelled = true // rifornimento: il calo misurato non basta più
                }
            }
            if (start == null && snap.moving) {
                start = snap
                kwh = 0.0
                litres = 0.0
                refuelled = false
            } else if (start != null && !snap.moving) {
                buildTrip(start, snap, kwh, litres, refuelled)?.let { trips.add(it) }
                start = null
            }
            prev = snap
        }
        return trips
    }

    private fun buildTrip(start: Snap, end: Snap, kwh: Double, litres: Double, refuelled: Boolean): JSONObject? {
        val km = (end.num("odometer") ?: return null) - (start.num("odometer") ?: return null)
        if (km < MIN_TRIP_KM) return null
        val hybridKm = ((end.num("hybridKm") ?: 0.0) - (start.num("hybridKm") ?: 0.0)).coerceIn(0.0, km)
        return JSONObject().apply {
            put("startMs", start.ms)
            put("endMs", end.ms)
            put("odometerEnd", end.num("odometer"))
            put("km", round(km))
            put("hybridKm", round(hybridKm))
            put("electricKm", round(max(0.0, km - hybridKm)))
            put("litres", round(litres))
            put("kwh", round(kwh))
            put("kwhPer100Km", round(kwh / km * 100))
            put("litresPer100Km", if (litres > 0) round(litres / km * 100) else JSONObject.NULL)
            put("kmPerLitre", if (litres > 0) round(km / litres) else JSONObject.NULL)
            put("refuelled", refuelled)
        }
    }

    // Unisce i viaggi nuovi a quelli salvati: lo stesso inizio sostituisce la versione precedente.
    private fun merge(context: Context, fresh: List<JSONObject>) {
        val byStart = java.util.TreeMap<Long, JSONObject>(Comparator.reverseOrder())
        val saved = load(context)
        for (i in 0 until saved.length()) {
            val trip = saved.getJSONObject(i)
            byStart[trip.getLong("startMs")] = trip
        }
        for (trip in fresh) byStart[trip.getLong("startMs")] = trip
        val out = JSONArray()
        byStart.values.forEach { out.put(it) }
        File(context.filesDir, FILE).writeText(out.toString())
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
