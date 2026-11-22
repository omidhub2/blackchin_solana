import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#050810',
          900: '#070c18',
          850: '#0a1120',
          800: '#0d1526',
          700: '#111c33',
          600: '#17233d'
        },
        electric: {
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7'
        },
        cyan: {
          400: '#22d3ee',
          500: '#06b6d4'
        },
        violet: {
          400: '#a78bfa',
          500: '#8b5cf6'
        }
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Tahoma',
          'sans-serif'
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(56,189,248,0.12), 0 18px 60px -24px rgba(14,165,233,0.45)',
        panel: '0 24px 80px -40px rgba(0,0,0,0.9)'
      },
      backgroundImage: {
        'grid-fade':
          'radial-gradient(circle at 20% 0%, rgba(56,189,248,0.12), transparent 45%), radial-gradient(circle at 80% 10%, rgba(139,92,246,0.10), transparent 40%)'
      },
      keyframes: {
        pulseSoft: {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        }
      },
      animation: {
        'pulse-soft': 'pulseSoft 2.4s ease-in-out infinite',
        shimmer: 'shimmer 1.8s linear infinite'
      }
    }
  },
  plugins: []
};

export default config;