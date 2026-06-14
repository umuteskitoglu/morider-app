package config

import "testing"

func TestValidate(t *testing.T) {
	cases := []struct {
		name    string
		cfg     Config
		wantErr bool
	}{
		{"dev with default secret", Config{AppEnv: "development", JWTSecret: defaultJWTSecret}, false},
		{"prod with strong secret", Config{AppEnv: "production", JWTSecret: "a-very-strong-secret", LiveKitAPISecret: "a-very-strong-livekit-secret"}, false},
		{"prod with default secret", Config{AppEnv: "production", JWTSecret: defaultJWTSecret}, true},
		{"prod with empty secret", Config{AppEnv: "production", JWTSecret: ""}, true},
		{"prod with default livekit secret", Config{AppEnv: "production", JWTSecret: "a-very-strong-secret", LiveKitAPISecret: defaultLiveKitSecret}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.cfg.Validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("Validate() error = %v, wantErr = %v", err, tc.wantErr)
			}
		})
	}
}
