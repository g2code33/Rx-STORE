/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        rx: {
          // CSS-variable driven so the Live Website Builder can re-theme at runtime
          yellow: 'rgb(var(--rx-yellow, 255 214 0) / <alpha-value>)',
          'yellow-light': 'rgb(var(--rx-yellow-light, 255 224 51) / <alpha-value>)',
          'yellow-dark': 'rgb(var(--rx-yellow-dark, 230 194 0) / <alpha-value>)',
          dark: 'rgb(var(--rx-dark, 15 20 25) / <alpha-value>)',
          'dark-secondary': 'rgb(var(--rx-dark-secondary, 26 35 50) / <alpha-value>)',
          'dark-tertiary': 'rgb(var(--rx-dark-tertiary, 36 48 68) / <alpha-value>)',
          'gray-light': '#F5F7FA',
          'gray-medium': '#8899AA',
          'gray-dark': '#4A5568',
          white: '#FFFFFF',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-in-out',
        'slide-up': 'slideUp 0.5s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'scale-in': 'scaleIn 0.3s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'float': 'float 6s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideDown: {
          '0%': { transform: 'translateY(-10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-20px)' },
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-hero': 'linear-gradient(135deg, #0F1419 0%, #1A2332 50%, #243044 100%)',
      },
      boxShadow: {
        'glow': '0 0 20px rgba(255, 214, 0, 0.3)',
        'glow-lg': '0 0 40px rgba(255, 214, 0, 0.4)',
        'card': '0 4px 20px rgba(0, 0, 0, 0.08)',
        'card-hover': '0 8px 40px rgba(0, 0, 0, 0.12)',
      },
    },
  },
  plugins: [],
};
