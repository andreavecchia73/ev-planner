package com.andreavecchia.evplanner

import android.webkit.JavascriptInterface

// Ponte esposto alla pagina web come window.EvBridge. Nel browser normale non esiste.
class EvBridge {

    @JavascriptInterface
    fun update(json: String) {
        TripState.updateFromPlanner(json)
    }
}
