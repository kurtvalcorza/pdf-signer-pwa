import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Document-centric neutral surface; controls recede.
        stage: '#3a3a3c',
        sheet: '#1c1c1e',
      },
    },
  },
  plugins: [],
} satisfies Config;
