package main

import "math/rand"

// getWeatherData simulates fetching weather data for a city
func getWeatherData(city string) map[string]interface{} {
	conditions := []string{"sunny", "cloudy", "rainy", "snowy", "windy"}
	weather := conditions[rand.Intn(len(conditions))]
	temperature := rand.Intn(40) + 40
	return map[string]interface{}{
		"city":        city,
		"weather":     weather,
		"temperature": temperature,
	}
}
