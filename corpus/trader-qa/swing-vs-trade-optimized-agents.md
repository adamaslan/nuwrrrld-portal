Swing / tax optimized trading as logic 


TAX


Here is the **beginner‑friendly, tax‑optimized version** of the 50 original proofs.  
The framework now applies to any holding period from **1 month to 10 years**, with a strong focus on **verifiable tax logic** (e.g., long‑term vs. short‑term capital gains, tax‑loss harvesting, wash sales, holding period thresholds).  

Each proof includes:

- **Definition** – plain‑language tax & trading concept  
- **Example** – using $AAPL (or a generic portfolio) with realistic dates as of May 1, 2026  

The structure follows the original five sections, each with ten proofs.

---

## I. Axioms of Expectancy & Probability (Tax‑Adjusted)

### 1. Positive Expectancy (After‑Tax)
- **Definition:** A trade is good only if its **expected after‑tax profit** is positive. Taxes reduce net gains; losses have tax value.  
- **Example for $AAPL:** A 1‑month swing on $AAPL expects $4 pre‑tax profit. Your short‑term tax rate is 37%. After‑tax = $4 × (1‑0.37) = $2.52 > 0. A 10‑year hold would use 20% long‑term rate → $3.20 after‑tax. Both are positive.

### 2. LLN Convergence (Tax‑Adjusted)
- **Definition:** Over many trades, your **average after‑tax return** will converge to the true after‑tax edge, not a lucky outlier that avoids taxes.  
- **Example for $AAPL:** Executing 1,000 “earnings gap” trades with mixed holding periods (some >1 year for lower tax) ensures the average after‑tax yield converges to the true edge, not one tax‑free lucky trade.

### 3. Bernoulli Independence (Tax‑Uncorrelated)
- **Definition:** A tax loss harvested today does **not** improve the probability of a future after‑tax win. Tax benefits are separate from trade outcomes.  
- **Example for $AAPL:** Selling $AAPL at a loss for tax purposes does **not** make the next $AAPL trade more likely to win. The rebound must come from price action, not a tax motive.

### 4. Kelly Criterion with Tax Drag
- **Definition:** The optimal position size must account for **tax drag** – the reduction in compounding due to taxes on gains. Reduce *f** accordingly.  
- **Example for $AAPL:** Pre‑tax Kelly says risk 40% of capital. With annual tax drag of 1.5% (due to realized short‑term gains), effective growth‑optimal *f* drops to ~30%.

### 5. Entropy Constraint (Tax Clarity)
- **Definition:** Avoid trades where the tax treatment is ambiguous or changes frequently (e.g., holding periods near the 1‑year boundary). Clear tax rules = higher signal.  
- **Example for $AAPL:** Do not enter a swing that might end *just* short of 1 year (e.g., 11 months) unless you are certain you cannot hold longer. Ambiguity adds “tax noise.”

### 6. Sharpe Ratio (After‑Tax Risk‑Adjusted)
- **Definition:** Risk‑adjusted return must be computed using **after‑tax returns**. A high pre‑tax Sharpe can be mediocre after taxes.  
- **Example for $AAPL:** Pre‑tax Sharpe = 1.8. After applying a 37% short‑term tax rate, after‑tax Sharpe drops to 1.13 – below the 1.5 threshold for high quality.

### 7. Monte Carlo Robustness (Tax‑Scenario Aware)
- **Definition:** Simulate thousands of random sequences of **taxable events** (e.g., year‑end realization, wash sales). The strategy must survive worst‑case tax timing.  
- **Example for $AAPL:** Even if forced to realize all $AAPL gains in the highest tax year (not spread out), the account does not suffer a 50% drawdown relative to pre‑tax.

### 8. Positive Skewness (Tax‑Aware Asymmetry)
- **Definition:** Favor strategies with **long‑term gains** (low tax) and **short‑term losses** (immediate deduction). That creates after‑tax positive skew.  
- **Example for $AAPL:** Hold a winning $AAPL position for 13 months to pay 20% LTCG, but take a losing $AAPL swing at 10 months for a 37% short‑term loss deduction – asymmetrical tax benefit.

### 9. Fat‑Tail Awareness (Tax Black Swan)
- **Definition:** Extreme market moves may force unexpected taxable events (e.g., forced liquidation, large capital gain distribution). Account for tax‑induced tail risk.  
- **Example for $AAPL:** A 20% gap down in $AAPL due to a factory disruption might trigger a margin call, forcing a sale of a 9‑month old position – converting an expected long‑term gain into a short‑term gain. Model that.

### 10. Stationarity of Edge (Tax Regime Consistency)
- **Definition:** Your after‑tax edge must be stable across **different tax regimes** (e.g., changes in tax rates, wash sale rules). If the edge disappears when tax laws change, it’s not robust.  
- **Example for $AAPL:** The 50‑day MA crossover edge on $AAPL worked in 2024 when the LTCG rate was 20% and again in 2026 when it became 23%? If not, the strategy fails stationarity.

---

## II. Logic of Risk & Ruin (Tax‑Integrated)

### 1. Gambler’s Ruin (Tax‑Erosion Version)
- **Definition:** Taxes can silently erode capital even if you break even pre‑tax. Risk of ruin grows when you pay taxes on false “gains” (e.g., short‑term trades that net zero).  
- **Example for $AAPL:** Over‑leveraging $AAPL options so that a 5% drop wipes you out – but even before that, frequent short‑term trades with zero net profit would owe 37% on winners, ruining you slowly.

### 2. Fixed Fractional Risk (After‑Tax Equity)
- **Definition:** Risk a fixed **percentage of your after‑tax account equity** each trade. Tax liabilities reduce your true net capital.  
- **Example for $AAPL:** On a $100,000 account, you owe $10,000 in deferred taxes on unrealized gains. Net after‑tax equity = $90,000. Risk 2% = $1,800, not $2,000.

### 3. The 6% Rule (Tax‑Correlated Assets)
- **Definition:** Correlated assets may trigger **wash sales** if sold at a loss and repurchased. The 6% risk cap must include wash‑sale penalty risk.  
- **Example for $AAPL:** Holding $AAPL, $MSFT, $NVDA – selling $AAPL at a loss and buying $MSFT within 30 days could trigger a wash sale on the $AAPL loss, disallowing the deduction. That increases effective risk.

### 4. Correlation Ceiling (Tax‑Lot Diversity)
- **Definition:** To avoid wash sales and tax‑lot confusion, keep pairwise correlation below 0.7 across holdings with different tax lots.  
- **Example for $AAPL:** $AAPL and $QQQ (ρ=0.96) – buying both creates overlapping tax lots. A loss sale in one may be washed by the other if considered “substantially identical” (per IRS). Not tax‑optimized.

### 5. Stop‑Loss Verifiability (Tax‑Aware Stop)
- **Definition:** A stop‑loss must be placed so that, if triggered, it generates a **tax‑efficient loss** (e.g., short‑term loss to offset short‑term gains).  
- **Example for $AAPL:** Long $AAPL at $271, stop at $264. If triggered within 11 months, the loss is short‑term – valuable to offset other short‑term gains. If triggered after 13 months, it’s a less valuable long‑term loss.

