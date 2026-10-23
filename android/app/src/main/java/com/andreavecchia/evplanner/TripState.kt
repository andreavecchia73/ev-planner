package com.andreavecchia.evplanner

import android.os.Handler
import android.os.Looper
import org.json.JSONObject

// Stato del viaggio condiviso tra la WebView (telefono) e il display dell'auto.
// Viene letto e scritto solo dal thread principale.
object TripState {

    data class Snapshot(
        val soc: Int?,
        val stopName: String?,
        val stopKm: Double?,
        val stopMin: Double?,
        val arrivalKm: Double?,
        val arrivalMin: Double?,
        val batteryPct: Double?,
        val batteryUpdatedAt: Long?,
        val batteryError: String?,
        val stepText: String?,
        val stepKm: Double?,
        val stepType: String?,
    ) {
        val hasTrip: Boolean get() = arrivalKm != null
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var soc: Int? = null
    private var stopName: String? = null
    private var stopKm: Double? = null
    private var stopMin: Double? = null
    private var arrivalKm: Double? = null
    private var arrivalMin: Double? = null
    private var batteryPct: Double? = null
    private var batteryUpdatedAt: Long? = null
    private var batteryError: String? = null
    private var stepText: String? = null
    private var stepKm: Double? = null
    private var stepType: String? = null

    // Chiamato dal display dell'auto per ridisegnare la schermata quando cambiano i dati.
    var onChanged: (() -> Unit)? = null

    // Chiamato quando cambia la batteria da Home Assistant: serve al telefono per mostrare lo stato.
    var onBatteryChanged: (() -> Unit)? = null

    fun snapshot(): Snapshot = Snapshot(
        soc, stopName, stopKm, stopMin, arrivalKm, arrivalMin,
        batteryPct, batteryUpdatedAt, batteryError, stepText, stepKm, stepType,
    )

    // Dati dal pianificatore web, in formato JSON. Può arrivare da un thread diverso dal principale.
    fun updateFromPlanner(json: String) {
        mainHandler.post {
            val o = JSONObject(json)
            soc = o.optInt("soc", -1).takeIf { it >= 0 }
            stopName = if (o.isNull("stopName")) null else o.optString("stopName")
            stopKm = o.optDoubleOrNull("stopKm")
            stopMin = o.optDoubleOrNull("stopMin")
            arrivalKm = o.optDoubleOrNull("arrivalKm")
            arrivalMin = o.optDoubleOrNull("arrivalMin")
            stepText = if (o.isNull("stepText")) null else o.optString("stepText")
            stepKm = o.optDoubleOrNull("stepKm")
            stepType = if (o.isNull("stepType")) null else o.optString("stepType")
            notifyChanged()
        }
    }

    fun setBattery(pct: Double) {
        mainHandler.post {
            batteryPct = pct
            batteryUpdatedAt = System.currentTimeMillis()
            batteryError = null
            notifyChanged()
            onBatteryChanged?.invoke()
        }
    }

    fun setBatteryError(message: String) {
        mainHandler.post {
            batteryError = message
            notifyChanged()
            onBatteryChanged?.invoke()
        }
    }

    private fun notifyChanged() {
        onChanged?.invoke()
    }

    private fun JSONObject.optDoubleOrNull(key: String): Double? =
        if (has(key) && !isNull(key)) optDouble(key) else null
}
