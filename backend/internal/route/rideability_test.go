package route

import "testing"

func TestScoreRideability(t *testing.T) {
	cases := []struct {
		name      string
		in        RideWeather
		wantLevel string
		minScore  int
		maxScore  int
		wantWarn  string // a substring that must appear in some warning ("" = expect none)
	}{
		{
			name:      "clear mild day",
			in:        RideWeather{TempC: 22, FeelsLikeC: 22, WindKph: 8, GustKph: 12, VisibilityM: 20000, WeatherCode: 0},
			wantLevel: "good",
			minScore:  100, maxScore: 100,
			wantWarn: "",
		},
		{
			name:      "light drizzle is caution-ish but still rideable",
			in:        RideWeather{TempC: 16, FeelsLikeC: 15, WindKph: 10, GustKph: 15, VisibilityM: 12000, WeatherCode: 53},
			wantLevel: "good",
			minScore:  80, maxScore: 90,
			wantWarn: "Çiseleme",
		},
		{
			name:      "steady rain knocks it to caution",
			in:        RideWeather{TempC: 14, FeelsLikeC: 13, WindKph: 20, GustKph: 35, VisibilityM: 8000, WeatherCode: 63},
			wantLevel: "caution",
			minScore:  cautionScore, maxScore: goodScore - 1,
			wantWarn: "ıslak",
		},
		{
			name:      "thunderstorm is poor",
			in:        RideWeather{TempC: 18, FeelsLikeC: 18, WindKph: 30, GustKph: 55, VisibilityM: 5000, WeatherCode: 95},
			wantLevel: "poor",
			minScore:  0, maxScore: cautionScore - 1,
			wantWarn: "fırtına",
		},
		{
			name:      "snow and cold is poor",
			in:        RideWeather{TempC: 1, FeelsLikeC: -2, WindKph: 15, GustKph: 25, VisibilityM: 3000, WeatherCode: 73},
			wantLevel: "poor",
			minScore:  0, maxScore: cautionScore - 1,
			wantWarn: "buzlanma",
		},
		{
			name:      "strong gusts on a clear day still warn",
			in:        RideWeather{TempC: 20, FeelsLikeC: 20, WindKph: 40, GustKph: 65, VisibilityM: 20000, WeatherCode: 1},
			wantLevel: "caution",
			minScore:  cautionScore, maxScore: goodScore - 1,
			wantWarn: "kuvvetli rüzgar",
		},
		{
			name:      "dense fog warns and drops the score",
			in:        RideWeather{TempC: 12, FeelsLikeC: 11, WindKph: 5, GustKph: 8, VisibilityM: 400, WeatherCode: 45},
			wantLevel: "caution",
			minScore:  cautionScore, maxScore: goodScore - 1,
			wantWarn: "Sis",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := scoreRideability(tc.in)
			if got.Score < tc.minScore || got.Score > tc.maxScore {
				t.Errorf("score = %d, want in [%d,%d]", got.Score, tc.minScore, tc.maxScore)
			}
			if got.Level != tc.wantLevel {
				t.Errorf("level = %q, want %q", got.Level, tc.wantLevel)
			}
			if tc.wantWarn == "" {
				if len(got.Warnings) != 0 {
					t.Errorf("expected no warnings, got %v", got.Warnings)
				}
				return
			}
			if !containsSubstring(got.Warnings, tc.wantWarn) {
				t.Errorf("warnings %v do not contain %q", got.Warnings, tc.wantWarn)
			}
		})
	}
}

func containsSubstring(list []string, sub string) bool {
	for _, s := range list {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
	}
	return false
}
