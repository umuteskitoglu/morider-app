package route

import "testing"

const nominatimSample = `[
  {
    "lat": "41.0369",
    "lon": "28.9850",
    "name": "Taksim Meydanı",
    "display_name": "Taksim Meydanı, Beyoğlu, İstanbul, Marmara Bölgesi, Türkiye",
    "address": { "suburb": "Taksim", "city": "İstanbul", "state": "Marmara Bölgesi" }
  },
  {
    "lat": "39.9208",
    "lon": "32.8541",
    "name": "",
    "display_name": "Kızılay, Çankaya, Ankara, İç Anadolu Bölgesi, Türkiye",
    "address": { "town": "Ankara", "state": "İç Anadolu Bölgesi" }
  },
  {
    "lat": "not-a-number",
    "lon": "10.0",
    "name": "Bad",
    "display_name": "Bad entry"
  }
]`

func TestParseNominatimSearch(t *testing.T) {
	places, err := parseNominatimSearch([]byte(nominatimSample))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The third entry has an unparseable lat and must be skipped.
	if len(places) != 2 {
		t.Fatalf("expected 2 places, got %d", len(places))
	}
	if places[0].Lat != 41.0369 || places[0].Lon != 28.9850 {
		t.Errorf("first place coords wrong: %+v", places[0])
	}
	if places[0].Name != "Taksim Meydanı, İstanbul, Marmara Bölgesi" {
		t.Errorf("unexpected label: %q", places[0].Name)
	}
	// No name → falls back to road/suburb-less label using town + state.
	if places[1].Name != "Ankara, İç Anadolu Bölgesi" {
		t.Errorf("unexpected label: %q", places[1].Name)
	}
}

func TestParseNominatimSearchErrors(t *testing.T) {
	if _, err := parseNominatimSearch([]byte(`{not json`)); err == nil {
		t.Error("expected error for malformed json, got nil")
	}
	// An empty result array is valid (no matches), not an error.
	places, err := parseNominatimSearch([]byte(`[]`))
	if err != nil {
		t.Errorf("unexpected error for empty array: %v", err)
	}
	if len(places) != 0 {
		t.Errorf("expected 0 places, got %d", len(places))
	}
}

func TestPlaceLabelFallback(t *testing.T) {
	// No name and no address parts → use display_name verbatim.
	var r nominatimResult
	r.DisplayName = "Somewhere remote"
	if got := placeLabel(r); got != "Somewhere remote" {
		t.Errorf("placeLabel fallback = %q, want display_name", got)
	}
}
