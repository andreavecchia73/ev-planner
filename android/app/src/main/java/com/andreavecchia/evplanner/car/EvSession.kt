package com.andreavecchia.evplanner.car

import android.content.Intent
import androidx.car.app.Screen
import androidx.car.app.Session

class EvSession : Session() {

    override fun onCreateScreen(intent: Intent): Screen = EvScreen(carContext)
}