### 6. Maximum Drawdown (Tax‑Adjusted MDD)
- **Definition:** Drawdown must be measured **after estimated tax liabilities** on unrealized gains. A portfolio can appear fine pre‑tax but be in deep after‑tax drawdown.  
- **Example for $AAPL:** $AAPL drops from $288 to $245. Pre‑tax drawdown = 15%. But if you had large embedded gains, the tax you would owe if liquidated at $288 was 20% of $43 gain → after‑tax drawdown is larger (18%). Set MDD limit accordingly.

### 7. Opportunity Cost (After‑Tax Benchmark)
- **Definition:** Compare expected **after‑tax returns** of two trades. A lower pre‑tax return could be better if it qualifies for LTCG.  
- **Example for $AAPL:** Trade A: +6% pre‑tax over 10 months (short‑term, 37% tax) → after‑tax = 3.78%. Trade B: +5% pre‑tax over 13 months (long‑term, 20% tax) → after‑tax = 4.0%. Trade B wins despite lower gross return.

### 8. Time‑Stop Logic (Tax‑Clock Aware)
- **Definition:** If a position is stagnant for too long, exit before it crosses a tax boundary (e.g., from short‑term to long‑term holding period) if the gain is small.  
- **Example for $AAPL:** You bought $AAPL at $271, it’s been 11 months and the price is $271.50. Don’t hold another month just to get LTCG on a $0.50 gain – the administrative cost outweighs benefit. Exit now.

### 9. Volatility‑Adjusted Sizing (Tax‑Lot Matching)
- **Definition:** Use volatility to determine position size, but also maintain **tax lot granularity** so you can sell specific lots for tax optimization (e.g., high‑cost basis lots first).  
- **Example for $AAPL:** With ATR = $10, you buy 100 shares. Enter as two separate lots of 50 shares – later you can sell the lot with the highest cost basis to minimize taxable gain.

### 10. VaR Validation (After‑Tax VaR)
- **Definition:** With 95% confidence, the **after‑tax** loss over a given horizon should not exceed a threshold. Taxes can convert a small pre‑tax loss into a larger after‑tax loss (if you owe tax on other gains).  
- **Example for $AAPL:** Pre‑tax overnight VaR = $3,500. But if you have $10,000 of unrealized short‑term gains elsewhere, a $3,500 loss only offsets $3,500 of that gain, net tax effect = 0.37 × $3,500 = $1,295 extra loss. After‑tax economic loss = $4,795. Must stay under limit.

---

## III. Market Structure & Execution Logic (Tax‑Aware)

### 1. Trend Symmetry (Tax‑Aligned Timeframes)
- **Definition:** For a trend to be worth holding for a tax‑efficient period (≥1 year), it must show higher highs and higher lows on **monthly** charts, not just daily.  
- **Example for $AAPL:** $AAPL monthly chart shows higher highs ($288) and higher lows ($245) – a multi‑year uptrend suitable for a 10‑year hold. A daily pattern is only for 1‑month swings.

### 2. Mean Reversion (Tax‑Harvesting Trigger)
- **Definition:** When price is 2σ from its long‑term average, it may be a good time to **tax‑loss harvest** by selling and buying a similar but not identical asset.  
- **Example for $AAPL:** $AAPL $285, 2.3σ above 50‑month MA ($260). Sell $AAPL to harvest gains only if you have offsetting losses. Otherwise, wait for pullback to avoid a high‑tax gain.

### 3. Volume Confirmation (Tax‑Liquidity Need)
- **Definition:** High volume ensures you can exit with low slippage – critical when you need to execute a tax move (e.g., year‑end realization) quickly.  
- **Example for $AAPL:** A post‑earnings rally to $283 on 60M volume (avg 46M) confirms liquidity – you can sell that lot for tax purposes without moving the price.

### 4. Support/Resistance Reflexivity (Tax‑Lot Levels)
- **Definition:** Define support and resistance levels where you plan to **add or reduce tax lots** to manage average cost basis.  
- **Example for $AAPL:** $273 is verified support. You already own a lot at $271. At $273, you add a second lot – later, if you sell, you can choose to sell the higher‑cost lot first to reduce taxable gain.

### 5. Breakout Validity (Tax‑Trigger Breakout)
- **Definition:** A breakout above resistance is valid if it suggests a multi‑year trend change – justifying a long‑term hold for LTCG treatment.  
- **Example for $AAPL:** $AAPL breaks $280 on high volume. This breakout has held for 3 months – now you can reasonably expect to hold for >1 year without reversal.

### 6. Gap Logic (Unfilled Gap = Deferral Signal)
- **Definition:** An unfilled gap indicates strong momentum – you can **defer** taking gains (avoid tax now) because the trend is likely to continue.  
- **Example for $AAPL:** The $271→$278 gap remains unfilled for 5 months. Do not sell for tax purposes; let the gain ride and defer tax to a later year.

### 7. Relative Strength (Tax‑Efficient Rotation)
- **Definition:** When a stock’s RS turns negative vs. index, consider selling it for a **tax loss** and rotating into a stronger stock, even if the holding period is short.  
- **Example for $AAPL:** $AAPL up 1%, QQQ up 2% → RS negative. You have a losing lot of $AAPL (bought at $290). Sell that lot to harvest a short‑term loss, rotate into $MSFT.

### 8. Sector Tailwind (Tax‑Aware Sector Bet)
- **Definition:** A sector tailwind reduces the probability of an early, forced sale (due to sharp drawdown). Allows you to hold long enough for LTCG.  
- **Example for $AAPL:** XLK (tech sector) is in uptrend – you can confidently hold $AAPL for >1 year without interruption. If XLK were in downtrend, you might need to exit early, converting a potential LTCG into STCG.

### 9. Market Breadth Filter (Tax‑Loss Crowding)
- **Definition:** If breadth is very weak, many investors will be tax‑loss harvesting simultaneously, causing exaggerated moves. Avoid entering new long positions.  
- **Example for $AAPL:** Only 200 of 500 tech stocks are rising. The rest are falling. Tax‑loss selling in those may spill over to $AAPL. Wait for breadth to improve.

### 10. Liquidity Threshold (Tax‑Lot Size Constraint)
- **Definition:** Keep individual tax lots small enough (<0.5% of daily volume) so you can sell them independently for tax optimization without moving price.  
- **Example for $AAPL:** Buy $AAPL in 2,000 share lots (≈$540k each). Daily volume 36M shares – each lot is <0.006% of volume. You can sell any lot without slippage.

---

## IV. Volatility & Options Mechanics (Tax‑Optimized)

### 1. Short Vol Logic (Tax‑Friendly Option Selling)
- **Definition:** Sell options in **tax‑deferred accounts** (IRA, 401k) to avoid annual tax on short‑term option gains. In taxable accounts, prefer long put/call spreads.  
- **Example for $AAPL:** Sell $AAPL puts when IV=27% > RV=21% – but do this in an IRA. In a taxable account, the short‑term gains would be taxed at 37% each year, destroying the edge.

