// Small Turkish date/time formatting helpers. Written by hand instead of relying
// on Intl, which is only partially available on Hermes across devices.

const MONTHS = [
  'Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz',
  'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara',
];
const DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// "12 Haz Çar · 14:30"
export function formatDateTime(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${DAYS[d.getDay()]} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "14:30"
export function formatTime(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Remaining time until a future moment: "45 dk", "3 sa", "2 sa 30 dk", "5 gün".
// Returns '' when the moment has passed (or the value is invalid).
export function timeUntil(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return '';
  const diffMin = Math.round((d.getTime() - Date.now()) / 60_000);
  if (diffMin <= 0) return '';
  if (diffMin < 60) return `${diffMin} dk`;
  if (diffMin < 24 * 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return h < 6 && m > 0 ? `${h} sa ${m} dk` : `${h} sa`;
  }
  return `${Math.round(diffMin / (24 * 60))} gün`;
}

// Elapsed time since a past moment: "şimdi", "12 dk", "3 sa", "5 gün", then the
// date once it stops being useful to count. Used by the notification list, where
// "2 sa" reads faster than a timestamp you have to compare against the clock.
export function timeAgo(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return '';
  const diffMin = Math.round((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return 'şimdi';
  if (diffMin < 60) return `${diffMin} dk`;
  if (diffMin < 24 * 60) return `${Math.floor(diffMin / 60)} sa`;
  const days = Math.floor(diffMin / (24 * 60));
  if (days < 7) return `${days} gün`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// "Bugün" / "Yarın" for near dates, otherwise null (caller falls back to the
// full date).
export function dayLabel(value: string | Date): 'Bugün' | 'Yarın' | null {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return null;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  if (diffDays === 0) return 'Bugün';
  if (diffDays === 1) return 'Yarın';
  return null;
}

// "12 Haziran 2026 Çarşamba" style long date for headers.
export function formatLongDate(value: string | Date): string {
  const long = [
    'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
    'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
  ];
  const longDays = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return '';
  return `${d.getDate()} ${long[d.getMonth()]} ${d.getFullYear()} ${longDays[d.getDay()]}`;
}
