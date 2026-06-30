// Challenge types + helpers, matching the backend (internal/reward/challenges.go).

export type ChallengeMetric = 'distance' | 'elevation' | 'rides' | 'avg_speed' | 'top_speed';

export type Challenge = {
  id: number;
  creator_id: number;
  title: string;
  description: string;
  metric: ChallengeMetric;
  goal: number;
  starts_at: string;
  ends_at: string;
  participants: number;
  joined: boolean;
  my_progress: number;
};

export type ChallengeStanding = {
  user_id: number;
  name: string;
  avatar_url: string;
  progress: number;
  completed: boolean;
};

export const METRICS: { key: ChallengeMetric; label: string; unit: string; icon: string }[] = [
  { key: 'distance', label: 'Mesafe', unit: 'km', icon: 'map-marker-distance' },
  { key: 'elevation', label: 'Tırmanış', unit: 'm', icon: 'image-filter-hdr' },
  { key: 'rides', label: 'Sürüş', unit: 'sürüş', icon: 'motorbike' },
  { key: 'avg_speed', label: 'Ort. Hız', unit: 'km/s', icon: 'speedometer-medium' },
  { key: 'top_speed', label: 'Maks. Hız', unit: 'km/s', icon: 'speedometer' },
];

export function metricInfo(metric: ChallengeMetric) {
  return METRICS.find((m) => m.key === metric) ?? METRICS[0];
}

// Human value with unit, e.g. "300 km", "5.000 m", "20 sürüş".
export function fmtMetric(metric: ChallengeMetric, value: number): string {
  const info = metricInfo(metric);
  const n = metric === 'rides' ? Math.round(value) : Math.round(value);
  return `${n.toLocaleString('tr-TR')} ${info.unit}`;
}

// Progress fraction in [0,1].
export function progressFraction(progress: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.max(0, Math.min(1, progress / goal));
}

// Whole days from now until ISO date; negative when past.
export function daysUntil(iso: string): number {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return 0;
  return Math.ceil((target.getTime() - Date.now()) / 86_400_000);
}

// Short status line for a challenge based on its window.
export function windowLabel(c: Challenge): string {
  const startsIn = daysUntil(c.starts_at);
  const endsIn = daysUntil(c.ends_at);
  if (startsIn > 0) return `${startsIn} gün sonra başlıyor`;
  if (endsIn < 0) return 'Bitti';
  if (endsIn === 0) return 'Bugün bitiyor';
  return `${endsIn} gün kaldı`;
}
