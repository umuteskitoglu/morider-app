export const colors = {
  bg: '#0A0A0B', // asphalt black
  bgAlt: '#101012',
  surface: '#16161A',
  surfaceAlt: '#202026',
  primary: '#E10600', // racing red
  primaryDark: '#9E0400',
  accent: '#FF2A2A', // hot red highlight
  text: '#F5F5F7',
  textMuted: '#8C8C94',
  border: '#2A2A31',
  success: '#2FD27A',
  danger: '#FF3B47',
};

// Gradient stops (use with expo-linear-gradient).
export const gradients = {
  primary: ['#FF3B30', '#E10600', '#9E0400'] as const,
  danger: ['#FF6B6B', '#FF3B47', '#C81E2A'] as const,
  hero: ['#1A1416', '#120E10', '#0A0A0B'] as const,
  surface: ['#1E1E24', '#141418'] as const,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 8,
  md: 14,
  lg: 22,
  xl: 28,
  pill: 999,
};

// Reusable elevation presets.
export const shadow = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  glow: {
    shadowColor: '#E10600',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
};
