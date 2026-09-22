# Shadow Fund

Shadow Fund is an evidence-backed paper portfolio decision engine. It observes a bounded wallet cohort in a user-selected Nansen chain scope, screens a user-selected market-cap universe, constructs a capped suggested allocation, and records every paper rebalance with its inputs, modeled costs, and explanation.

The MVP is deliberately paper-only: no deposits, signing keys, external orders, or customer funds. The default `synthetic` mode makes the full loop reproducible without a provider key. Synthetic observations are visibly labeled in the UI and are not investment performance.

## Run in ten minutes

Requires Node 24 LTS or newer. Node 24's built-in SQLite is used so the local demo has no native dependency install step.

```powershell
npm run doctor
npm run db:migrate
npm run dev
```

Open [http://127.0.0.1:8312](http://127.0.0.1:8312). Choose a chain scope, a sliding market-cap rank range from 1–250, and a risk preset. The browser then creates a `$100,000` paper fund, evaluates the first bundle, and records the result. Use `/?new=1` or **New paper fund** to clear the previous browser selection without deleting its append-only journal. The API is also served at [http://127.0.0.1:8412](http://127.0.0.1:8412).

Useful commands:

```powershell
npm test
npm run typecheck
npm run build
npm run worker
npm run usage:export
```

`npm run worker` evaluates all ready/monitoring funds once and then polls every six hours. Set `WORKER_ONCE=true` for a one-shot worker run.

## Operating modes

`.env.example` is the safe default:

```text
DATA_MODE=synthetic
DATABASE_PATH=./data/shadow-fund.sqlite
APP_PORT=8312
API_PORT=8412
```

The Nansen client is server-side and sends the `apiKey` header only when explicitly configured. `DATA_MODE=live` uses the bounded adapter across Token Screener, Smart Money Netflow, Who Bought / Sold, Profiler PnL Summary, Current Balance, DEX Trades, Flow Intelligence, and Related Wallets. Premium leaderboard classification is not exposed as a separate claim. Live responses are schema-checked and recorded with request hashes, coverage, and credit usage; an unverified response pauses the evaluation instead of becoming plausible filler.

For a short local demo, `NANSEN_DEMO_FULL_LANES=true` gives every selected token lane full coverage when the selected universe contains 20 or fewer tokens. The deployment-safe default remains `false`, so larger production scans use the bounded credit planner.

## Policy and accounting

- Three consecutive non-overlapping 30-day windows are required.
- Eligibility requires complete windows, at least 10 reported sales/outflows, at least 2 observed traded tokens, positive aggregate realized PnL, and a complete balance denominator. This v1.3 breadth floor is intentionally suitable for a bounded multi-chain scan while retaining the stronger time-consistency, profitability, and balance checks.
- Source score is `50*consistency + 30*cohort percentile of median ROI + 20*breadth`.
- A source has at most 15% evidence influence. Eligible sources are normalized inside the risk sleeve so that cap does not accidentally leave almost all capital idle. Conservative keeps at least 50% cash, Balanced at least 25%, and Risky has a 0% cash floor; token caps are 25% / 35% / 50% respectively.
- USDC, USDT, DAI, and listed stablecoin variants are treated as cash-like liquidity rather than risky token targets.
- If strict wallet evidence covers fewer than two risky assets at the cutoff, the UI uses a clearly labeled multi-chain market-evidence fallback ranked from Token Screener, Flow Intelligence, buyer activity, volume, and liquidity. It is a research suggestion, not a profitable-wallet claim.
- The live fund scans the selected chain scope through Nansen. Token Screener orders the selected market-cap range, so every returned token is analyzed in the full universe. The run credit plan prioritizes Flow Intelligence across as many returned tokens as the budget permits, adds Smart Money Netflow as a live corroborating lane, and reserves at least one Buyer/Sold + DEX deep-token pair when the allowance permits. A returned buyer address then opens the bounded Current Balance, Related Wallets, and three PnL-window profiler lanes; if Nansen returns no address, those lanes remain explicitly marked not used rather than being filled with invented wallet evidence. The evidence card reports the exact lane counts. The final policy still keeps at most five eligible risky assets; analyzing all tokens does not mean buying all tokens. Wallet profiling remains separately bounded because it is a different evidence dimension. When several chains are selected, the policy caps any one chain at 45% in Balanced (50% Conservative / 60% Risky); a single selected chain can use the preset's full risk sleeve. Missing, stale, or illiquid quotes become an explicit unavailable reason, not an invented price.
- The UI separates policy target weight, target dollar amount, reference token price, current paper holding, and actual paper fill. Clicking a target shows its source contribution and token-level evidence lanes.
- Paper buys use quote +0.3%, sells use quote -0.3%, and both pay a modeled 0.1% fee. Cash entries and position units are reconciled in one SQLite transaction.
- A decision is replayable from its immutable stored observation bundle. Journal records append; corrections create another decision instead of rewriting history.

The complete policy source is in [docs/policy.md](docs/policy.md). The endpoint contract is in [docs/api.md](docs/api.md), and the intended 55-second product demo is in [docs/demo.md](docs/demo.md).

## Repository shape

```text
server/domain/       score, allocation, money, paper ledger
server/agent/        durable evaluation stages and deterministic explanations
server/nansen/       server-side provider client boundary
server/db/           SQLite schema and query helpers
server/fixtures/     clearly synthetic observation bundle
web/                 browser fund creation, trace view, and journal
scripts/             doctor, migration, build, syntax check, usage export
tests/               policy and durable ledger invariants
```

## Safety and limits

This is an educational paper simulation, not financial advice or a validated strategy. It produces a suggested portfolio target from the selected chain scope, market-cap universe, policy, and recorded evidence; it does not execute orders or custody funds. Wallet activity is a partial observation of the selected chain scope, not a wallet's complete wealth or proof of common ownership. A transfer is not automatically a purchase. A few days of paper marks cannot establish outperformance. The UI shows the data mode, selected universe, and cutoff so recorded evidence is not confused with live operation.
