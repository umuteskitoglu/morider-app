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
