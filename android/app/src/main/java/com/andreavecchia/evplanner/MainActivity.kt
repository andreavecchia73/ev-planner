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

    private lateinit var haStatus: TextView
    private lateinit var web: WebView
    private val handler = Handler(Looper.getMainLooper())
    private val batteryPoll = object : Runnable {
        override fun run() {
            HaClient.refreshBattery(HaClient.loadSettings(this@MainActivity))
            handler.postDelayed(this, BATTERY_POLL_MS)
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
            addJavascriptInterface(EvBridge(), "EvBridge")
        }

        // Lo stato di Home Assistant è anche il punto di accesso alle credenziali: toccalo per modificarle.
        haStatus = TextView(this).apply {
            setPadding(24, 16, 24, 16)
            text = "Home Assistant: in attesa di lettura"
            setOnClickListener { showHaSettings() }
        }

        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(haStatus)
            addView(web)
        })
        web.loadUrl(PLANNER_URL)

        TripState.onBatteryChanged = {
            updateButton()
            pushBatteryToPlanner()
        }
        handler.post(batteryPoll)
    }

    override fun onDestroy() {
        handler.removeCallbacks(batteryPoll)
        super.onDestroy()
    }

    // La riga mostra la batteria letta da Home Assistant, oppure l'errore preciso.
    private fun updateButton() {
        val s = TripState.snapshot()
        haStatus.text = when {
            s.batteryPct != null -> "Batteria Jaecoo7: ${s.batteryPct.toInt()}%"
            s.batteryError != null -> "Home Assistant: ${s.batteryError}"
            else -> "Home Assistant: in attesa di lettura"
        }
    }

    // La batteria letta da Home Assistant riallinea la stima della pagina, che ripianifica le soste.
    private fun pushBatteryToPlanner() {
        val pct = TripState.snapshot().batteryPct ?: return
        web.evaluateJavascript("window.evSetBattery && window.evSetBattery($pct);", null)
    }

    // Impostazioni di Home Assistant: indirizzo, entità della batteria e token di accesso.
    private fun showHaSettings() {
        val current = HaClient.loadSettings(this)
        val url = EditText(this).apply { hint = "https://xxxx.ui.nabu.casa"; setText(current.url) }
        val entity = EditText(this).apply { hint = "sensor.jaecoo7_batteria"; setText(current.entity) }
        val token = EditText(this).apply {
            hint = "Token di accesso a lungo termine"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(current.token)
        }
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 16, 48, 0)
            addView(url)
            addView(entity)
            addView(token)
        }
        AlertDialog.Builder(this)
            .setTitle("Home Assistant")
            .setView(form)
            .setPositiveButton("Salva") { _, _ ->
                val settings = HaClient.Settings(url.text.toString(), entity.text.toString(), token.text.toString())
                HaClient.saveSettings(this, settings)
                HaClient.refreshBattery(settings)
            }
            .setNegativeButton("Annulla", null)
            .show()
    }

    companion object {
        private const val PLANNER_URL = "https://andreavecchia73.github.io/ev-planner/"
        private const val BATTERY_POLL_MS = 120_000L
    }
}
