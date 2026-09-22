# AI installation and setup prompt

Use this document when asking an AI coding assistant to install and run Shadow Fund from a fresh checkout.

## Project

Shadow Fund is a Node.js 24 paper-portfolio application. It uses Nansen API evidence in live mode and recorded fixtures in synthetic mode. It never executes trades or holds funds.

## Required dependencies

- Node.js 24 or newer. The application uses Node's built-in `node:sqlite` module.
- npm, included with Node.js.
- Git, for cloning and version control.
- An optional Nansen API key for live mode.
- Docker is optional. The included Dockerfile uses Node 24 and does not require Python, a database server, or a separate frontend build tool.

Do not install Python packages, a separate SQLite server, or frontend frameworks. There are no third-party runtime npm dependencies in `package.json`.

## Fresh installation prompt

```text
You are installing Shadow Fund from a clean repository.

1. Confirm that Node.js is version 24 or newer:
   node --version
   npm --version

2. Install the repository dependencies:
   npm install

3. Create the local environment file:
   copy .env.example .env        # Windows PowerShell
   cp .env.example .env          # macOS/Linux

4. Keep DATA_MODE=synthetic for a no-credential demonstration. For live Nansen data, set:
   DATA_MODE=live
   NANSEN_API_KEY=<the private Nansen API key>
   NANSEN_CHAINS=ethereum,base,solana,arbitrum

5. For a local recording using up to 20 selected market-cap ranks, set:
   NANSEN_DEMO_FULL_LANES=true
   This runs Token Screener, Flow Intelligence, Buyer/Sold, and DEX Trades for every selected token. Wallet profiler lanes run for addresses returned by Buyer/Sold. Never commit `.env` or an API key.

6. Verify the installation:
   npm run doctor
   npm run typecheck
   npm test
   npm run build

7. Start the application:
   npm start

8. Open the web application at http://127.0.0.1:8312.
   The API health endpoint is http://127.0.0.1:8412/healthz.

9. If the application is stopped, do not delete `data/shadow-fund.sqlite` unless the user explicitly wants to erase the local paper ledger. A fresh database is created automatically on first start.
```

## Environment guidance

Use `DATA_MODE=synthetic` for deterministic local tests without provider credits. Use `DATA_MODE=live` only when the Nansen key is valid and the account has enough credits. The deployment-safe setting is `NANSEN_DEMO_FULL_LANES=false`; larger scans use the bounded credit planner.

Important settings:

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATA_MODE` | `synthetic` or `live` evidence source | `synthetic` |
| `NANSEN_API_KEY` | Server-side Nansen credential | empty |
| `NANSEN_CHAINS` | Comma-separated supported chains | `ethereum,base,solana,arbitrum` |
| `NANSEN_DEMO_FULL_LANES` | Full token-lane coverage for selections up to 20 tokens | `false` |
| `NANSEN_RUN_CREDIT_LIMIT` | Maximum planned live credits for bounded scans | `150` |
| `NANSEN_MAX_TOKENS` | Maximum selected tokens in bounded scans | `250` |
| `NANSEN_MAX_WALLETS` | Maximum profiled wallets | `6` |
| `NANSEN_CONCURRENCY` | Concurrent provider requests | `2` |
| `APP_PORT` | Web port | `8312` |
| `API_PORT` | API port | `8412` |

## Docker

```text
docker build -t shadow-fund .
docker run --rm --env-file .env -p 8312:8312 -p 8412:8412 shadow-fund
```

The container stores its paper database inside the container unless a volume is supplied. Do not bake `.env` or API keys into an image.

## Safe AI behavior

- Never print, commit, upload, or place the Nansen API key in client-side code.
- Never add `data/`, `dist/`, `.playwright-cli/`, `.playwright-mcp/`, `node_modules/`, local logs, or temporary files to a commit.
- Run `npm test`, `npm run typecheck`, and `npm run build` after code changes.
- Preserve the paper-only behavior: no wallet signing, order execution, custody, or real-money transfer.
