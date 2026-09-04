import type { Config } from 'tailwindcss';

// Dove Expressions brand palette — approved visual design (see prototype).
// Semantic key names are kept stable so existing component classes
// (bg-accent, text-ink-soft, border-line, etc.) didn't need renaming —
// only the hex values underneath changed.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#FDFDFD',
        'paper-sunken': '#F7F1EE',
        surface: '#FFFFFF',
        ink: '#1B1717',
        'ink-soft': '#4C4442',
        'ink-faint': '#8C8280',
        accent: '#630000',
        'accent-strong': '#470000',
        'accent-soft': '#F2DFD8',
        'accent-soft-strong': '#E7C4BA',
        line: '#E9E1DD',
        'line-strong': '#D9CBC5',
        gold: '#E6A742',
        'gold-soft': '#FAF0DC',
        'gold-strong': '#97621C',
        sunrise: '#D97904',
        'sunrise-soft': '#FBE7CE',
        coral: '#D96248',
        'coral-soft': '#F7E1DB',
        pink: '#F2DFD8',
        confirmed: '#1B1717',
        'confirmed-soft': '#F0ECEA',
        // Semantic aliases used across the app for status/severity —
        // mapped onto the brand palette rather than introducing a
        // separate green/red system the brand spec doesn't include.
        critical: '#D96248',
        warn: '#D97904',
        good: '#1B1717',
        'good-soft': '#F0ECEA'
      },
      fontFamily: {
        display: ['"Playfair Display"', 'Georgia', 'serif'],
        body: ['Lato', 'system-ui', 'sans-serif'],
        sans: ['Lato', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
};

export default config;
