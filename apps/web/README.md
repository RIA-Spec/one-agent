# one agent web

`apps/web` is the web chat interface for one agent, built with Next.js App Router.

## What it includes

- Chat UI and conversation history
- Auth integration via Auth.js
- Tool execution UX for one agent flows
- Database persistence via Drizzle

## Run locally

1. Copy env file and fill required values:

```bash
cp .env.example .env
```

2. Install dependencies and run migrations:

```bash
pnpm install
pnpm db:migrate
```

3. Start development server:

```bash
pnpm dev
```

Then open http://localhost:3000.

## Useful scripts

- `pnpm dev` – start local development server
- `pnpm build` – run DB migration and build app
- `pnpm start` – start production server
- `pnpm lint` – run ultracite checks
- `pnpm test` – run Playwright tests
