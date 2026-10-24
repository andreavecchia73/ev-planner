package com.andreavecchia.evplanner

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

// Il pianificatore web gira nella WebView: stesso codice della pagina GitHub Pages.
// Il display dell'auto riceve i dati del viaggio dalla pagina e la batteria da Home Assistant.
class MainActivity : ComponentActivity() {

    private val locationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private lateinit var web: WebView
    private val handler = Handler(Looper.getMainLooper())
    private val batteryPoll = object : Runnable {
        override fun run() {
            HaClient.refreshAll(HaClient.loadSettings(this@MainActivity)) { json ->
                runOnUiThread { pushCarToPlanner(json) }
            }
            handler.postDelayed(this, POLL_MS)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)

        web = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = object : WebViewClient() {
                // La pagina può caricarsi dopo la prima lettura: alla fine del caricamento le si reinvia la batteria.
                override fun onPageFinished(view: WebView?, url: String?) {
                    pushBatteryToPlanner()
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onGeolocationPermissionsShowPrompt(
                    origin: String,
                    callback: GeolocationPermissions.Callback,
                ) {
                    // L'accesso reale alla posizione è già governato dal permesso Android sopra.
                    callback.invoke(origin, true, false)
                }
            }
            addJavascriptInterface(EvBridge(this@MainActivity), "EvBridge")
        }

        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(web)
        })
        web.loadUrl(PLANNER_URL)

        TripState.onBatteryChanged = {
            pushBatteryToPlanner()
        }
        handler.post(batteryPoll)
        TripWorker.schedule(this)
    }

    override fun onDestroy() {
        handler.removeCallbacks(batteryPoll)
        super.onDestroy()
    }

    // La batteria letta da Home Assistant riallinea la stima della pagina, che ripianifica le soste.
    // La batteria riallinea il piano al massimo ogni 2 minuti, per non ricalcolare a ogni lettura.
    private var lastBatteryPush = 0L
    private fun pushBatteryToPlanner() {
        val now = System.currentTimeMillis()
        val pct = TripState.snapshot().batteryPct ?: return
        if (now - lastBatteryPush < BATTERY_PUSH_MS) return
        lastBatteryPush = now
        web.evaluateJavascript("window.evSetBattery && window.evSetBattery($pct);", null)
    }

    // Valori dei sensori dell'auto: la pagina li usa per lo storico dei viaggi.
    private fun pushCarToPlanner(json: String) {
        web.evaluateJavascript("window.evSetCar && window.evSetCar($json);", null)
    }

    companion object {
        private const val PLANNER_URL = "https://andreavecchia73.github.io/ev-planner/"
        private const val POLL_MS = 30_000L
        private const val BATTERY_PUSH_MS = 120_000L
    }
}
