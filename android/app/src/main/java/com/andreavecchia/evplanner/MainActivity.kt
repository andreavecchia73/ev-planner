package com.andreavecchia.evplanner

import android.Manifest
import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

// Il pianificatore web gira nella WebView: stesso codice della pagina GitHub Pages.
class MainActivity : ComponentActivity() {

    private val locationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)

        val web = WebView(this).apply {
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
        }
        setContentView(web)
        web.loadUrl(PLANNER_URL)
    }

    companion object {
        private const val PLANNER_URL = "https://andreavecchia73.github.io/ev-planner/"
    }
}
