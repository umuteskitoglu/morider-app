export const colors = {
  bg: '#0A0E16', // deep asphalt black
  bgAlt: '#0F1521',
  surface: '#161D2B',
  surfaceAlt: '#1F2838',
  primary: '#FF5A1F', // racing orange
  primaryDark: '#E03E00',
  accent: '#FFB020', // amber highlight
  text: '#F5F7FB',
  textMuted: '#8A96AD',
  border: '#252F42',
  success: '#2FD27A',
  danger: '#FF4D5E',
};

// Gradient stops (use with expo-linear-gradient).
export const gradients = {
  primary: ['#FF8A4C', '#FF5A1F', '#E03E00'] as const,
  danger: ['#FF6B7A', '#FF4D5E', '#D32F3E'] as const,
  hero: ['#1B2336', '#0F1521', '#0A0E16'] as const,
  surface: ['#1C2433', '#141B27'] as const,
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
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  glow: {
    shadowColor: '#FF5A1F',
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
};
