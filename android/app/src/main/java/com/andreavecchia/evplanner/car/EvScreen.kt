package com.andreavecchia.evplanner.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Distance
import androidx.car.app.model.Template
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.model.Maneuver
import androidx.car.app.navigation.model.MessageInfo
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutingInfo
import androidx.car.app.navigation.model.Step
import com.andreavecchia.evplanner.TripState

// Schermata di navigazione per Android Auto: prossima manovra, con batteria, sosta e arrivo nel riepilogo.
class EvScreen(carContext: CarContext) : Screen(carContext) {

    init {
        TripState.onChanged = { invalidate() }
        // Le app di navigazione devono dichiarare l'avvio della guida al sistema.
        carContext.getCarService(NavigationManager::class.java).navigationStarted()
    }

    override fun onGetTemplate(): Template {
        val s = TripState.snapshot()
        if (!s.hasTrip) {
            return NavigationTemplate.Builder()
                .setNavigationInfo(
                    MessageInfo.Builder("Apri EV Planner sul telefono e pianifica un viaggio.").build(),
                )
                .build()
        }

        val battery = when {
            s.batteryPct != null -> "${s.batteryPct.toInt()}%"
            s.soc != null -> "${s.soc}% stimata"
            else -> "—"
        }
        val batteryNote = s.batteryError?.let { " ($it)" } ?: ""
        val stop = if (s.stopName != null && s.stopKm != null && s.stopMin != null) {
            "${s.stopName} ${formatKm(s.stopKm)} ${formatMin(s.stopMin)}"
        } else {
            "nessuna sosta"
        }
        val arrival = "${formatKm(s.arrivalKm!!)} ${formatMin(s.arrivalMin ?: 0.0)}"

        val step = Step.Builder(s.stepText ?: "Segui il percorso")
            .setManeuver(Maneuver.Builder(maneuverType(s.stepType)).build())
            .setCue("Batteria $battery$batteryNote · Sosta $stop · Arrivo $arrival")
            .build()
        val routing = RoutingInfo.Builder()
            .setCurrentStep(step, distance(s.stepKm ?: 0.0))
            .build()

        return NavigationTemplate.Builder()
            .setNavigationInfo(routing)
            .build()
    }

    private fun maneuverType(type: String?): Int = when (type) {
        "left" -> Maneuver.TYPE_TURN_NORMAL_LEFT
        "right" -> Maneuver.TYPE_TURN_NORMAL_RIGHT
        "straight" -> Maneuver.TYPE_STRAIGHT
        "arrive" -> Maneuver.TYPE_DESTINATION
        "roundabout" -> Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CW
        "exit" -> Maneuver.TYPE_OFF_RAMP_NORMAL_RIGHT
        else -> Maneuver.TYPE_UNKNOWN
    }

    private fun distance(km: Double): Distance =
        if (km < 1) Distance.create(km * 1000, Distance.UNIT_METERS)
        else Distance.create(km, Distance.UNIT_KILOMETERS)

    private fun formatKm(km: Double): String =
        if (km < 1) "${(km * 1000).toInt()} m" else String.format("%.1f km", km)

    private fun formatMin(min: Double): String {
        val total = min.toInt()
        val h = total / 60
        val m = total % 60
        return if (h > 0) "$h h $m min" else "$m min"
    }
}
