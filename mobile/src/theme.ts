// Morider design language — "Night Ride".
// A carbon-black canvas lit by molten headlight amber. Cool greys keep the
// chrome calm so the ember accent and rider photos carry the energy.
export const colors = {
  bg: '#0B0D10', // carbon black
  bgAlt: '#101317',
  surface: '#15191F', // raised glass base
  surfaceAlt: '#1C212A',
  surfaceHi: '#232A34', // pressed / hovered
  glass: 'rgba(28,33,41,0.72)', // translucent panels over content
  glassBorder: 'rgba(255,255,255,0.08)',

  primary: '#FF6A1A', // molten ember (headlight amber)
  primaryDark: '#C2440A',
  accent: '#FFB020', // hot amber highlight
  cyan: '#35E0C8', // cool tech accent — telemetry, speed, used sparingly

  text: '#F4F6F8',
  textMuted: '#8A929E',
  textFaint: '#586170',
  border: '#252B33',
  borderStrong: '#333C47',

  success: '#34D399',
  danger: '#FF4D4D',
  warning: '#FFB020',
};

// Type scale — a single source for font sizes / weights so screens stay in
// rhythm. RN uses the platform UI font; weights do the heavy lifting.
export const type = {
  display: { fontSize: 34, fontWeight: '900' as const, letterSpacing: 0.5 },
  title: { fontSize: 22, fontWeight: '900' as const, letterSpacing: 0.3 },
  heading: { fontSize: 17, fontWeight: '800' as const, letterSpacing: 0.2 },
  body: { fontSize: 15, fontWeight: '500' as const },
  label: { fontSize: 12, fontWeight: '800' as const, letterSpacing: 1, textTransform: 'uppercase' as const },
  caption: { fontSize: 12, fontWeight: '600' as const },
  mono: { fontSize: 15, fontWeight: '800' as const, letterSpacing: 0.5 }, // telemetry numbers
};

// Gradient stops (use with expo-linear-gradient).
export const gradients = {
  primary: ['#FFB020', '#FF6A1A', '#E24A00'] as const, // molten amber sweep
  ember: ['#FF8A2A', '#FF5A00'] as const,
  danger: ['#FF7A7A', '#FF4D4D', '#C81E2A'] as const,
  hero: ['#1A140E', '#11141A', '#0B0D10'] as const, // warm-to-carbon backdrop
  surface: ['#1C212A', '#13171C'] as const,
  glass: ['rgba(42,48,58,0.66)', 'rgba(18,22,28,0.55)'] as const,
  night: ['#0B0D10', '#13171D', '#0B0D10'] as const,
  cyan: ['#5FF3DE', '#1FB9A4'] as const,
  scrim: ['transparent', 'rgba(8,9,11,0.55)', 'rgba(8,9,11,0.96)'] as const,
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
  sm: 10,
  md: 16,
  lg: 22,
  xl: 28,
  xxl: 36,
  pill: 999,
};

// Reusable elevation presets.
export const shadow = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  glow: {
    shadowColor: '#FF6A1A',
    shadowOpacity: 0.55,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  soft: {
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
};
