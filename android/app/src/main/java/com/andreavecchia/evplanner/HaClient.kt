package com.andreavecchia.evplanner

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

// Legge lo stato di un'entità da Home Assistant (es. la batteria della Jaecoo7).
// Le impostazioni restano sul telefono, nelle preferenze private dell'app: mai nel repository.
object HaClient {

    private const val PREFS = "home_assistant"
    private const val KEY_URL = "url"
    private const val KEY_ENTITY = "entity"
    private const val KEY_TOKEN = "token"

    private val executor = Executors.newSingleThreadExecutor()

    // Sensori dell'auto letti insieme alla batteria (entità fisse della Jaecoo7).
    private val CAR_ENTITIES = mapOf(
        "fuelL" to "sensor.chery_connect_fuel_remaining",
        "odometerKm" to "sensor.chery_connect_odometer",
        "currentA" to "sensor.chery_connect_hv_battery_current",
        "voltageV" to "sensor.chery_connect_hv_battery_voltage",
        "engineOn" to "binary_sensor.chery_connect_engine",
    )

    data class Settings(val url: String, val entity: String, val token: String) {
        val isComplete: Boolean get() = url.isNotBlank() && entity.isNotBlank() && token.isNotBlank()
    }

    fun loadSettings(context: Context): Settings {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Settings(
            url = prefs.getString(KEY_URL, "").orEmpty().trimEnd('/'),
            entity = prefs.getString(KEY_ENTITY, "").orEmpty().trim(),
            token = prefs.getString(KEY_TOKEN, "").orEmpty().trim(),
        )
    }

    fun saveSettings(context: Context, settings: Settings) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_URL, settings.url.trimEnd('/'))
            .putString(KEY_ENTITY, settings.entity.trim())
            .putString(KEY_TOKEN, settings.token.trim())
            .apply()
    }

    // Lettura in background di batteria e sensori dell'auto. onCar riceve il JSON con i valori.
    fun refreshAll(settings: Settings, onCar: (String) -> Unit = {}) {
        if (!settings.isComplete) {
            TripState.setBatteryError("Home Assistant non configurato")
            return
        }
        executor.execute {
            val car = JSONObject()
            try {
                val battery = fetchState(settings, settings.entity)
                val pct = battery.toDoubleOrNull()
                if (pct != null) TripState.setBattery(pct)
                else TripState.setBatteryError("stato \"$battery\", non numerico")
                car.put("battery", pct ?: JSONObject.NULL)
            } catch (e: Exception) {
                TripState.setBatteryError(e.message ?: "errore di rete")
                car.put("battery", JSONObject.NULL)
            }
            for ((key, entity) in CAR_ENTITIES) {
                try {
                    val state = fetchState(settings, entity)
                    car.put(key, if (key == "engineOn") state == "on" else state.toDoubleOrNull() ?: JSONObject.NULL)
                } catch (e: Exception) {
                    car.put(key, JSONObject.NULL)
                }
            }
            onCar(car.toString())
        }
    }

    private fun fetchState(settings: Settings, entity: String): String {
        val conn = URL("${settings.url}/api/states/$entity").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.setRequestProperty("Authorization", "Bearer ${settings.token}")
            conn.setRequestProperty("Content-Type", "application/json")
            if (conn.responseCode != 200) throw IllegalStateException("Home Assistant HTTP ${conn.responseCode}")
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            return JSONObject(body).getString("state")
        } finally {
            conn.disconnect()
        }
    }
}
