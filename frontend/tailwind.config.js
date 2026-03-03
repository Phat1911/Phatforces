/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        'photcot': {
          red: '#FE2C55',
          dark: '#161823',
          card: '#1F2030',
          border: '#2D2F3E',
        }
      }
    },
  },
  plugins: [],
};
