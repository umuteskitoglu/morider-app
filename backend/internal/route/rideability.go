package route

// Rideability turns current weather into a 0-100 suitability score for riding a
// motorcycle, plus a coarse level and human warnings (Turkish). It is pure so it
// can be unit-tested without the network, mirroring curvinessScore / ascentDescent.

// RideWeather is the current conditions at a point, as consumed by the scorer.
// Units: Celsius, millimetres, km/h, metres. WeatherCode is the WMO code Open-Meteo
// returns (45/48 fog, 51-67 drizzle/rain, 71-77 snow, 80-86 showers, 95-99 storm).
type RideWeather struct {
	TempC       float64 `json:"temp_c"`
	FeelsLikeC  float64 `json:"feels_like_c"`
	PrecipMM    float64 `json:"precip_mm"`
	WindKph     float64 `json:"wind_kph"`
	GustKph     float64 `json:"gust_kph"`
	WindDir     int     `json:"wind_dir"` // degrees, 0=N
	VisibilityM float64 `json:"visibility_m"`
	WeatherCode int     `json:"weather_code"`
}

// Rideability is the suitability assessment derived from RideWeather.
type Rideability struct {
	Score    int      `json:"score"`    // 0..100, higher is better
	Level    string   `json:"level"`    // good | caution | poor
	Warnings []string `json:"warnings"` // Turkish, empty when conditions are clear
}

// Level thresholds: at or above goodScore is "good" (green), at or above
// cautionScore is "caution" (yellow), below it is "poor" (red).
const (
	goodScore    = 70
	cautionScore = 40
)

// scoreRideability starts from a perfect 100 and subtracts penalties for each
// hazard, capping the score at [0,100]. Penalties are deliberately additive and
// independent so the function stays easy to reason about and test.
func scoreRideability(w RideWeather) Rideability {
	score := 100.0
	warnings := make([]string, 0, 4)

	// Precipitation — the dominant hazard for two wheels. Classify by WMO code
	// first (most reliable signal), then by measured rainfall as a fallback.
	switch {
	case w.WeatherCode >= 95: // thunderstorm
		score -= 55
		warnings = append(warnings, "Gök gürültülü fırtına, sürüş önerilmez")
	case w.WeatherCode >= 71 && w.WeatherCode <= 77, w.WeatherCode >= 85 && w.WeatherCode <= 86: // snow
		score -= 55
		warnings = append(warnings, "Kar/buzlanma, yol kaygan olabilir")
	case w.WeatherCode >= 80 && w.WeatherCode <= 82: // rain showers
		score -= 40
		warnings = append(warnings, "Sağanak yağış, yol ıslak")
	case w.WeatherCode >= 61 && w.WeatherCode <= 67: // rain
		score -= 35
		warnings = append(warnings, "Yağmurlu, yol ıslak olabilir")
	case w.WeatherCode >= 51 && w.WeatherCode <= 57: // drizzle
		score -= 15
		warnings = append(warnings, "Çiseleme, dikkatli sürün")
	case w.PrecipMM >= 0.2: // code unknown but rain measured
		score -= 25
		warnings = append(warnings, "Yağış var, yol ıslak olabilir")
	}

	// Fog / low visibility.
	switch {
	case w.WeatherCode == 45 || w.WeatherCode == 48 || (w.VisibilityM > 0 && w.VisibilityM < 1000):
		score -= 35
		warnings = append(warnings, "Sis / düşük görüş")
	case w.VisibilityM > 0 && w.VisibilityM < 4000:
		score -= 10
		warnings = append(warnings, "Görüş mesafesi azalmış")
	}

	// Wind — gusts matter more than the steady speed for bike stability.
	gust := w.GustKph
	if gust < w.WindKph {
		gust = w.WindKph
	}
	switch {
	case gust >= 60:
		score -= 35
		warnings = append(warnings, "Çok kuvvetli rüzgar")
	case gust >= 45:
		score -= 20
		warnings = append(warnings, "Kuvvetli yan rüzgar olabilir")
	case gust >= 30:
		score -= 10
		warnings = append(warnings, "Rüzgarlı")
	}

	// Temperature — use apparent (feels-like) when present, else dry-bulb.
	temp := w.FeelsLikeC
	if temp == 0 && w.TempC != 0 {
		temp = w.TempC
	}
	switch {
	case temp <= 3:
		score -= 30
		warnings = append(warnings, "Düşük sıcaklık, buzlanma riski")
	case temp <= 8:
		score -= 12
		warnings = append(warnings, "Hava soğuk, giyinin")
	case temp >= 38:
		score -= 12
		warnings = append(warnings, "Aşırı sıcak, sıvı tüketin")
	}

	if score < 0 {
		score = 0
	}
	level := "poor"
	switch {
	case score >= goodScore:
		level = "good"
	case score >= cautionScore:
		level = "caution"
	}
	return Rideability{Score: int(score), Level: level, Warnings: warnings}
}