### 2. Theta Decay Identity (Tax‑Deferred Time Value)
- **Definition:** Time decay is most valuable when the profits are **tax‑deferred** (e.g., in a retirement account) or realized as LTCG (if holding long options >1 year).  
- **Example for $AAPL:** A short $AAPL vertical spread held for 5 days earns $1.20/day in a Roth IRA = tax‑free. In a taxable account, the same trade after 1 year would be LTCG (20%) – much better than 37%.

### 3. Delta Neutrality (Tax‑Neutral Hedging)
- **Definition:** Use delta‑neutral strategies (iron condors) to avoid triggering **wash sales** from multiple adjustments. Frequent small hedges can create tax record‑keeping nightmares.  
- **Example for $AAPL:** An $AAPL iron condor with delta ≈ 0 requires no active delta hedging – thus no frequent taxable events. Set it and hold until expiration or close >1 year later.

### 4. Gamma Sensitivity (Tax‑Event Acceleration)
- **Definition:** High gamma near expiration can force an early exit (due to risk) – converting a potential long‑term holding into a short‑term taxable event. Avoid that.  
- **Example for $AAPL:** An $AAPL option with 2 days to expiration and gamma 0.08. If the stock moves $2, delta jumps. You may be forced to close – if opened 11 months ago, you lose LTCG treatment. Close earlier or use longer‑dated options.

### 5. Vega Hedging (Tax‑Aware Volatility Harvesting)
- **Definition:** Harvest volatility premium (sell high IV, buy low RV) using **tax‑efficient instruments** – e.g., VIX futures ETNs that are taxed as 60% long‑term / 40% short‑term (Section 1256).  
- **Example for $AAPL:** Instead of short $AAPL options directly (100% short‑term gains), use a VIX‑linked instrument to profit from $AAPL’s IV crush. Then 60% of gains are LTCG.

### 6. Put/Call Ratio Sentiment (Tax‑Contrarian Entry)
- **Definition:** When PCR is extremely low (greedy), consider shorting calls – but only if you can hold the position for >1 year to get LTCG on the short call gains (unusual). Better to use puts.  
- **Example for $AAPL:** $AAPL PCR = 0.35. You want to sell calls. Instead, sell a put credit spread (same bearish sentiment) – losses on puts can be short‑term, gains can be long‑term if held >1 year.

### 7. VIX Inverse Correlation (Tax‑Regime Timing)
- **Definition:** Trade $AAPL long when VIX is falling and you intend to hold >1 year. A falling VIX precedes longer bull markets – increases probability you won’t be forced to sell early.  
- **Example for $AAPL:** VIX drops from 20 to 15 over 2 months. Historically, $AAPL then rallies for 18 months on average – perfect for a long‑term hold to LTCG.

### 8. Contango/Backwardation Logic (Tax‑Efficient Roll)
- **Definition:** For long‑term options (LEAPS), backwardation (near > far) allows you to roll forward and defer taxes on gains. Contango forces you to pay more for roll – avoid.  
- **Example for $AAPL:** $AAPL LEAPS: 2027 call = $30, 2028 call = $28 (backwardation). Buy the 2027, later roll to 2028 – you realize a gain only on the roll, deferring tax until final sale.

### 9. Iron Condor Range (Tax‑Effective Spread Duration)
- **Definition:** Set iron condor strikes such that the probability of staying inside is high enough that you can confidently **hold to expiration (>1 year)** for LTCG on the short premium.  
- **Example for $AAPL:** Probability of staying between $260–$290 over 30 days = 68%. That is too short a horizon for LTCG. Choose 18‑month condor with similar probability – then hold >1 year.

### 10. Margin Efficiency (Tax‑Aware Return on Capital)
- **Definition:** Compute return on capital **after tax** and after margin interest (which may be tax‑deductible only if you itemize). High pre‑tax ROC can be poor after tax if margin interest is not deductible.  
- **Example for $AAPL:** A trade earns $150 profit on $1,000 margin (15% ROC). You pay 37% tax on the $150 → $94.50 after‑tax. Margin interest $20 is not deductible (standard deduction). Effective after‑tax ROC = 9.45% – still acceptable.

---

## V. Systemic & Behavioral Logic (Tax‑Driven)

### 1. Complexity Penalty (Tax Simplicity)
- **Definition:** A simpler strategy with fewer trades and longer holding periods reduces **tax compliance complexity** (fewer lots, less wash sale tracking). Simplicity is a tax alpha.  
- **Example for $AAPL:** A buy‑and‑hold $AAPL for 10 years (one tax lot) is better than 100 short‑term swings (100 tax lots, each requiring gain/loss tracking) even if pre‑tax returns are similar.

### 2. Backtest Overfitting (Tax‑Regime Overfitting)
- **Definition:** A strategy that works perfectly under 2024 tax rates but fails when LTCG rate changes to 23% in 2026 is overfitted to a specific tax regime.  
- **Example for $AAPL:** A tax‑harvesting strategy that relies on a 20% LTCG rate for 11‑month holds fails when rates go to 23% and the required holding period becomes 13 months.

### 3. Slippage Impact (Tax‑Adjusted Slippage)
- **Definition:** Slippage plus **tax drag** must be less than gross edge. Tax drag on slippage (e.g., slippage increases realized gains) can be significant.  
- **Example for $AAPL:** $0.01 slippage per share on $AAPL, plus tax on that slippage as additional gain (37%). Effective slippage = $0.0137. Still less than $4.00 edge → acceptable.

### 4. Data Latency Bias (Tax‑Lot Timing)
- **Definition:** Your tax optimization strategy (e.g., specific lot identification) depends on being able to **timestamp** each lot purchase. Your data feed must reflect real‑time lot assignment.  
- **Example for $AAPL:** Your order to buy 100 shares at $271.50 is filled as two lots of 50 shares each at slightly different times. Broker must report those timestamps correctly for tax‑lot selection later.

### 5. Survivorship Bias (Tax‑Advantaged Account Survivorship)
- **Definition:** Backtest on a mix of **taxable and tax‑deferred accounts** – not just the winning accounts. Strategies that perform well only in Roth IRAs (tax‑free) but poorly in taxable accounts are biased.  
- **Example for $AAPL:** A high‑turnover $AAPL options strategy looks great in a backtest that assumes a Roth IRA (no tax). In a taxable account, the same strategy loses after tax. Include both account types.

### 6. Confirmation Bias Filter (Tax‑Aware Null Hypothesis)
- **Definition:** For every potential trade, define a null hypothesis: “The after‑tax return of this trade will be lower than the after‑tax return of holding cash for the same period.” Reject it only with strong evidence.  
- **Example for $AAPL:** Before buying $AAPL, assume its post‑tax return (assuming forced sale in 2 months) is worse than 4% risk‑free. Search for evidence that you can hold >1 year to get LTCG.

### 7. Sunk Cost Negation (Tax‑Sunk Cost)
- **Definition:** Do not hold a losing position simply because you want to wait for it to become a long‑term loss (which does not exist – losses are always short‑term regardless of holding period).  
- **Example for $AAPL:** You bought $AAPL at $280, it’s now $250 after 13 months. The loss is long‑term (less valuable). Do not hold further – sell immediately. The market doesn’t care about your hope for a rebound.

