// Garage types + document expiry helpers. Dates are "YYYY-MM-DD" strings
// (empty = not set), matching the backend (internal/ride/garage.go).

export type Motorcycle = {
  id: number;
  name: string;
  plate: string;
  year: number;
  insurance_expiry: string;
  kasko_expiry: string;
  inspection_expiry: string;
  // Fuel & range (internal/ride/fuel.go). 0 = not set.
  tank_liters: number;
  avg_consumption: number; // L/100km, auto-derived from full fills
  fuel_type: string;
};

export type ServiceRecord = {
  id: number;
  title: string;
  note: string;
  odometer_km: number;
  cost: number;
  service_date: string;
};

// Fuel log + summary, matching internal/ride/fuel.go.
export type FuelLog = {
  id: number;
  liters: number;
  cost: number;
  odometer_km: number;
  is_full_tank: boolean;
  lat: number;
  lon: number;
  filled_at: string;
};

export type FuelSummary = {
  avg_consumption: number; // L/100km
  total_liters: number;
  total_cost: number;
  distance_km: number;
  cost_per_km: number;
};

// Maintenance schedule with derived state, matching internal/ride/maintenance.go.
export type MaintenanceItem = {
  id: number;
  item: string;
  interval_km: number;
  interval_months: number;
  last_done_km: number;
  last_done_at: string;
  due_in_km?: number; // negative = overdue
  due_in_days?: number;
  status: 'ok' | 'soon' | 'overdue';
};

// Tank range in km from capacity (L) and consumption (L/100km); null when unknown.
export function rangeKm(tankLiters: number, avgConsumption: number): number | null {
  if (!tankLiters || !avgConsumption) return null;
  return (tankLiters / avgConsumption) * 100;
}

// Colour + short Turkish label for a maintenance item's status, reusing the
// document-expiry colour scheme (green / amber / red).
export function maintenanceStatusInfo(m: MaintenanceItem): { color: string; text: string } {
  const color = m.status === 'overdue' ? '#ff4d5e' : m.status === 'soon' ? '#f59f00' : '#37b24d';
  const parts: string[] = [];
  if (m.due_in_km != null) {
    parts.push(m.due_in_km <= 0 ? `${(-m.due_in_km).toLocaleString('tr-TR')} km geçti` : `${m.due_in_km.toLocaleString('tr-TR')} km`);
  }
  if (m.due_in_days != null) {
    parts.push(m.due_in_days <= 0 ? `${-m.due_in_days} gün geçti` : `${m.due_in_days} gün`);
  }
  return { color, text: parts.join(' · ') || 'Planlandı' };
}

// Document keys with Turkish labels, in display order.
export const DOC_KEYS = ['insurance_expiry', 'inspection_expiry', 'kasko_expiry'] as const;
export type DocKey = (typeof DOC_KEYS)[number];

export const DOC_LABELS: Record<DocKey, string> = {
  insurance_expiry: 'Trafik Sigortası',
  inspection_expiry: 'Muayene',
  kasko_expiry: 'Kasko',
};

export const DOC_ICONS: Record<DocKey, string> = {
  insurance_expiry: 'shield-car',
  inspection_expiry: 'clipboard-check-outline',
  kasko_expiry: 'shield-star-outline',
};

// Whole days from today (local midnight) to the given date; null when unset.
export function daysLeft(dateISO: string): number | null {
  if (!dateISO) return null;
  const target = new Date(`${dateISO}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export type ExpiryStatus = {
  // 'none' = date not set, 'expired' | 'soon' (≤30 days) | 'ok'
  level: 'none' | 'expired' | 'soon' | 'ok';
  color: string;
  text: string;
};

export function expiryStatus(dateISO: string): ExpiryStatus {
  const days = daysLeft(dateISO);
  if (days == null) return { level: 'none', color: '#6b7280', text: 'Tarih yok' };
  if (days < 0) return { level: 'expired', color: '#ff4d5e', text: `${-days} gün geçti!` };
  if (days === 0) return { level: 'expired', color: '#ff4d5e', text: 'Bugün doluyor!' };
  if (days <= 30) return { level: 'soon', color: '#f59f00', text: `${days} gün kaldı` };
  return { level: 'ok', color: '#37b24d', text: `${days} gün kaldı` };
}

// "2026-08-15" → "15.08.2026" (Turkish display format).
export function formatDateTR(dateISO: string): string {
  if (!dateISO) return '—';
  const [y, m, d] = dateISO.split('-');
  return d && m && y ? `${d}.${m}.${y}` : dateISO;
}

// Date → "YYYY-MM-DD" using local time (not UTC, which can shift the day).
export function toISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
