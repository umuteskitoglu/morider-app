// POI (mola noktası) vocabularies — values must match the backend CHECK
// constraint (migrations/0019_pois.sql).

export const POI_CATEGORIES = ['cafe', 'fuel', 'repair', 'viewpoint', 'rest'] as const;
export type POICategory = (typeof POI_CATEGORIES)[number];

export type POI = {
  id: number;
  user_id: number;
  name: string;
  category: string;
  description: string;
  lat: number;
  lon: number;
  owner_name: string;
};

export const POI_LABELS: Record<POICategory, string> = {
  cafe: 'Kafe',
  fuel: 'Yakıt',
  repair: 'Tamirci',
  viewpoint: 'Manzara',
  rest: 'Mola',
};

// MaterialCommunityIcons names per category.
export const POI_ICONS: Record<POICategory, string> = {
  cafe: 'coffee',
  fuel: 'gas-station',
  repair: 'wrench',
  viewpoint: 'image-filter-hdr',
  rest: 'sofa-single',
};

// Marker accent per category (dark theme friendly).
export const POI_COLORS: Record<POICategory, string> = {
  cafe: '#d4915d',
  fuel: '#4dabf7',
  repair: '#adb5bd',
  viewpoint: '#69db7c',
  rest: '#b197fc',
};

export function poiLabel(category: string): string {
  return (POI_LABELS as Record<string, string>)[category] ?? category;
}

export function poiIcon(category: string): string {
  return (POI_ICONS as Record<string, string>)[category] ?? 'map-marker';
}

export function poiColor(category: string): string {
  return (POI_COLORS as Record<string, string>)[category] ?? '#ff5a1f';
}