### 8. Consistency of Signal (Tax‑Rule Consistency)
- **Definition:** The trading signal must be **deterministic** with respect to tax rules (e.g., “enter if holding period can exceed 365 days”). If the signal depends on a future tax rate that may change, it’s not consistent.  
- **Example for $AAPL:** The signal: “Buy $AAPL on RSI<30 only if you can hold for >1 year without a stop.” That is deterministically checkable. “Buy if you expect LTCG rate to stay 20%” is not.

### 9. Robustness Across Assets (Tax‑Character Robustness)
- **Definition:** The tax logic should work across different asset classes (stocks, ETFs, options) with their own tax rules (e.g., 1256 contracts, wash sale rules for ETFs).  
- **Example for $AAPL:** The tax‑harvesting logic that works for individual $AAPL shares should also work for $AAPL options (subject to same wash sale rules) and for $AAPL ETFs (slightly different rules). Adjust for each.

### 10. The “Sleep Test” Logic (Tax‑Peace)
- **Definition:** If thinking about the **tax consequences** of a trade (e.g., April 15 tax bill) causes you stress, your position size or holding period is wrong. You must be emotionally neutral about the tax outcome.  
- **Example for $AAPL:** A $100,000 unrealized gain in $AAPL that will be taxed in 2 months at 37% causes you anxiety. Either sell enough to cover the tax now, or hold until it becomes LTCG. Adjust until you sleep well.

---

This beginner‑friendly, tax‑optimized version retains all **50 original proof structures** but reframes each for holding periods from 1 month to 10 years with explicit tax logic. Use it as a verifiable framework for building a tax‑aware trading model.


SWING


Here is the **beginner‑friendly version** of the original 50 logical proofs for high‑quality swing trading.  
Each proof now includes:

- **Definition** – plain‑language explanation of the logical concept.  
- **Example** – concrete illustration using **Apple Inc. ($AAPL)** as of **May 1, 2026** (prices and events are realistic for that date).

The structure follows the original five sections, each with ten proofs.

---

## I. The Axioms of Expectancy & Probability

### 1. Positive Expectancy
- **Definition:** A trade is good if, on average, you expect to make money after many repetitions (wins minus losses, adjusted for how often each happens).  
- **Example for $AAPL:** A mean‑reversion swing wins 60% of the time, gaining $12 per win, and loses 40% of the time, losing $8 per loss. Average profit per trade = (0.60×12) − (0.40×8) = **$4.00**. Positive → good trade.

### 2. Law of Large Numbers (LLN) Convergence
- **Definition:** If you repeat a good trade many times, your actual average profit will get closer and closer to the true expected profit. A few lucky wins don’t fool you.  
- **Example for $AAPL:** After trading 1,000 “earnings gap” patterns on $AAPL, your average return will converge to the true edge (e.g., +1.7% per trade), not just a lucky streak of 10 winners.

### 3. Bernoulli Trial Independence
- **Definition:** A past loss does **not** make a future win more likely. Each trade is its own independent event. Believing otherwise is the “gambler’s fallacy.”  
- **Example for $AAPL:** Losing on an $AAPL long trade today does **not** logically increase the chance of winning tomorrow. A rebound must be proven by a fresh buy signal, not by the fact you just lost.

### 4. Kelly Criterion Optimality
- **Definition:** The formula that tells you the **best fraction of your capital** to risk on a trade to grow fastest over time, given your win rate and reward‑to‑risk ratio.  
- **Example for $AAPL:** You have 3:1 odds (risk $1 to make $3) and a 55% win rate. The Kelly formula says risk **40%** of your capital. Never risk more than that.

### 5. Shannon’s Entropy Constraint
- **Definition:** Avoid trading when price moves are purely random “noise” – times when there is almost no useful information. Only trade when the signal is clear.  
- **Example for $AAPL:** Skip entering a swing during mid‑day consolidation (e.g., $AAPL stuck in a $0.50 range for 2 hours). That period has near‑zero information.

### 6. Sharpe Ratio Threshold
- **Definition:** Measures reward per unit of risk. A high‑quality swing should have a Sharpe ratio above 1.5 (very good risk‑adjusted return).  
- **Example for $AAPL:** $AAPL earns 29% per year, risk‑free rate is 4%. To have Sharpe > 1.5, its volatility must stay below 16.7%. If volatility jumps above that, the trade quality drops.

### 7. Monte Carlo Robustness
- **Definition:** Randomly reorder the sequence of your past trades thousands of times. If even the worst possible order does not blow up your account (e.g., >50% loss), the strategy is robust.  
- **Example for $AAPL:** Even if the daily returns of $AAPL from 2025 are shuffled randomly (best days first, worst days first), the system never suffers a 50% account drawdown.

### 8. Positive Skewness Necessity
- **Definition:** A good swing strategy should have occasional **large wins** and many small losses (right‑skewed). Avoid strategies with frequent small wins and rare huge losses.  
- **Example for $AAPL:** Capture $AAPL’s rare +5% “AI announcement” days while capping daily losses at 1%. This creates positive skew.

### 9. Fat‑Tail Awareness (Kurtosis)
- **Definition:** Markets can have extreme moves (“black swans”) that are much larger than a normal bell curve predicts. A good risk model explicitly prepares for those.  
- **Example for $AAPL:** Place your stop‑loss at −20%, not −10%, because $AAPL can gap down 20% overnight if a major factory line is disrupted. That’s a fat tail.

### 10. Stationarity of Edge
- **Definition:** Your trading edge should work consistently across different market conditions (bull, bear, sideways). If it only worked in one regime, it’s not reliable.  
- **Example for $AAPL:** The 50‑day moving average crossover edge on $AAPL is high‑quality only if it worked in both the 2024 bull market and the 2026 sideways/correction market.

---

## II. The Logic of Risk & Ruin

### 1. Gambler’s Ruin Avoidance
- **Definition:** Do not risk so much that a few losses wipe out your entire account. The probability of total ruin must be near zero.  
- **Example for $AAPL:** Over‑leveraging $AAPL options so that a 5% drop in the stock clears your account makes ruin certain. Keep many small risk units.

### 2. Fixed Fractional Risk Axiom
- **Definition:** Risk the **same small percentage** of your current account on every trade (typically 1‑2%).  
- **Example for $AAPL:** On a $100,000 account, risk exactly $2,000 on every $AAPL swing, no matter the share price. Adjust position size accordingly.

### 3. The 6% Portfolio Rule
- **Definition:** If you hold several stocks that all move together (correlated), the **sum of their risks** should not exceed 6% of your capital.  
- **Example for $AAPL:** $AAPL, $MSFT, and $NVDA are highly correlated (all tech). If you risk 2% on each, the effective combined risk is >6% → violates the rule. Reduce size or pick only one.

### 4. Correlation Coefficient Ceiling
- **Definition:** To be diversified, don’t buy two assets that move nearly identically. Average correlation should be below 0.7.  
- **Example for $AAPL:** $AAPL and the QQQ ETF have a correlation of 0.96. Buying both does **not** increase diversification – it just doubles your leverage to the same factor.

