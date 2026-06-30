package route

import "testing"

// Open-Meteo returns a bare object for one location.
const singleLocationBody = `{
  "latitude": 41.0, "longitude": 29.0,
  "current": {
    "temperature_2m": 17.4, "apparent_temperature": 16.1, "precipitation": 0.0,
    "weather_code": 3, "wind_speed_10m": 12.5, "wind_gusts_10m": 22.0,
    "wind_direction_10m": 200, "visibility": 24000
  }
}`

// ...and a JSON array when several locations are requested.
const multiLocationBody = `[
  {"current": {"temperature_2m": 17.4, "apparent_temperature": 16.1, "precipitation": 0.0,
    "weather_code": 3, "wind_speed_10m": 12.5, "wind_gusts_10m": 22.0, "wind_direction_10m": 200, "visibility": 24000}},
  {"current": {"temperature_2m": 14.0, "apparent_temperature": 12.0, "precipitation": 3.2,
    "weather_code": 63, "wind_speed_10m": 30.0, "wind_gusts_10m": 50.0, "wind_direction_10m": 270, "visibility": 6000}}
]`

func TestParseOpenMeteoSingle(t *testing.T) {
	got, err := parseOpenMeteo([]byte(singleLocationBody), 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 result, got %d", len(got))
	}
	if got[0].TempC != 17.4 || got[0].WeatherCode != 3 || got[0].GustKph != 22.0 {
		t.Errorf("parsed wrong values: %+v", got[0])
	}
}

func TestParseOpenMeteoMultiple(t *testing.T) {
	got, err := parseOpenMeteo([]byte(multiLocationBody), 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 results, got %d", len(got))
	}
	if got[1].PrecipMM != 3.2 || got[1].WeatherCode != 63 {
		t.Errorf("second point parsed wrong: %+v", got[1])
	}
}

func TestParseOpenMeteoCountMismatch(t *testing.T) {
	if _, err := parseOpenMeteo([]byte(multiLocationBody), 3); err == nil {
		t.Error("expected an error when result count does not match the request")
	}
}

func TestBuildRouteWeatherPicksWorst(t *testing.T) {
	points := []Point{{Lat: 41.0, Lon: 29.0}, {Lat: 41.1, Lon: 29.1}}
	conditions := []RideWeather{
		{TempC: 20, FeelsLikeC: 20, VisibilityM: 20000, WeatherCode: 0}, // clear
		{TempC: 14, FeelsLikeC: 12, VisibilityM: 6000, WeatherCode: 63}, // rain
	}
	rw := buildRouteWeather(points, conditions)
	if len(rw.Points) != 2 {
		t.Fatalf("want 2 points, got %d", len(rw.Points))
	}
	if rw.Points[1].Dist <= 0 {
		t.Errorf("second point should have a positive cumulative distance, got %f", rw.Points[1].Dist)
	}
	// Overall must reflect the rainy (worse-scoring) point.
	if rw.Overall.Level != "caution" && rw.Overall.Level != "poor" {
		t.Errorf("overall level should track the worst point, got %q", rw.Overall.Level)
	}
	if rw.Overall.Score != rw.Points[1].Rideability.Score {
		t.Errorf("overall score %d should equal worst point score %d", rw.Overall.Score, rw.Points[1].Rideability.Score)
	}
}
