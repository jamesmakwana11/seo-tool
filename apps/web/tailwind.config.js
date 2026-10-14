/** @type {import('tailwindcss').Config} */
// White + lavender premium theme. Token names are shared by every screen, so the whole app re-themes from here.
// Status colours have an `ink` shade for text on white (the base shades are for fills, bars and icons).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#FAF9FD', // workspace background
        surface: '#FFFFFF', // cards / panels / sidebar
        raised: '#F5F0FF', // pale violet: selected rows, secondary panels, table headers
        lavender: '#E9E0FC',
        ink: { DEFAULT: '#252238', soft: '#45415A', side: '#FFFFFF' }, // primary text; side = sidebar
        muted: '#777487', // secondary text
        faint: '#9A97A8',
        line: { DEFAULT: '#EAE6F2', strong: '#DDD6EA' },
        signal: { DEFAULT: '#7650D8', dark: '#5E3CC2', light: '#9474E8', soft: '#B6A0F5', tint: '#E9E0FC' }, // primary violet
        'on-signal': '#FFFFFF',
        crit: { DEFAULT: '#DC5C6A', tint: '#FDF0F2', ink: '#C23A4A' },
        med: { DEFAULT: '#E7A43B', tint: '#FDF6EA', ink: '#A0650A' },
        low: { DEFAULT: '#6B8FE8', tint: '#EFF3FD', ink: '#3E66C9' }, // information
        opp: { DEFAULT: '#3A9FB0', tint: '#ECF7F9', ink: '#24788A' },
        ok: { DEFAULT: '#27AE79', tint: '#E9F7F1', ink: '#1A7D55' },
        demo: { DEFAULT: '#A0650A', tint: '#FDF3DF' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { panel: '18px', ctl: '10px' },
      fontSize: { '2xs': ['0.6875rem', '1rem'] },
      boxShadow: {
        card: '0 1px 2px rgba(37,34,56,0.04), 0 4px 16px -6px rgba(37,34,56,0.06)',
        lift: '0 8px 24px -8px rgba(118,80,216,0.18), 0 2px 6px rgba(37,34,56,0.04)',
        pop: '0 18px 44px -10px rgba(37,34,56,0.20), 0 4px 12px rgba(37,34,56,0.06)',
      },
    },
  },
  plugins: [],
};