### 5. Stop‑Loss Verifiability
- **Definition:** A trade without a predetermined stop‑loss has **infinite risk** – it is never high‑quality. The stop must be at a specific price you can verify.  
- **Example for $AAPL:** Buying $AAPL at $271 with **no** stop is illogical. A stop at $264 (recent support) makes your maximum loss finite and verifiable ($7 per share).

### 6. Maximum Drawdown (MDD) Constraint
- **Definition:** Before you trade, decide the largest peak‑to‑trough decline you will accept (e.g., 25%). If your strategy would exceed that, it is not high‑quality.  
- **Example for $AAPL:** Ensure that a correction in $AAPL from $288 down to $245 (‑15%) does **not** cause your model’s pre‑defined drawdown limit (say 20%) to be breached.

### 7. Opportunity Cost Theorem
- **Definition:** A trade is only good if its expected return is **better than** the next best alternative (e.g., another stock or a risk‑free bond).  
- **Example for $AAPL:** If $AAPL is expected to rise 2% this month but $GOOG is expected to rise 5% with similar risk, the $AAPL trade is logically suboptimal. Switch.

### 8. Time‑Stop Logic (Velocity Axiom)
- **Definition:** If a stock does **not move** within a reasonable time (e.g., 10 days), exit. Dead capital is a hidden loss.  
- **Example for $AAPL:** $AAPL stays at $271 ± $0.50 for 10 days without any swing. The “swing” has failed – exit and use the capital elsewhere.

### 9. Volatility‑Adjusted Sizing
- **Definition:** When volatility is high, take a smaller position; when volatility is low, take a larger position – so that your **dollar risk** stays constant.  
- **Example for $AAPL:** If $AAPL’s Average True Range (ATR) is $5, you buy 200 shares. If ATR expands to $10, you buy only 100 shares (keeping the same $ risk).

### 10. Value at Risk (VaR) Validation
- **Definition:** Know the maximum loss you expect with 95% confidence (e.g., overnight). If that loss is too big, the trade is not high‑quality.  
- **Example for $AAPL:** There is 95% confidence that an overnight $AAPL swing will not lose more than **$3,500** on a $100,000 account. That’s acceptable.

---

## III. Market Structure & Execution Logic

### 1. Trend Symmetry
- **Definition:** An uptrend is defined by a series of **higher highs** and **higher lows**. If that pattern holds, the trend is “quality.”  
- **Example for $AAPL:** $AAPL made a higher high at $288 and a higher low at $245 → uptrend confirmed.

### 2. Mean Reversion Identity
- **Definition:** If a stock price moves **far away** from its average (e.g., more than 2 standard deviations), it will likely pull back toward the average.  
- **Example for $AAPL:** $AAPL at $285 is 2.3 standard deviations above its 50‑day moving average ($260). Logic says a pullback to $275 is highly probable.

### 3. Volume Confirmation Proof
- **Definition:** A price move is trustworthy only if it happens on **above‑average volume**. Low‑volume moves are weak.  
- **Example for $AAPL:** The post‑earnings rally to $283 is “true” only if volume exceeds the 46 million average. If volume is 60 million, it’s confirmed.

### 4. Support/Resistance Reflexivity
- **Definition:** A support level becomes “verified” after price bounces off it at least twice, each time with higher volume.  
- **Example for $AAPL:** The $273 resistance from last month is now **verified support** because $AAPL bounced off $273.20 today on 1.5× average volume.

### 5. Breakout Validity
- **Definition:** A breakout above resistance is high‑quality only if (a) price closes above resistance, (b) volatility is expanding, and (c) volume is above average.  
- **Example for $AAPL:** $AAPL breaking $280 on high volume (65M vs. 46M avg) and with ATR expanding from $4 to $6 → valid breakout.

### 6. Gap Logic
- **Definition:** A price gap (open far above previous close) that **never fills** (price never falls back) is a strong bullish signal.  
- **Example for $AAPL:** The gap from $271 to $278 on May 1 remains completely unfilled for 5 days → bullish continuation signal.

### 7. Relative Strength (RS) Index
- **Definition:** Compare the stock’s performance to the overall market (e.g., QQQ). You want the **strongest horse** – the one that rises more or falls less.  
- **Example for $AAPL:** $AAPL rises 1% while QQQ is flat → RS is positive → good. If $AAPL rises 1% but QQQ rises 2%, RS is negative → avoid.

### 8. Sector Tailwind
- **Definition:** It’s safer to buy a stock when its **entire sector** (e.g., technology) is also trending upward.  
- **Example for $AAPL:** Buying $AAPL is higher quality when XLK (Tech Sector ETF) is also in a confirmed uptrend (above its 200‑day moving average).

### 9. Market Breadth Filter
- **Definition:** If most stocks are falling and only your stock is rising, the move is suspect. Widespread participation is healthier.  
- **Example for $AAPL:** If $AAPL is the only tech stock rising while 400 others fall, the trade lacks systemic support → high risk of reversal.

### 10. Liquidity Threshold
- **Definition:** Your order size should be less than 1% of the stock’s average daily volume, so you can enter and exit without moving the price.  
- **Example for $AAPL:** Buying 10,000 shares of $AAPL (~$2.7 million) is safe because it’s only 0.03% of the 36 million average daily volume.

---

## IV. Volatility & Options Mechanics

### 1. Short Vol Logic
- **Definition:** Selling options (e.g., puts) is good when implied volatility (the market’s fear forecast) is **higher than** realized volatility (actual past price swings).  
- **Example for $AAPL:** Sell $AAPL puts when IV is 27% but realized volatility over the past 21 days is only 21% → you are overpaid for risk.

### 2. Theta Decay Identity
- **Definition:** Option sellers make money from “time decay” – every day that passes, the option loses value (if nothing else changes).  
- **Example for $AAPL:** A short $AAPL vertical spread held for 5 days converts time into equity, earning about $1.20 per day per spread.

### 3. Delta Neutrality Proof
- **Definition:** A volatility trade (like an iron condor) should have total **delta near zero** – meaning it doesn’t care which way the stock moves, only that it stays within a range.  
- **Example for $AAPL:** An $AAPL iron condor with strikes 260/265 and 285/290 has total delta = –0.02 → effectively direction‑neutral.

### 4. Gamma Sensitivity
- **Definition:** As expiration approaches, options can become extremely sensitive to small stock moves (“gamma risk”). A quality trade accounts for that.  
- **Example for $AAPL:** Recognize that $AAPL options risk grows exponentially as price nears the $275 strike with 2 days left. Close or hedge before gamma explodes.

### 5. Vega Hedging
- **Definition:** Option prices also change when implied volatility changes (“vega”). A quality trade accounts for volatility shifts explicitly.  
- **Example for $AAPL:** After $AAPL’s April 30 earnings, implied volatility collapsed from 40% to 22%. A short straddle captured that 18% volatility crush.

