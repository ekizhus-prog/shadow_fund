# Shadow Fund policy v1.3

The policy is intentionally deterministic. The input is a frozen observation bundle; the output is a proposed target and bounded paper order set. No LLM output can change a weight, quote, or accounting fact.

## Source eligibility and score

The scoring period ends at the previous completed UTC day and contains three non-overlapping 30-day windows. A candidate is eligible only when all windows and the complete per-token balance breakdown are available, sales/outflows are at least 10, traded tokens are at least 2, and aggregate realized PnL is positive. The lower breadth floor is deliberate for a bounded multi-chain scan: it makes the first live run useful without removing the stronger consistency, profitability, and balance checks.

```text
consistency = profitable_windows / 3
return_component = percentile_rank(median(window_realized_ROI), eligible_cohort)
breadth = min(median(window_traded_token_count) / 3, 1)
source_score = 50*consistency + 30*return_component + 20*breadth
```

There is no synthetic drawdown, confidence, early-entry skill, or common-owner inference. If the cohort is too small for a percentile rank, the return component is zero rather than fabricated.

## Evidence lanes

The portfolio decision records separate Nansen lanes instead of treating one number as “the signal”:

- Token Screener supplies the bounded token universe, volume context, quote, and liquidity gate.
- Who Bought / Sold supplies observed buyer counts and buy/sell activity.
- Profiler PnL Summary supplies the three scoring windows.
- Profiler Current Balance supplies the exposure denominator; incomplete coverage excludes allocation.
- TGM DEX Trades supplies executed legs and direction for deduplication and purchase interpretation.
- Flow Intelligence supplies token flow context.
- Related Wallets supports a conservative correlation review and grouping cap.
- Smart Money Netflow supplies aggregated corroborating flow context. Premium leaderboard classification is not exposed as a separate claim.

Volume, buyer counts, and flow are shown as corroborating evidence and coverage context. They do not silently become an arbitrary weight. The target driver is eligible source exposure, with selected sources normalized inside the risk sleeve so the 15% evidence attribution cap does not turn unassigned influence into accidental cash. Preset caps and the liquidity rule are then applied.

## Allocation

Selected source influence is proportional to positive `score - 40`, capped at 15% per source. Unassigned influence stays out of the portfolio. Each eligible source's observed balance on its selected chain is the denominator; a missing denominator excludes that source from token allocation.

```text
risky_fraction_s,t = observed_fraction_s,t / sum(observed_fraction_s,r for usable non-stablecoin tokens r)
risk_sleeve_weight_s = source_influence_s / sum(source_influence for selected sources with usable risky exposure)
raw_target_t = sum(risk_sleeve_weight_s * risky_fraction_s,t)
target_t = min((1 - cash_floor) * raw_target_t, token_cap)
cash_weight = 1 - sum(target_t)
```

Presets are Conservative (at least 50% cash / 25% token cap / 10% turnover), Balanced (at least 25% / 35% / 15%), and Risky (0% floor / 50% token cap / 25%). Stablecoins including USDC, USDT, DAI, and the listed USD stablecoin variants are cash-like liquidity: they can explain the reserve, but they never become risky token targets. The implementation also applies a $250,000 liquidity floor, a 0.5% observed-liquidity trade cap, a 3-point rebalance threshold, and a five-token limit.

The live adapter scans either one configured Nansen chain or the configured multi-chain scope through Token Screener. The user selects a sliding market-cap rank range from 1–250, such as 40–250. Token Screener orders the returned rows by `market_cap_usd`; the adapter filters the requested range locally, and every returned token remains in the full analyzed universe. The run credit plan prioritizes Flow Intelligence across the returned universe as far as the configured budget allows, calls Smart Money Netflow as a live corroborating lane, then spends the remaining allowance on deeper buyer and DEX lanes; exact coverage counts are recorded rather than hidden. The final policy still creates at most five targets; full-range analysis is not the same as buying every analyzed token. Wallet profiling remains separately bounded because it is a different evidence dimension. This keeps the portfolio understandable while making the analysis universe honest; the UI records the selected chains, range, analyzed token count, collection duration, lane budget, and lane coverage.

The credit planner reserves a small Buyer/Sold + DEX deep-token slice before spending the remaining allowance on Flow Intelligence. A buyer address can then activate the bounded Current Balance, Related Wallets, and three PnL-window profiler lanes. If the provider returns no address, those profiler lanes stay explicitly marked not used; the system never invents wallet evidence to make the lane list look complete.

When several chains are selected, Balanced caps any one chain at 45% of NAV, so a multi-chain result cannot silently become an Ethereum-only portfolio. Conservative uses a 50% chain cap and Risky a 60% chain cap. When the user selects one chain, that chain can use the preset's full risk sleeve; applying a multi-chain cap to a single-chain research scope would create unnecessary cash. A chain is only represented when the required quote, balance, and wallet evidence is actually present; the policy never invents a cross-chain position to make the chart look diversified.

When strict wallet evidence covers fewer than two risky assets at the cutoff, the policy uses a labeled market-evidence fallback. It ranks non-stablecoin Token Screener candidates with volume, liquidity, buyer activity, and positive Flow Intelligence, then equal-weights the selected cross-chain sleeve under the same token, chain, liquidity, and cash rules. The UI and journal call this a research suggestion; it is not presented as profitable-wallet evidence.

## Fill and replay

The first valid observation quote acquired after the decision is used. Buy slippage is +0.3%, sell slippage is -0.3%, and the modeled fee is 0.1%. A stale quote cannot fill. Sells are applied before buys, a negative cash balance is never allowed, and all fills plus cash entries are written in one transaction.

Recorded replay recomputes the target from the stored observation bundle and reports whether it matches the original target. It is read-only and does not post fills.
