// Rider profile vocabularies — values must match the backend CHECK
// constraints (migrations/0018_rider_profile.sql).

export const LICENSE_TYPES = ['A1', 'A2', 'A', 'B'] as const;
export type LicenseType = (typeof LICENSE_TYPES)[number];

export const LICENSE_LABELS: Record<LicenseType, string> = {
  A1: 'A1 · 125cc',
  A2: 'A2 · 35kW',
  A: 'A · Sınırsız',
  B: 'B · Otomobil',
};

export const BIKE_TYPES = [
  'naked',
  'sport',
  'touring',
  'adventure',
  'chopper',
  'enduro',
  'scooter',
  'custom',
] as const;
export type BikeType = (typeof BIKE_TYPES)[number];

export const BIKE_LABELS: Record<BikeType, string> = {
  naked: 'Naked',
  sport: 'Sport',
  touring: 'Touring',
  adventure: 'Adventure',
  chopper: 'Chopper',
  enduro: 'Enduro',
  scooter: 'Scooter',
  custom: 'Custom',
};

export function licenseLabel(v: string | undefined): string | null {
  return v && v in LICENSE_LABELS ? LICENSE_LABELS[v as LicenseType] : null;
}

export function bikeLabel(v: string | undefined): string | null {
  return v && v in BIKE_LABELS ? BIKE_LABELS[v as BikeType] : null;
}
