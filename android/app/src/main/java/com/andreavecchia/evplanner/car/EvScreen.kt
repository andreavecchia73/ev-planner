package com.andreavecchia.evplanner.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Template

class EvScreen(carContext: CarContext) : Screen(carContext) {

    override fun onGetTemplate(): Template =
        MessageTemplate.Builder("Apri EV Planner sul telefono per preparare il percorso.")
            .setTitle("EV Planner")
            .setHeaderAction(Action.APP_ICON)
            .build()
}
