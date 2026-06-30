// Reward tier (rarity) presentation, matching internal/reward/rules.go.
export type Tier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'special';

export const TIER_META: Record<Tier, { color: string; label: string }> = {
  bronze: { color: '#CD7F32', label: 'Bronz' },
  silver: { color: '#BFC6CE', label: 'Gümüş' },
  gold: { color: '#FFC93C', label: 'Altın' },
  platinum: { color: '#7FE7E0', label: 'Platin' },
  special: { color: '#9A7BFF', label: 'Özel' },
};

export function tierMeta(tier?: string): { color: string; label: string } {
  return TIER_META[(tier as Tier) ?? 'special'] ?? TIER_META.special;
}

export type RiderLevel = {
  xp: number;
  level: number;
  level_into: number;
  level_span: number;
  season_xp: number;
  badge_count: number;
};