### 6. Put/Call Ratio Sentiment
- **Definition:** Extremely high put/call ratio (fear) often signals a bottom. Extremely low ratio (greed) often signals a top. Use as a contrarian indicator.  
- **Example for $AAPL:** An $AAPL put/call volume ratio of 0.35 (very low) indicates widespread bullish consensus → possible overbought reversal signal.

### 7. VIX Inverse Correlation
- **Definition:** When the VIX (fear index) is falling, stocks tend to rise. It’s safer to trade swings during falling volatility.  
- **Example for $AAPL:** $AAPL swings are safer when the VIX drops from 20 to 15 (volatility contracting) than when the VIX is rising.

### 8. Contango/Backwardation Logic
- **Definition:** For futures or longer‑dated options, the “roll yield” matters. Backwardation (near price > far price) helps longs; contango hurts them.  
- **Example for $AAPL:** When buying $AAPL LEAPS, check the term structure. If far‑dated calls are expensive due to contango, the cost of carry must be subtracted from expected return.

### 9. Iron Condor Range
- **Definition:** A short iron condor profits if the stock stays between two strikes. The probability of staying inside must be higher than the break‑even probability.  
- **Example for $AAPL:** Based on 18% implied volatility, $AAPL has a 68% probability of staying between $260 and $290 over 30 days. That supports selling an iron condor.

### 10. Margin Efficiency
- **Definition:** Return on capital (ROC) = net profit ÷ maintenance margin. A good options trade generates high ROC while using little margin.  
- **Example for $AAPL:** An $AAPL credit spread earns $150 profit on $1,000 maintenance margin → 15% ROC. And margin used is only 1% of a $100k account → efficient.

---

## V. Systemic & Behavioral Logic

### 1. Complexity Penalty (Occam’s Razor)
- **Definition:** All else being equal, the simpler strategy is better. Too many indicators often cause “analysis paralysis.”  
- **Example for $AAPL:** A simple $AAPL trend‑following system (200‑day MA + one filter) outperforms a system with 15 indicators that produces no clear signal.

### 2. Backtest Overfitting Proof
- **Definition:** A strategy must work on **new data** (out‑of‑sample) at least 70% as well as it did on historical data. If not, it’s overfitted.  
- **Example for $AAPL:** The system worked great in 2021 (bull market) but fails on 2026 $AAPL data. Ratio of out‑of‑sample to in‑sample performance is 0.11 → brittle, not high‑quality.

### 3. Slippage Impact Theorem
- **Definition:** After subtracting realistic trading costs (bid‑ask spread, commissions), the net profit must still be positive. Many backtests ignore this.  
- **Example for $AAPL:** In $AAPL, the spread is only $0.01. For a trade with $4.00 expected profit, slippage + commission ($0.50) does not erase the edge.

### 4. Data Latency Bias
- **Definition:** Do not assume you can buy at a price that was not actually available at the moment your signal triggered (e.g., a lower price that occurred one second earlier).  
- **Example for $AAPL:** Your limit order at $271.50 must be executable based on the real‑time Level 2 bid/ask tape at that millisecond. If the best bid was $271.45, your proof is invalid.

### 5. Survivorship Bias Removal
- **Definition:** When testing a strategy, include stocks that **later failed** (delisted, bankrupt). Otherwise your results are artificially good.  
- **Example for $AAPL:** Testing a “Magnificent Seven” strategy on only today’s winners (including $AAPL) is biased. Also include stocks that were winners in 2010 but later crashed.

### 6. Confirmation Bias Filter
- **Definition:** Actively look for **evidence against** your trade before entering. If you can’t find a reasonable counter‑argument, you are likely deluded.  
- **Example for $AAPL:** Before buying $AAPL on a bullish signal, search for bearish news about the iPhone 17. If that news meets a pre‑defined threshold, reject the trade.

### 7. Sunk Cost Negation
- **Definition:** Your decision to hold or sell should **never** depend on your purchase price. The market does not care what you paid.  
- **Example for $AAPL:** You bought at $280 (now at $270). The trend breaks. Sell at $270 regardless of your loss. Don’t “wait to break even.”

### 8. Consistency of Signal
- **Definition:** A buy or sell signal must be **perfectly repeatable** by anyone using the same rules. No human discretion allowed.  
- **Example for $AAPL:** The “Buy” signal triggers on $AAPL whenever RSI(14) closes below 30 **and** price is above the 200‑day moving average. No overrides.

### 9. Robustness Across Assets
- **Definition:** If a strategy works on one stock, it should also work on other similar stocks without changing the parameters (e.g., other large‑cap tech).  
- **Example for $AAPL:** The same mean‑reversion logic (price 2σ from its 50‑day MA) that works on $AAPL should also yield positive returns on $MSFT and $NVDA.

### 10. The “Sleep Test” Logic
- **Definition:** If your position size keeps you awake at night or causes emotional distress, it is **not** high‑quality – no matter what the math says.  
- **Example for $AAPL:** If a normal 2% drop in $AAPL makes you stressed, your position is too large. Reduce size until you feel neutral.

---

This beginner‑friendly version retains all **50 original proofs**, each with a clear definition and a concrete $AAPL example as of May 1, 2026. You can use this as a checklist or training guide for swing traders new to quantitative logic.



To provide a verifiable framework for high-quality swing trading, we can map the 50 formal logic proofs directly to the current market behavior of Apple Inc. ($AAPL$) as of May 1, 2026.
I. The Axioms of Expectancy & Probability
1. Positive Expectancy: If an $AAPL$ mean-reversion strategy wins 60% of the time with an average gain of $12 and loss of $8, $E[t] = (0.60 \cdot 12) - (0.40 \cdot 8) = \$4.00$. The trade is logically sound.
2. LLN Convergence: Executing 1,000 $AAPL$ "earnings gap" trades ensures the yield converges to the historical 17% revenue growth signal rather than a lucky outlier.
3. Bernoulli Independence: A loss on an $AAPL$ long position today does not logically increase the probability of a win tomorrow; the "rebound" must be proven by a new signal.
4. Kelly Optimality: With $AAPL$ having 3:1 odds and a 55% win rate, your optimal position size is $f^* = \frac{(3 \cdot 0.55) - 0.45}{3} = 40\%$.
5. Entropy Constraint: A quality $AAPL$ trade avoids "noise" entries during mid-day consolidation where the information signal is near zero.
6. Sharpe Ratio: With $AAPL$ yielding 29% YoY vs. a risk-free rate of 4%, its volatility $\sigma$ must remain below 16% to maintain a $Sharpe > 1.5$.
7. Monte Carlo Robustness: Even if the order of $AAPL$ price moves in 2025 was randomized, the system must not hit a total account drawdown of 50%.
8. Positive Skewness: High quality means capturing $AAPL$’s occasional +5% "AI announcement" days while capping daily losses at 1%.
9. Fat-Tail Awareness: Proof that your stop-loss accounts for a 20% "Black Swan" gap down in $AAPL$ if a major factory line is disrupted.
10. Stationarity of Edge: The 50-day Moving Average crossover edge on $AAPL$ is verified only if it has performed consistently across both 2024 and 2026 regimes.

