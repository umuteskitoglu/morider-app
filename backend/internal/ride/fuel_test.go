package ride

import (
	"math"
	"testing"
)

func approx(a, b float64) bool { return math.Abs(a-b) < 0.01 }

func TestComputeFuelSummaryFullToFull(t *testing.T) {
	// Three brim-full fills. The first is the baseline; the litres added at the
	// later two (15 + 14 = 29 L) cover 600 km → 4.833 L/100km.
	// loadFuelLogs returns newest-first, so feed them that way to mirror the DB.
	logs := []FuelLog{
		{Liters: 14, Cost: 700, OdometerKm: 10600, IsFullTank: true},
		{Liters: 15, Cost: 750, OdometerKm: 10300, IsFullTank: true},
		{Liters: 12, Cost: 600, OdometerKm: 10000, IsFullTank: true},
	}
	s := computeFuelSummary(logs)
	if s.DistanceKm != 600 {
		t.Errorf("distance = %d, want 600", s.DistanceKm)
	}
	if !approx(s.AvgConsumption, 29.0/600.0*100.0) {
		t.Errorf("avg consumption = %f, want ~4.83", s.AvgConsumption)
	}
	if !approx(s.TotalLiters, 41) {
		t.Errorf("total liters = %f, want 41", s.TotalLiters)
	}
	if !approx(s.TotalCost, 2050) {
		t.Errorf("total cost = %f, want 2050", s.TotalCost)
	}
	if !approx(s.CostPerKm, 2050.0/600.0) {
		t.Errorf("cost per km = %f, want ~3.42", s.CostPerKm)
	}
}

func TestComputeFuelSummaryNeedsTwoFullFills(t *testing.T) {
	logs := []FuelLog{{Liters: 12, OdometerKm: 10000, IsFullTank: true}}
	s := computeFuelSummary(logs)
	if s.AvgConsumption != 0 || s.DistanceKm != 0 {
		t.Errorf("single fill should not yield consumption: %+v", s)
	}
	if !approx(s.TotalLiters, 12) {
		t.Errorf("total liters should still accumulate: %f", s.TotalLiters)
	}
}

func TestComputeFuelSummaryIgnoresPartialFills(t *testing.T) {
	// A partial fill between two full fills must not break the span, and its
	// litres are not counted toward burned fuel for consumption.
	logs := []FuelLog{
		{Liters: 20, OdometerKm: 10400, IsFullTank: true},
		{Liters: 5, OdometerKm: 10200, IsFullTank: false}, // partial top-up
		{Liters: 10, OdometerKm: 10000, IsFullTank: true},
	}
	s := computeFuelSummary(logs)
	if s.DistanceKm != 400 {
		t.Errorf("distance should span the two full fills (400), got %d", s.DistanceKm)
	}
	if !approx(s.AvgConsumption, 20.0/400.0*100.0) {
		t.Errorf("avg consumption = %f, want 5.0", s.AvgConsumption)
	}
}
