package ride

import (
	"testing"
	"time"
)

func TestMaintenanceStatusByDistance(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)

	// Oil every 6000 km, last done at 10000, now at 12000 → 4000 km left → ok.
	dueKm, dueDays, status := maintenanceStatus(6000, 10000, 12000, 0, nil, now)
	if dueDays != nil {
		t.Errorf("no time interval set, dueDays should be nil")
	}
	if dueKm == nil || *dueKm != 4000 {
		t.Fatalf("dueKm = %v, want 4000", dueKm)
	}
	if status != "ok" {
		t.Errorf("status = %q, want ok", status)
	}

	// 200 km left → within the soon band.
	_, _, status = maintenanceStatus(6000, 10000, 15800, 0, nil, now)
	if status != "soon" {
		t.Errorf("status = %q, want soon", status)
	}

	// Past due → overdue, with a negative remaining.
	dueKm, _, status = maintenanceStatus(6000, 10000, 16500, 0, nil, now)
	if status != "overdue" {
		t.Errorf("status = %q, want overdue", status)
	}
	if dueKm == nil || *dueKm != -500 {
		t.Errorf("dueKm = %v, want -500", dueKm)
	}
}

func TestMaintenanceStatusByTime(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	lastDone := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	// Every 12 months from Jan 1 → due next Jan 1, ~185 days away → ok.
	_, dueDays, status := maintenanceStatus(0, 0, 0, 12, &lastDone, now)
	if dueDays == nil || *dueDays < 180 || *dueDays > 190 {
		t.Fatalf("dueDays = %v, want ~185", dueDays)
	}
	if status != "ok" {
		t.Errorf("status = %q, want ok", status)
	}

	// Every 6 months → due Jul 1, one day away → soon.
	_, dueDays, status = maintenanceStatus(0, 0, 0, 6, &lastDone, now)
	if dueDays == nil || *dueDays != 1 {
		t.Fatalf("dueDays = %v, want 1", dueDays)
	}
	if status != "soon" {
		t.Errorf("status = %q, want soon", status)
	}
}

func TestMaintenanceStatusTakesWorseDimension(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	lastDone := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)

	// Distance is fine (plenty of km left) but the time interval is overdue
	// (every 1 month from Jun 1 → due Jul 1... actually that's +1 day, so make it
	// clearly overdue with a date in the past). Use interval that already passed.
	pastDone := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	_, _, status := maintenanceStatus(6000, 10000, 11000, 3, &pastDone, now)
	if status != "overdue" {
		t.Errorf("status = %q, want overdue (time dimension overrides ok distance)", status)
	}
	_ = lastDone
}