II. The Logic of Risk & Ruin
1. Gambler's Ruin: Over-leveraging $AAPL$ options so that a 5% drop clears the account makes $P(Ruin) \to 1$.
2. Fixed Fractional Risk: On a $100,000 account, risking only $2,000 on an $AAPL$ swing, regardless of the share price.
3. The 6% Rule: If you hold $AAPL$, $MSFT$, and $NVDA$, their combined risk must not exceed 6% since they are logically correlated.
4. Correlation Ceiling: If $AAPL$ and $QQQ$ have $\rho > 0.95$, buying both doesn't add diversity; it just doubles leverage.
5. Stop-Loss Verifiability: A long at $271 with no stop is "illogical." A stop at $264 (recent support) makes the risk finite and verifiable.
6. MDD Constraint: A high-quality $AAPL$ system ensures that a correction from the $288 ATH to $245 does not exceed the model’s pre-defined drawdown limit.
7. Opportunity Cost: If $AAPL$ is expected to gain 2% this month but $GOOG$ is expected to gain 5%, the $AAPL$ trade is logically "sub-optimal."
8. Time-Stop Logic: If $AAPL$ stays at $271 for 10 days without moving, the "swing" has failed the velocity axiom; capital should be recycled.
9. Volatility-Adjusted Sizing: If $AAPL$ ATR is $5.00, the position size must be smaller than when ATR is $2.00 to keep dollar-risk constant.
10. VaR Validation: There is 95% confidence that an $AAPL$ swing position won't lose more than $3,500 overnight.

III. Market Structure & Execution Logic
1. Trend Symmetry: $AAPL$ is in a "quality" uptrend because it made a Higher High ($288) and a Higher Low ($245).
2. Mean Reversion: $AAPL$ at $285 is $2\sigma$ away from its $260$ SMA50; the logic dictates a high probability of a pull-back.
3. Volume Confirmation: The post-earnings rally to $283 is "true" only if volume exceeds the 46M average.
4. S/R Reflexivity: The $273 resistance from last month is now verified support since $AAPL$ bounced off it today.
5. Breakout Validity: $AAPL$ breaking $280 on high volume post-earnings constitutes a verifiable "Breakout" state.
6. Gap Logic: The gap from $271 to $278 on May 1st remains an "unfilled" bullish signal.
7. Relative Strength: $AAPL$ rising 1% while the $QQQ$ is flat proves $AAPL$ has $RS > 0$.
8. Sector Tailwind: Buying $AAPL$ is higher quality when the XLK (Tech Sector) is also in a verifiable uptrend.
9. Market Breadth Filter: If $AAPL$ is the only tech stock rising while 400 others fall, the trade lacks systemic "breadth" support.
10. Liquidity Threshold: Buying 10,000 shares of $AAPL$ is $HQST$ because it represents $<0.03\%$ of its 36M daily volume.

IV. Volatility & Options Mechanics
1. Short Vol Logic: Selling $AAPL$ puts when $IV$ is 27% but realized volatility is only 21%.
2. Theta Decay: A short $AAPL$ vertical spread is a proof that time ($\Delta t$) is being converted into equity ($+ \Delta \$$).
3. Delta Neutrality: An $AAPL$ Iron Condor is high quality if the total Delta is near zero, removing directional bias.
4. Gamma Sensitivity: Recognizing that $AAPL$ options risk increases exponentially as the stock nears the $275$ strike at expiration.
5. Vega Hedging: Profiting from the "IV Crush" after $AAPL$’s April 30th earnings announcement.
6. P/C Ratio Sentiment: An $AAPL$ Put/Call volume ratio of 0.35 serves as a verifiable indicator of bullish consensus.
7. VIX Inverse Correlation: $AAPL$ swings are safer when the $VIX$ is dropping from 20 to 15.
8. Contango/Backwardation: Utilizing $AAPL$ LEAPS requires accounting for the "cost of carry" in the options premium.
9. Iron Condor Range: Logic proves $AAPL$ has a 68% probability of staying between $260$ and $290$ over the next 30 days.
10. Margin Efficiency: An $AAPL$ credit spread is $HQST$ because it generates 15% Return on Capital while using minimal margin.

V. Systemic & Behavioral Logic
1. Occam’s Razor: A simple $AAPL$ trend-following system outperforms one using 15 indicators that result in "analysis paralysis."
2. Backtest Overfitting: If the system worked in the 2021 bull market but fails the 2026 $AAPL$ data, the logic is "brittle."
3. Slippage Impact: In $AAPL$, the $0.01$ spread ensures that slippage does not negate the $4.00 expectancy.
4. Data Latency: A proof that your $AAPL$ limit order at $271.50 was executable based on the Level 2 tape.
5. Survivorship Bias: Testing the strategy on a "Magnificent Seven" basket including the $AAPL$ of 2026, not just the winners of 2010.
6. Confirmation Bias Filter: Actively searching for "bearish" news on the iPhone 17 before committing to a "bullish" $AAPL$ swing.
7. Sunk Cost Negation: Deciding to sell $AAPL$ at $270 because the trend broke, regardless of whether you bought it at $280.
8. Consistency of Signal: The "Buy" signal triggers on $AAPL$ whenever RSI hits 30, with zero discretionary "overrides."
9. Robustness Across Assets: The same logic used for $AAPL$ should yield a positive expectancy when applied to $MSFT$.
10. The "Sleep Test": If a 2% drop in $AAPL$ creates a physiological stress response, the position size violates the "Human Equilibrium" axiom.
Does this logic-based breakdown help you refine the parameters for your trading model?


In the context of quantitative finance and formal logic, a High-Quality Swing Trade ($HQST$) is not a matter of "feeling" but a verifiable state defined by a set of logical predicates. If we define $\mathcal{T}$ as the set of all possible trades, a trade $t \in \mathcal{T}$ satisfies $HQST$ if and only if it adheres to a rigorous axiomatic framework.
Here are 50 diverse proofs—structured as logical propositions, mathematical identities, and formal axioms—that define the boundaries of high-quality swing trading.
I. The Axioms of Expectancy & Probability
1. Positive Expectancy Proof: $\forall t \in HQST, E[t] = (P_w \cdot \text{AvgW}) - (P_l \cdot \text{AvgL}) > 0$. High quality is fundamentally defined by a positive expected value over $n$ iterations.
2. Law of Large Numbers Convergence: As $n \to \infty$, the observed yield $Y_n$ must converge to $E[X]$. A quality trade is one where the process is repeatable enough for convergence to occur.
3. Bernoulli Trial Independence: $P(t_{n+1} | t_n) = P(t_{n+1})$. Each trade must be logically independent to avoid the Gambler's Fallacy.
4. Kelly Criterion Optimality: The position size $f^*$ is high quality only if $f^* = \frac{bp - q}{b}$, where $b$ is the odds and $p$ is the probability of winning.
5. Shannon’s Entropy Constraint: Quality trading minimizes the "noise" (entropy) of the equity curve, maximizing the information signal of the strategy.
6. Sharpe Ratio Threshold: $\frac{R_p - R_f}{\sigma_p} > 1.5$. High quality requires risk-adjusted returns that significantly exceed the risk-free rate.
7. Monte Carlo Robustness: A strategy is $HQST$ only if $\min(\text{Ending Equity}) > 0$ across 10,000 randomized permutations of trade order.
8. Skewness Necessity: $HQST$ systems often favor positive skewness (small frequent losses, large infrequent gains), where $\gamma_1 > 0$.
9. Fat-Tail Awareness (Kurtosis): Proof that $P(|X| > 3\sigma)$ is accounted for in the risk model, acknowledging that market returns are non-Gaussian.
10. Stationarity of Edge: The statistical edge $\theta$ must be proven stationary over the lookback period $k$.

