# Local API

The web and API servers are separate listeners over the same handler in local development. Browser: `http://127.0.0.1:8312`; API: `http://127.0.0.1:8412`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | service and data-mode check |
| GET | `/api/options` | configured Nansen chains and market-cap universes available to the create form |
| POST | `/api/funds` | create a virtual fund; body: `initialCash`, `preset`, `chain` (`multi` or one configured chain), and `assetUniverse` (`min:max`, for example `40:250`; legacy aliases are accepted) |
| GET | `/api/funds/:id` | fund, portfolio, latest observation, and journal |
| POST | `/api/funds/:id/evaluate` | queue one bounded evaluation |
| GET | `/api/jobs/:id` | actual persisted stage and progress |
| GET | `/api/funds/:id/decisions` | decision list |
| GET | `/api/decisions/:id` | decision plus evidence IDs/data |
| POST | `/api/decisions/:id/replay` | read-only deterministic recorded replay |
| GET | `/api/admin/usage` | provider call/credit ledger; no secrets |

Evaluation stages are `COLLECTING`, `VALIDATING`, `SCORING`, `TARGETING`, `PAPER_REBALANCING`, `JOURNALED`, and `MONITORING`. A failed stage records an error and does not silently apply a partial decision.
