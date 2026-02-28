# Solar Dashboard App

A mobile-first, dark-friendly dashboard for monitoring solar energy production and consumption.

## Features

- **Live Metrics**: Real-time display of PV generation, load, grid import/export (updates every 5s)
- **Status Indicator**: Shows Exporting/Importing/Neutral state
- **24-Hour Chart**: Visual history of energy flows
- **Daily Summary**: Today's energy totals and cost calculations
- **Mock/Real API Toggle**: Switch between mock data and real API endpoints

## Getting Started

```bash
cd apps/dashboard
npm install
npm run dev
```

The app will be available at `http://localhost:5173`

## Mock vs Real API Mode

By default, the app runs in **MOCK mode** using embedded test data.

To switch to **REAL API mode**:

1. Open `src/api/client.ts`
2. Change `export const USE_MOCK = true` to `export const USE_MOCK = false`
3. Ensure your backend server is running (apps/server)
4. Reload the app

### API Endpoints (Real Mode)

When `USE_MOCK = false`, the app expects these same-origin endpoints:

- `GET /api/live` - Current power metrics
- `GET /api/history?from=<ISO>&to=<ISO>` - Historical time series
- `GET /api/daily?from=<ISO>&to=<ISO>` - Daily summary statistics

## Development

```bash
npm run dev      # Start dev server
npm run build    # Build for production
npm run preview  # Preview production build
npm run lint     # Run ESLint
```

## Tech Stack

- **Vite** - Build tool and dev server
- **React 18** - UI framework
- **TypeScript** - Type safety
- **Recharts** - Chart visualization
- **Tailwind CSS** - Styling
- **date-fns** - Date utilities

## Architecture

```
src/
├── api/
│   ├── client.ts      # API client with mock/real toggle
│   └── mock.ts        # Mock data providers
├── components/
│   ├── MetricCard.tsx
│   ├── StatusBadge.tsx
│   └── HistoryChart.tsx
├── pages/
│   └── Dashboard.tsx  # Main dashboard page
├── types.ts           # TypeScript definitions
├── App.tsx            # Root component
└── main.tsx           # Entry point
```
