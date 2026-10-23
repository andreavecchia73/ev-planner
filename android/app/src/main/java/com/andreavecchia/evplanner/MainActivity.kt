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
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

// Il pianificatore web gira nella WebView: stesso codice della pagina GitHub Pages.
// Il display dell'auto riceve i dati del viaggio dalla pagina e la batteria da Home Assistant.
class MainActivity : ComponentActivity() {

    private val locationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

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

        val web = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = WebViewClient()
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

        val settingsButton = Button(this).apply {
            text = "Impostazioni Home Assistant"
            setOnClickListener { showHaSettings() }
        }

        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(settingsButton)
            addView(web)
        })
        web.loadUrl(PLANNER_URL)

        handler.post(batteryPoll)
    }

    override fun onDestroy() {
        handler.removeCallbacks(batteryPoll)
        super.onDestroy()
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
        private const val BATTERY_POLL_MS = 60_000L
    }
}
