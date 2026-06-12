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
};

export type ServiceRecord = {
  id: number;
  title: string;
  note: string;
  odometer_km: number;
  cost: number;
  service_date: string;
};

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
