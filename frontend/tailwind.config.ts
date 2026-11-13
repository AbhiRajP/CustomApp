import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef8ff',
          100: '#d8f0ff',
          500: '#4f9cf9',
          600: '#2f78f1',
          700: '#275fd3',
        },
      },
      boxShadow: {
        soft: '0 15px 40px rgba(15, 23, 42, 0.12)',
      },
    },
  },
  plugins: [],
};

export default config;
