package com.andreavecchia.evplanner

import android.content.Context
import android.webkit.JavascriptInterface
import org.json.JSONObject

// Ponte esposto alla pagina web come window.EvBridge. Nel browser normale non esiste.
class EvBridge(private val context: Context) {

    @JavascriptInterface
    fun update(json: String) {
        TripState.updateFromPlanner(json)
    }

    // Credenziali di Home Assistant inserite nella pagina: il telefono le salva e avvia la lettura.
    @JavascriptInterface
    fun saveHomeAssistant(json: String) {
        val o = JSONObject(json)
        HaClient.saveSettings(
            context,
            HaClient.Settings(o.optString("url"), o.optString("entity"), o.optString("token")),
        )
        HaClient.refreshAll(HaClient.loadSettings(context))
    }
}
