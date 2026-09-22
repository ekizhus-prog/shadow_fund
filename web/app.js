const state = { fundId: null, fund: null, decisionDetails: new Map(), pollTimer: null };
const FUND_STORAGE_KEY = 'shadowFundId';
const $ = (selector) => document.querySelector(selector);
const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd = (value) => `$${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const percent = (value) => `${(Number(value || 0) * 100).toFixed(2)}%`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const presetRules = { Conservative: { cash: 50, cap: 25, chain: 50, turnover: 10 }, Balanced: { cash: 25, cap: 35, chain: 45, turnover: 15 }, Risky: { cash: 0, cap: 50, chain: 60, turnover: 25 }, Exploratory: { cash: 0, cap: 50, chain: 60, turnover: 25 } };
const chainNames = { ethereum: 'Ethereum', base: 'Base', solana: 'Solana', arbitrum: 'Arbitrum', bnb: 'BNB' };
const chainLabel = (chain) => chainNames[String(chain || '').toLowerCase()] || String(chain || 'Unknown');
const assetUniverseLabel = (value) => {
  const legacy = { top50: [1, 50], rank51_100: [51, 100], top100: [1, 100] }[String(value || '').toLowerCase()];
  const match = String(value || '').match(/^(\d+):(\d+)$/);
  const min = legacy?.[0] ?? Number(match?.[1] || 1);
  const max = legacy?.[1] ?? Number(match?.[2] || 50);
  return `Market-cap ranks ${Math.min(min, max)}–${Math.max(min, max)}`;
};
const tokenLabel = (token, chain) => chain ? `${chainLabel(chain)} · ${token}` : String(token || '').split(':').map((part, index) => index === 0 ? chainLabel(part) : part).join(' · ');
const targetLabel = (target) => tokenLabel(target.symbol || target.token, target.chain);
function formatCoverage(observation) {
  try {
    const coverage = JSON.parse(observation.coverage);
    const laneText = coverage.laneErrors?.length ? `${coverage.laneErrors.length} lane issue${coverage.laneErrors.length === 1 ? '' : 's'}` : 'all requested lanes responded';
    const timing = Number.isFinite(Number(coverage.collectionMs)) ? ` · collected in ${(Number(coverage.collectionMs) / 1000).toFixed(1)}s` : '';
    const chainText = coverage.screenedChains?.length ? ` · ${coverage.screenedChains.map(chainLabel).join(', ')}` : '';
    const tokenText = coverage.cachedTokenUniverse ? 'cached token universe' : `${coverage.analyzedTokens ?? coverage.screenedTokens} analyzed tokens`;
    const laneTokenText = coverage.flowAnalyzedTokens !== undefined ? ` · Flow ${coverage.flowAnalyzedTokens} · deep token lanes ${coverage.deepAnalyzedTokens}` : '';
    const profilerText = coverage.profilerWalletLimit !== undefined ? ` · profiler budget ${coverage.profilerWalletLimit} wallet${coverage.profilerWalletLimit === 1 ? '' : 's'}` : '';
    const cacheText = coverage.cachedTokenUniverse ? ` · cache cycle ${coverage.cacheCycle}` : '';
    const universeText = coverage.assetUniverseLabel ? ` · ${coverage.assetUniverseLabel}` : '';
    return `${coverage.discoveredWallets} wallets · ${tokenText}${laneTokenText}${profilerText} · ${coverage.windows} windows${chainText}${cacheText}${universeText} · ${laneText}${timing}`;
  } catch {
    return observation.coverage || 'Coverage recorded';
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.add('hidden'), 4200);
}

function renderFund(snapshot) {
  state.fund = snapshot;
  const portfolio = snapshot.portfolio;
  $('#create-panel').classList.add('hidden'); $('#fund-panel').classList.remove('hidden');
  $('#mode-pill').textContent = snapshot.dataMode === 'synthetic' ? 'Synthetic recorded mode' : 'Live provider mode';
  $('#fund-title').textContent = `${snapshot.chain === 'multi' ? 'Multi-chain' : chainLabel(snapshot.chain)} / ${snapshot.preset}`;
  $('#fund-subtitle').textContent = `${snapshot.id} · ${snapshot.dataMode === 'synthetic' ? 'Synthetic recorded mode' : 'Live provider mode'} · ${assetUniverseLabel(snapshot.assetUniverse)} · policy ${snapshot.policyVersion}`;
  $('#status-pill').textContent = snapshot.status;
  $('#nav-value').textContent = money(portfolio?.navCents);
  $('#cash-value').textContent = money(portfolio?.cashCents);
  $('#return-value').textContent = `${percent(portfolio?.netReturn)} since inception`;
  $('#cycle-value').textContent = `Actual paper ledger · Cycle ${portfolio?.cycle || 0}`;
  $('#policy-value').textContent = snapshot.preset;
  $('#policy-version').textContent = `${snapshot.policyVersion} deterministic policy`;
  $('#cutoff-value').textContent = snapshot.latestObservation ? new Date(snapshot.latestObservation.event_cutoff).toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '—';
  $('#coverage-value').textContent = snapshot.latestObservation ? `${formatCoverage(snapshot.latestObservation)} · ${snapshot.latestObservation.mode}` : 'No observation yet';
  $('#observation-badge').textContent = snapshot.latestObservation ? `${snapshot.latestObservation.mode} · hash ${snapshot.latestObservation.source_hash.slice(0, 10)}` : 'Awaiting collection';
  const latestDecision = snapshot.decisions?.[0];
  renderSuggestedAllocation(latestDecision, portfolio);
  renderEvidence(snapshot, latestDecision);
  renderPositions(portfolio?.positions || [], latestDecision); renderJournal(snapshot.decisions || []);
  refreshUsage();
}

function renderSuggestedAllocation(decision, portfolio) {
  if (!decision) {
    $('#allocation-label').textContent = 'Run evaluation to calculate';
    $('#allocation-content').innerHTML = '<div class="empty-state">The fund starts at 100% virtual cash. Run the evaluation to calculate which tokens, if any, receive a target weight.</div>';
    return;
  }
  const targets = (decision.target.targets || []).filter((target) => Number(target.targetWeight) > 0);
  const cashWeight = Number(decision.target.cashWeight || 0);
  $('#allocation-label').textContent = `${decision.target.preset} target · ${targets.length} token${targets.length === 1 ? '' : 's'} + cash · ${decision.target.assetUniverseLabel || 'Top 50 by market cap'}`;
  if (!targets.length) {
    const rules = decision.target.selectionRules || { windows: 3, windowDays: 30, minimumSales: 10, minimumTradedTokens: 3 };
    const status = decision.target.marketEvidenceStatus;
    const message = status === 'NO_MARKET_DATA'
      ? 'No usable market universe was returned by the Nansen provider in this run. A new paper fund does not need an initial portfolio or existing holdings; retrying the evaluation is the correct next step.'
      : status === 'INSUFFICIENT_MARKET_UNIVERSE'
        ? 'The selected market-cap range returned fewer than two liquid non-stable candidates. Widen the rank range or choose another chain; this is not an initial-portfolio requirement.'
        : status === 'BLOCKED_INCOMPLETE_BALANCE'
          ? 'Wallet evidence was incomplete, so it was not converted into risk. The market-evidence fallback was disabled for this incomplete wallet bundle.'
          : `The wallet evidence gate requires ${rules.windows} complete ${rules.windowDays}-day windows, at least ${rules.minimumSales} sales, at least ${rules.minimumTradedTokens} traded tokens, positive realized PnL, and a complete balance denominator.`;
    $('#allocation-content').innerHTML = `<div class="empty-state"><strong>100% virtual cash.</strong> ${message} This is a paper-policy result, not investment advice.</div>`;
    return;
  }
  const navCents = Number(portfolio?.navCents || 0);
  $('#allocation-content').innerHTML = `<div class="allocation-grid">${targets.map((target) => `<button class="allocation-item target-card" data-target-token="${esc(target.token)}"><div><strong>${esc(targetLabel(target))}</strong><span>Click for reasoning</span></div><div class="allocation-number"><b>${percent(target.targetWeight)}</b><small>${money(navCents * target.targetWeight)} target amount</small></div></button>`).join('')}<button class="allocation-item allocation-cash target-card" data-target-token="__CASH__"><div><strong>Cash reserve</strong><span>Click to see why it is held</span></div><div class="allocation-number"><b>${percent(cashWeight)}</b><small>${money(navCents * cashWeight)} target amount</small></div></button></div><p class="allocation-foot">Percentages are portfolio weights. Dollar targets are allocation amounts. The quoted token price is shown only inside the reasoning card, and is not the target itself.</p>`;
  document.querySelectorAll('[data-target-token]').forEach((card) => card.addEventListener('click', () => showAllocationDetails(card.dataset.targetToken)));
}

function laneLabel(decision, key) {
  return (decision?.target?.dataLanes || []).find((lane) => lane.key === key)?.label || key;
}

function formatLaneMetrics(values) {
  if (!values) return 'No token-specific metric in this bundle.';
  return Object.entries(values).map(([key, value]) => `${esc(key.replaceAll(/([A-Z])/g, ' $1').toLowerCase())}: <b>${typeof value === 'number' && key.toLowerCase().includes('usd') ? usd(value) : esc(value)}</b>`).join(' · ');
}

async function showAllocationDetails(token) {
  const decision = state.fund?.decisions?.[0]; if (!decision) return;
  const detail = $('#allocation-detail'); detail.classList.remove('hidden');
  const fullDecision = state.decisionDetails.get(decision.id) || await api(`/api/decisions/${decision.id}`); state.decisionDetails.set(decision.id, fullDecision);
  if (token === '__CASH__') {
    detail.innerHTML = `<h3>Why is the cash reserve ${percent(fullDecision.target.cashWeight)}?</h3><p class="detail-lead">This is a policy result, not a prediction that the market will correct. The fund keeps cash because the selected preset sets a floor and the available evidence did not justify filling the rest.</p><ul>${(fullDecision.target.cashReasons || []).map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul><div class="detail-foot">Shadow Fund does not invent a “market is too high” reason. A future, verified market-risk lane would need its own documented rule before it could change this reserve.</div>`;
    return;
  }
  const target = (fullDecision.target.targets || []).find((item) => item.token === token); if (!target) return;
  const navCents = Number(state.fund.portfolio?.navCents || 0); const targetAmount = navCents * target.targetWeight; const price = Number(target.quote?.priceCents || 0); const approximateUnits = price ? (targetAmount / price) : 0;
  const laneRows = Object.entries(target.evidence?.lanes || {}).map(([key, values]) => `<div class="lane-metric"><strong>${esc(laneLabel(fullDecision, key))}</strong><span>${formatLaneMetrics(values)}</span></div>`).join('');
  const sourceCount = target.evidence?.observedSourceCount || 0;
  const sourceRows = (target.evidence?.sourceBreakdown || []).map((source) => `<li>${esc(source.source)}: ${percent(source.observedExposure)} of the full balance, ${percent(source.riskySleeveExposure)} of its risky sleeve, ${percent(source.allocationWeight)} of the normalized risk sleeve, ${percent(source.influence)} capped evidence influence</li>`).join('');
  const methodNote = target.evidence?.marketFallback ? 'This card is a market-evidence research suggestion from the selected chain scope because the wallet cohort did not cover two risky assets. It is not a profitable-wallet claim.' : 'This card uses qualifying wallet evidence.';
  detail.innerHTML = `<h3>${esc(targetLabel(target))}: what the target means</h3><p class="detail-lead">The policy suggests allocating <b>${money(targetAmount)}</b>, which is <b>${percent(target.targetWeight)} of the portfolio NAV</b>. That is an allocation amount, not the token price. The reference price is <b>${money(price)} per ${esc(target.symbol || token)}</b>, or approximately <b>${approximateUnits.toLocaleString(undefined, { maximumFractionDigits: 2 })} units</b> at the target amount.</p><div class="reason-columns"><div><span class="metric-label">Why it is included</span><ul>${(target.evidence?.reasons || []).map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul></div><div><span class="metric-label">Source contribution</span><ul><li>${sourceCount} eligible source wallet${sourceCount === 1 ? ' shows' : 's show'} this token</li><li>${percent(target.evidence?.riskSleeveWeight || 0)} of the normalized risk sleeve reaches this token</li><li>${percent(target.evidence?.sourceInfluence || 0)} combined capped evidence influence reaches this token</li><li>${percent(target.evidence?.weightedObservedExposure || 0)} weighted observed exposure before preset caps</li>${sourceRows}</ul></div></div>${laneRows ? `<div class="lane-detail"><span class="metric-label">Token evidence lanes</span>${laneRows}</div>` : ''}<div class="detail-foot">${methodNote} Stablecoins such as USDC and USDT are treated as cash-like liquidity, not risky targets. This is not investment advice, a return forecast, or a claim that the token will appreciate.</div>`;
}

function renderEvidence(snapshot, decision) {
  const rules = presetRules[snapshot.preset] || presetRules.Balanced;
  const chainRule = decision?.target?.selectionRules?.chainCapNote || `Multi-chain scope caps each chain at ${rules.chain}%.`;
  $('#constraint-copy').textContent = `${snapshot.preset}: keep at least ${rules.cash}% cash, cap each risky token at ${rules.cap}%, ${chainRule} Cap each rebalance at ${rules.turnover}% of NAV. USDC, USDT, and listed stablecoins are cash-like, not risky targets. Buys and sells stay paper-only.`;
  const selectionRules = decision?.target?.selectionRules || { windows: 3, windowDays: 30, minimumSales: 10, minimumTradedTokens: 3 };
  if (!decision || !snapshot.latestObservation) {
    $('#selection-copy').textContent = `${selectionRules.windows} complete ${selectionRules.windowDays}-day windows are required. A wallet must have positive realized PnL, at least ${selectionRules.minimumSales} reported sales/outflows, at least ${selectionRules.minimumTradedTokens} observed traded tokens, and a complete balance denominator.`;
    $('#data-lanes').innerHTML = '';
    return;
  }
  const selection = decision.target.sourceSelection || {};
  const candidateCount = selection.eligibleCount + (selection.rejected || []).length;
  const mode = snapshot.latestObservation.mode === 'SYNTHETIC' ? 'This run uses the clearly labeled synthetic fixture, so it is demonstration evidence rather than a provider observation.' : 'This run uses the recorded provider observation bundle at the displayed cutoff.';
  const chainText = decision.target.chains?.length ? ` The scan covered ${decision.target.chains.map(chainLabel).join(', ')}.` : '';
  const targetChainText = decision.target.targetChains?.length ? ` Targets span ${decision.target.targetChains.map(chainLabel).join(', ')}.` : '';
  const analyzedTokenCount = Number(decision.target.selectionRules?.analyzedTokenCount || decision.target.selectionRules?.boundedCandidateLimit || 0);
  const flowAnalyzedTokenCount = Number(decision.target.selectionRules?.flowAnalyzedTokenCount || 0);
  const deepAnalyzedTokenCount = Number(decision.target.selectionRules?.deepAnalyzedTokenCount || 0);
  const returnedUniverseCount = Number(decision.target.selectionRules?.universeSize || 0);
  const universeText = decision.target.assetUniverseLabel ? ` The Token Screener universe was ${decision.target.assetUniverseLabel}${returnedUniverseCount ? ` (${returnedUniverseCount} returned rows)` : ''}; ${analyzedTokenCount || 'all returned'} token${analyzedTokenCount === 1 ? '' : 's'} were screened, Flow Intelligence covered ${flowAnalyzedTokenCount || 0}, and deeper buyer/DEX lanes covered ${deepAnalyzedTokenCount || 0} within the run credit plan.` : '';
  const fallbackText = decision.target.marketFallback ? ' Because strict wallet evidence covered fewer than two risky assets, these are clearly labeled market-evidence research targets, not profitable-wallet claims.' : '';
  const noMarketText = decision.target.marketEvidenceStatus === 'NO_MARKET_DATA' ? ' No initial portfolio is required; this run could not create a market suggestion because the provider returned no usable universe.' : '';
  const walletText = `${selection.eligibleCount || 0} of ${candidateCount || 0} bounded wallet candidates passed the wallet-evidence gate. Each needed ${selectionRules.windows} complete ${selectionRules.windowDays}-day windows, ${selectionRules.minimumSales}+ sales, ${selectionRules.minimumTradedTokens}+ traded tokens, positive realized PnL, and complete balances.`;
  const scoreText = candidateCount ? ' Scores then use consistency, cohort-relative median ROI, and traded-token breadth; eligible sources are normalized inside the risk sleeve so the 15% evidence cap does not create accidental idle cash.' : ' No wallet passed into the allocation, so the displayed sleeve is based on Token Screener and market corroboration rather than wallet profitability.';
  $('#selection-copy').textContent = `${walletText}${scoreText}${chainText}${targetChainText}${universeText}${fallbackText}${noMarketText} ${mode}`;
  const lanes = decision.target.dataLanes || [];
  $('#data-lanes').innerHTML = lanes.map((lane) => `<div class="lane-card"><strong>${esc(lane.label)}</strong><span class="lane-status ${lane.status === 'NOT_USED' ? 'lane-not-used' : lane.status === 'UNAVAILABLE' ? 'lane-unavailable' : lane.status === 'CACHED' ? 'lane-cached' : ''}">${esc(String(lane.status || 'UNAVAILABLE').replaceAll('_', ' '))}</span><small>${esc(lane.endpoint)}</small><p>${esc(lane.purpose)}. ${esc(lane.note || '')}</p></div>`).join('');
}

async function refreshUsage() {
  try {
    const usage = await api('/api/admin/usage');
    const mode = state.fund?.dataMode;
    $('#usage-copy').textContent = mode === 'synthetic'
      ? `Synthetic mode: ${usage.credits || 0} provider credits charged for this demo. A live run would separately record endpoint attempts, HTTP results, and charged credits against the ${usage.budget} credit budget.`
      : `${usage.credits || 0} provider credits recorded across ${usage.attempts || 0} API attempts against the ${usage.budget} credit budget. This count never includes synthetic fixture reads.`;
  } catch (error) {
    $('#usage-copy').textContent = 'Usage is unavailable until the API is connected. No provider claim is made without a recorded usage result.';
  }
}

function renderPositions(positions, decision) {
  $('#position-count').textContent = `${positions.length} position${positions.length === 1 ? '' : 's'}`;
  if (!positions.length) { $('#positions').innerHTML = '<div class="empty-state">No non-zero paper positions are held. The fund is retaining virtual cash; see Suggested deployment above for the policy target.</div>'; return; }
  const targetsByToken = new Map((decision?.target?.targets || []).map((target) => [target.token, target]));
  $('#positions').innerHTML = positions.map((position) => { const target = targetsByToken.get(position.token); const label = target ? targetLabel(target) : tokenLabel(position.token); return `<div class="position-row" data-token="${esc(position.token)}"><div class="position-symbol">${esc(label)}<small>${position.units.toLocaleString(undefined, { maximumFractionDigits: 4 })} units</small></div><div class="bar-wrap"><div class="bar-label"><span>Current weight ${percent(position.weight)}</span><span>Policy target ${percent(position.targetWeight)}</span></div><div class="bar"><i style="width:${Math.min(100, Math.max(3, position.weight * 100 * 3))}%"></i></div><div class="position-subline">Held amount ${money(position.valueCents)} · Reference price ${money(position.markCents)} per token</div></div><div class="position-value">${money(position.valueCents)}<small>Click for reasoning</small></div></div>`; }).join('');
  document.querySelectorAll('.position-row').forEach((row) => row.addEventListener('click', () => showPositionTraceReadable(row.dataset.token)));
}

async function showPositionTrace(token) {
  const latest = state.fund?.decisions?.[0]; if (!latest) return;
  const decision = state.decisionDetails.get(latest.id) || await api(`/api/decisions/${latest.id}`); state.decisionDetails.set(latest.id, decision);
  const target = decision.target.targets?.find((item) => item.token === token);
  const selected = decision.target.sourceSelection?.selected || [];
  const rows = selected.map((source) => ({ source: source.label || source.id, contribution: (source.influence || 0) * (source.exposures?.[token] || 0) })).filter((row) => row.contribution > 0).sort((a,b) => b.contribution - a.contribution);
  $('#position-detail').classList.remove('hidden');
  $('#position-detail').innerHTML = `<h3>${esc(token)} · target trace</h3><div class="trace-row"><span>Raw target from observations</span><span>${percent(target?.rawWeight || 0)}</span></div>${rows.length ? rows.map((row) => `<div class="trace-row"><span>${esc(row.source)} × observed exposure</span><span>${percent(row.contribution)}</span></div>`).join('') : '<div class="trace-row"><span>No source contribution in the stored bundle</span><span>0.00%</span></div>'}`;
}

async function showPositionTraceReadable(token) {
  const latest = state.fund?.decisions?.[0]; if (!latest) return;
  const decision = state.decisionDetails.get(latest.id) || await api(`/api/decisions/${latest.id}`); state.decisionDetails.set(latest.id, decision);
  const target = decision.target.targets?.find((item) => item.token === token);
  const position = state.fund.portfolio?.positions?.find((item) => item.token === token);
  if (!target) return;
  $('#position-detail').classList.remove('hidden');
  $('#position-detail').innerHTML = `<h3>${esc(targetLabel(target))}: current holding versus policy target</h3><div class="trace-row"><span>Current paper holding</span><span>${money(position?.valueCents)} · ${percent(position?.weight)}</span></div><div class="trace-row"><span>Policy target amount</span><span>${money((state.fund.portfolio?.navCents || 0) * (target.targetWeight || 0))} · ${percent(target.targetWeight)}</span></div><div class="trace-row"><span>Reference price per token</span><span>${money(position?.markCents || target.quote?.priceCents)}</span></div><div class="trace-row"><span>Raw weighted exposure before caps</span><span>${percent(target.rawWeight)}</span></div><div class="detail-foot">Click the matching card in Suggested deployment for the full evidence-lane explanation. This is a paper suggestion, not investment advice.</div>`;
}

function renderJournal(decisions) {
  if (!decisions.length) { $('#journal').innerHTML = '<div class="empty-state">No decision has been journaled yet. The first evaluation will record its inputs, target, costs, and result.</div>'; return; }
  $('#journal').innerHTML = decisions.map((decision) => `<article class="journal-item"><div class="journal-top"><strong>Cycle ${decision.cycle} · ${decision.status === 'NO_CHANGE' ? 'No Change' : 'Paper Rebalance'}</strong><span class="journal-badge">${esc(decision.mode)}</span></div><p>${esc(decision.explanation)}</p><div class="journal-meta"><span>${new Date(decision.createdAt).toLocaleString()} · ${decision.costs?.fillCount || 0} fills · ${money(decision.costs?.feeCents)} fees</span><button class="replay" data-replay="${esc(decision.id)}">Replay evidence ↗</button></div></article>`).join('');
  document.querySelectorAll('[data-replay]').forEach((button) => button.addEventListener('click', async () => { try { const replay = await api(`/api/decisions/${button.dataset.replay}/replay`, { method:'POST', body:'{}' }); toast(`Recorded replay: ${replay.sameTarget ? 'same target reproduced' : 'target differs; inspect the stored hash'}.`); } catch (error) { toast(error.message); } }));
}

async function pollJob(jobId) {
  $('#job-strip').classList.remove('hidden');
  const job = await api(`/api/jobs/${jobId}`);
  $('#job-progress').style.width = `${job.progress}%`; $('#job-stage').textContent = job.stage; $('#job-message').textContent = job.message;
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED') { clearInterval(state.pollTimer); state.pollTimer = null; if (job.status === 'FAILED') toast(job.error || 'Evaluation failed'); else toast('Decision journaled with reconciled paper accounting.'); const snapshot = await api(`/api/funds/${state.fundId}`); renderFund(snapshot); setTimeout(() => $('#job-strip').classList.add('hidden'), 1100); }
}

async function evaluate() { try { const result = await api(`/api/funds/${state.fundId}/evaluate`, { method:'POST', body:'{}' }); clearInterval(state.pollTimer); const firstJob = await api(`/api/jobs/${result.jobId}`); if (firstJob.status === 'SUCCEEDED' || firstJob.status === 'FAILED') { await pollJob(result.jobId); return; } await pollJob(result.jobId); state.pollTimer = setInterval(() => pollJob(result.jobId).catch((error) => toast(error.message)), 450); } catch (error) { toast(error.message); } }

async function loadOptions() {
  try {
    const options = await api('/api/options');
    $('#chain-input').innerHTML = `<option value="multi">All supported chains</option>${options.chains.map((chain) => `<option value="${esc(chain)}">${esc(chainLabel(chain))}</option>`).join('')}`;
    const range = options.marketCapRange || { min: 1, max: 250, defaultMin: 1, defaultMax: 50 };
    $('#asset-min-input').min = range.min; $('#asset-min-input').max = range.max; $('#asset-min-input').value = range.defaultMin;
    $('#asset-max-input').min = range.min; $('#asset-max-input').max = range.max; $('#asset-max-input').value = range.defaultMax;
    updateAssetRangeReadout();
  } catch {
    // Static options remain available if the API is not ready yet.
  }
}

function updateAssetRangeReadout() {
  const minInput = $('#asset-min-input'); const maxInput = $('#asset-max-input');
  if (!minInput || !maxInput) return;
  if (Number(minInput.value) > Number(maxInput.value)) {
    if (document.activeElement === minInput) maxInput.value = minInput.value;
    else minInput.value = maxInput.value;
  }
  $('#asset-min-value').textContent = minInput.value;
  $('#asset-max-value').textContent = maxInput.value;
}

$('#asset-min-input').addEventListener('input', updateAssetRangeReadout);
$('#asset-max-input').addEventListener('input', updateAssetRangeReadout);
$('#create-form').addEventListener('submit', async (event) => { event.preventDefault(); const button = event.submitter; button.disabled = true; try { const result = await api('/api/funds', { method:'POST', body: JSON.stringify({ initialCash: $('#cash-input').value, preset: $('#preset-input').value, chain: $('#chain-input').value, assetUniverse: `${$('#asset-min-input').value}:${$('#asset-max-input').value}` }) }); state.fundId = result.fundId; localStorage.setItem(FUND_STORAGE_KEY, state.fundId); renderFund(result.snapshot); await evaluate(); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
$('#evaluate-button').addEventListener('click', evaluate);
function startNewFund(event) {
  event?.preventDefault();
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  state.fundId = null;
  state.fund = null;
  state.decisionDetails.clear();
  localStorage.removeItem(FUND_STORAGE_KEY);
  window.location.replace('/?new=1');
}

$('#new-fund-button').addEventListener('click', startNewFund);
document.querySelector('.brand')?.addEventListener('click', startNewFund);
document.querySelector('footer a')?.addEventListener('click', startNewFund);

async function restoreFund() {
  if (new URLSearchParams(window.location.search).get('new') === '1') {
    localStorage.removeItem(FUND_STORAGE_KEY);
    window.history.replaceState({}, '', '/');
    return;
  }
  const fundId = localStorage.getItem(FUND_STORAGE_KEY);
  if (!fundId) return;
  try {
    state.fundId = fundId;
    renderFund(await api(`/api/funds/${encodeURIComponent(fundId)}`));
  } catch {
    localStorage.removeItem(FUND_STORAGE_KEY);
    state.fundId = null;
  }
}

loadOptions();
restoreFund();