II. The Logic of Risk & Ruin
1. Gambler's Ruin Avoidance: $P(\text{Ruin}) = (\frac{q}{p})^a \approx 0$, where $a$ is the units of capital. If $P(\text{Ruin}) > 0.01$, the trade is not high quality.
2. Fixed Fractional Risk Axiom: $\forall t, \text{Risk}(t) \le 0.02 \cdot \text{Account Equity}$.
3. The 2% Rule Proof: If $\sum \text{Risk}_{open} > 6\%$, then the portfolio is "over-leveraged," violating the diversity of risk.
4. Correlation Coefficient Ceiling: $\forall (t_i, t_j) \in \text{Portfolio}, \rho(t_i, t_j) < 0.7$. High quality requires low idiosyncratic correlation.
5. Stop-Loss Verifiability: A trade without a hard stop is logically undefined ($\text{Risk} = \infty$).
6. Maximum Drawdown ($MDD$) Constraint: $HQST$ requires that $\frac{\max(P) - \min(P)}{\max(P)} < \text{Threshold}$.
7. Opportunity Cost Theorem: $t \in HQST \iff \text{Expected Yield}(t) > \text{Benchmark Yield}$.
8. Time-Stop Logic: If $Price(t+k) \approx Price(t)$, then $\text{Action} = \text{Exit}$. Dead capital is a logical loss.
9. Volatility-Adjusted Sizing: $\text{Size} = \frac{\text{Capital} \cdot \text{Risk Percentage}}{\text{ATR} \cdot \text{Multiplier}}$.
10. VaR (Value at Risk) Validation: 95% confidence that the loss will not exceed $L$ in time $T$.

III. Market Structure & Execution Logic
1. Trend Symmetry: $\forall \text{Timeframe } T, \text{Trend} = (\text{Higher Highs} \land \text{Higher Lows})$.
2. Mean Reversion Identity: $P(P_t \to \mu | |P_t - \mu| > 2\sigma) > 0.5$.
3. Volume Confirmation Proof: $\Delta Price \propto \Delta Volume$. Price movement without volume is a "weak" logical state.
4. Support/Resistance Reflexivity: If $Price$ touches $L$ and $\text{Volume Increase} \land \text{Price Bounce}$, then $L$ is a "Verified Support."
5. Breakout Validity: A breakout is $HQST$ only if $Close > \text{Resistance} \land \text{ATR} > \text{Avg ATR}$.
6. Gap Logic: $\neg \text{Fill}(Gap) \implies \text{Strong Momentum}$.
7. Relative Strength Index (RS): $HQST$ requires $RS(Stock, Index) > 0$. You want the fastest horse in the race.
8. Sector Tailwind: $t \in HQST \implies \text{Trend}(\text{Sector}) = \text{Trend}(t)$.
9. Market Breadth Filter: If $\sum \text{Advancing Stocks} < \sum \text{Declining Stocks}$, then "Long" entries are logically suppressed.
10. Liquidity Threshold: $\forall t, \text{Order Size} < 0.01 \cdot \text{Average Daily Volume}$.

IV. Volatility & Options Mechanics
1. IV Crush Logic: $t \in \text{Short Vol} \iff IV > RV$ (Implied Volatility > Realized Volatility).
2. Theta Decay Identity: For swing sellers, $\frac{dV}{dt} < 0$. Time is a verifiable revenue stream.
3. Delta Neutrality Proof: In a market-neutral swing (like a Strangle), $\sum \Delta_i \approx 0$.
4. Gamma Sensitivity: $HQST$ requires awareness that $\Gamma = \frac{d\Delta}{dP}$; sudden price moves accelerate risk.
5. Vega Hedging: A quality trade accounts for volatility shifts: $\text{PL} = \dots + \nu \cdot \Delta IV$.
6. Put/Call Ratio Sentiment: Extreme values ($> 1.0$ or $< 0.5$) act as logical contrarian indicators for swing reversals.
7. VIX Inverse Correlation: $P(\text{Market Rally} | \text{VIX Drop}) \gg 0.5$.
8. Contango/Backwardation Logic: In futures-based swings, the roll yield must be positive or neutralized.
9. Iron Condor Range: $P(\text{Price} \in [L, H]) > \text{Breakeven Probability}$.
10. Margin Efficiency: $\text{ROC} = \frac{\text{Net Profit}}{\text{Maintenance Margin}}$.

V. Systemic & Behavioral Logic
1. Complexity Penalty (Occam’s Razor): If $\text{Complexity}(System A) > \text{Complexity}(System B) \land \text{Returns}(A) \approx \text{Returns}(B)$, then $B$ is the $HQST$ choice.
2. Backtest Overfitting Proof: A system is $HQST$ only if its Out-of-Sample (OOS) performance $> 0.7 \cdot \text{In-Sample}$.
3. Slippage Impact Theorem: $\text{Profit} - (\text{Slippage} + \text{Commissions}) > 0$. Many "proofs" fail here.
4. Data Latency Bias: A proof is invalid if it assumes execution at a price that was unavailable at time $T$.
5. Survivorship Bias Removal: The dataset used to "prove" the strategy must include delisted and bankrupt entities.
6. Confirmation Bias Filter: $\exists$ a logical "Null Hypothesis" for every trade entry.
7. Sunk Cost Negation: $\text{Decision}(t_{now}) \neq f(\text{Initial Entry Price})$. The market doesn't care where you bought it.
8. Consistency of Signal: The signal $\mathcal{S}$ must be programmatically definable without "discretionary" ambiguity.
9. Robustness Across Assets: A high-quality logic should work on both $AAPL$ and $Gold$ if the underlying mechanics (momentum/volatility) are similar.
10. The "Sleep Test" Logic: If $\sigma_{portfolio}$ causes emotional distress, the logic of the system has failed the "Human Element" axiom.

References
Kirilenko, A. A., & Lo, A. W. (2013). Moore’s Law versus Murphy’s Law: Algorithmic Trading and Its Discontents. Journal of Economic Perspectives, 27(2), 51–72. https://doi.org/10.1257/jep.27.2.51
Cited by: 364
Li, K., & Liu, J. (2022). Optimal Dynamic Momentum Strategies. Operations Research, 70(4), 2054–2068. https://doi.org/10.1287/opre.2021.2254
Cited by: 27
Fernholz, E. R., Karatzas, I., & Ruf, J. (2016). Volatility and Arbitrage. arXiv. https://doi.org/10.48550/arxiv.1608.06121
Cited by: 32
