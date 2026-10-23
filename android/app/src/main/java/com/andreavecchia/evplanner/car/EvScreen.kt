package com.andreavecchia.evplanner.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Pane
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import com.andreavecchia.evplanner.TripState

// Cruscotto per il display dell'auto: batteria, prossima tappa, arrivo, con km e tempi.
class EvScreen(carContext: CarContext) : Screen(carContext) {

    init {
        TripState.onChanged = { invalidate() }
    }

    override fun onGetTemplate(): Template {
        val s = TripState.snapshot()
        if (!s.hasTrip) {
            return MessageTemplate.Builder("Apri EV Planner sul telefono e pianifica un viaggio.")
                .setTitle("EV Planner")
                .setHeaderAction(Action.APP_ICON)
                .build()
        }

        val battery = when {
            s.batteryPct != null -> "${s.batteryPct.toInt()}%"
            s.soc != null -> "${s.soc}% stimata"
            else -> "—"
        }
        val batteryNote = s.batteryError?.let { " · $it" } ?: ""

        val stop = if (s.stopName != null && s.stopKm != null && s.stopMin != null) {
            "${formatKm(s.stopKm)} · ${formatMin(s.stopMin)}"
        } else {
            "Nessuna sosta"
        }
        val arrival = "${formatKm(s.arrivalKm!!)} · ${formatMin(s.arrivalMin ?: 0.0)}"

        val pane = Pane.Builder()
            .addRow(Row.Builder().setTitle("Batteria").addText("$battery$batteryNote").build())
            .addRow(Row.Builder().setTitle("Prossima sosta: ${s.stopName ?: ""}").addText(stop).build())
            .addRow(Row.Builder().setTitle("Arrivo (con ricariche)").addText(arrival).build())
            .build()

        return PaneTemplate.Builder(pane)
            .setTitle("EV Planner")
            .setHeaderAction(Action.APP_ICON)
            .build()
    }

    private fun formatKm(km: Double): String =
        if (km < 1) "${(km * 1000).toInt()} m" else String.format("%.1f km", km)

    private fun formatMin(min: Double): String {
        val total = min.toInt()
        val h = total / 60
        val m = total % 60
        return if (h > 0) "$h h $m min" else "$m min"
    }
}
