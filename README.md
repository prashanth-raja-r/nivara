# Nivara

Nivara is a personal finance and loan-freedom planner. It combines every loan into one actionable payoff plan, projects the impact of a bonus or extra EMI, and gives you a motivating, trackable path to zero debt.

## Run locally

1. Create a PostgreSQL database named `nivara`, then copy `.env.example` to `.env`.
2. Run `npm install`, `npm run db:generate`, `npm run db:migrate`, then `npm run dev`.
3. Open `http://localhost:5173`.

The dashboard uses a thoughtful demo plan until the API is connected to user-created records. Prisma models and REST endpoints are included for local persistence.
