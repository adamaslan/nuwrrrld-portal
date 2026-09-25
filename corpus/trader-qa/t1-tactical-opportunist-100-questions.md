# T1 (Tactical Opportunist) - 100 Deep-Dive Questions

## Profile Overview

**T1 Profile Characteristics:**
- **Holding Period:** 1-3 months (short-term swings)
- **Primary Strategy:** Mean-reversion + options selling (Axiom IV focus)
- **Tax Strategy:** Short-term capital gains offset by short-term losses
- **Core Edge:** Volatility selling, earnings gaps, rapid rebalancing
- **Risk Model:** Fixed fractional on larger accounts; volatility-adjusted sizing

---

## I. Holding Period & Trade Mechanics (20 Questions)

### Entry & Exit Dynamics

1. **What is the maximum number of trading days you should hold a position before the edge deteriorates?**
   - How do you define this mathematically (e.g., theta decay vs. momentum loss)?
   - What happens to your Sharpe ratio if you're forced to hold 45 days instead of 30?

2. **If you enter a swing trade on Day 1 and price hasn't moved by Day 10, what is your exit protocol?**
   - Is it a "velocity stop" based on expected move, or time-based?
   - How do you handle the case where price is "near" your target but not quite there?

3. **For a 2-month swing, how many adjustments (rehedges, rolls) are acceptable before you close the entire position?**
   - Each adjustment is a micro-taxable event; what's your threshold?
   - Does volatility affect your willingness to adjust?

4. **You're in a 6-week mean-reversion trade. Price touches your target after 8 days, then reverses. Do you re-enter?**
   - How do you avoid "whipsaw" losses that eat into your edge?
   - What confirmation do you need to re-enter?

5. **How do you handle expiration-week dynamics in a 3-month short options position?**
   - Do you always close by Friday of expiration week, or do you let it run to expiration?
   - What is the gamma risk threshold before you exit?

6. **If you have overlapping 2-month swings (e.g., 5 positions in various stages), how do you avoid concentration in any one month?**
   - Do you stagger entry points or limit the number of concurrent positions?
   - What correlation constraint applies?

7. **In a 1-month swing, you're up 70% on a 1% risk trade (i.e., up $700). Do you take profit immediately or ride to the 3-month target?**
   - How do you make this decision without emotional bias?
   - Is there a formula for "optimal exit point" given your edge and remaining time?

8. **What is your "earliest profitable exit rule"—i.e., the minimum profit level before which you will not voluntarily close a trade early?**
   - Does this vary by volatility environment?
   - How does it compare to your average winning trade size?

9. **For a 10-week position that gaps against you by 15% overnight, do you hold, add, or exit?**
   - How does your decision change if you're 8 weeks in vs. 2 weeks in?
   - What is your "max adverse excursion" tolerance?

10. **You're in a 50-day mean-reversion position. On Day 45, a black swan event moves price 20% against you. Exit or hold the last 5 days?**
    - How do you rationalize holding after the setup is "broken"?
    - Is there a logical cut-off point, or is it based on the remaining time value of your position?

### Seasonal & Regime Considerations

11. **Do you adjust your holding period during earnings season vs. off-earnings periods?**
    - Is the edge different for earnings gaps (1-week swings) vs. mean-reversion (4-6 week swings)?
    - How does implied volatility at the time of earnings affect your desired holding period?

12. **How do you backtest the "performance by holding period" to find your optimal 1-3 month range?**
    - Do you test in 1-week increments, or are there natural breakpoints (e.g., 3-week, 6-week, 12-week)?
    - Does the optimal holding period vary by market regime (bull, bear, sideways)?

13. **In a low-volatility regime (VIX < 12), do you shorten your holding periods?**
    - Why would lower volatility change your optimal time frame?
    - Is your edge still positive if you're forced to hold 2x longer in calm markets?

14. **During market drawdown periods, do you avoid 1-month swings and only trade the shorter 1-3 week range?**
    - How does correlation spike affect your diversification between overlapping positions?
    - Should you reduce position sizes or reduce the number of concurrent swings?

15. **How do you define "holding period drift"?**
    - Example: You intended a 30-day swing, but it's now Day 45 and you're still not at target.
    - At what point does it stop being a "tactical opportunist" trade and become a "strategic position"?

---

## II. Mean-Reversion Strategy Deep Dive (20 Questions)

### Statistical Framework

16. **Describe your exact mean-reversion entry criteria (e.g., 2σ, 3σ, Bollinger Band squeeze + breakout).**
    - How do you ensure this is not a "statistical illusion" but a real edge?
    - Over what lookback period (20-day, 50-day, 200-day) do you compute the mean and std dev?

17. **How do you distinguish between a "genuine mean-reversion trade" and a "trend reversal" that continues in the opposite direction?**
    - Is there a technical filter (e.g., RSI > 70 before shorting an extreme)?
    - What volume confirmation do you need?

18. **For a stock that's 2.5σ above its 50-day MA, what is your target price?**
    - The mean? A partial reversion (e.g., 1σ)?
    - How do you decide where to place your profit-taking level?

19. **In a mean-reversion trade, at what price level does the trade "fail" and you should cut losses?**
    - Example: Short at 2σ above the mean, stop loss at 3σ?
    - How do you set the stop without it being too tight (whipsawed) or too loose (ruin risk)?

20. **How does correlation affect your mean-reversion edge?**
    - If you have 3 short positions all reverting to their respective means, and they all move together, is that a problem?
    - How do you model the "systemic reversion" component vs. idiosyncratic reversion?

21. **What is the relationship between mean-reversion strength and holding period?**
    - Is reversion faster in the first 2 weeks or distributed over 8 weeks?
    - How does this inform your position sizing across the 1-3 month range?

22. **How do you handle the "mean" in a structural break scenario?**
    - Example: A stock's 50-day MA is $271, but the company announces a transformational acquisition.
    - Is your mean now obsolete? How quickly do you adjust?

23. **Describe your exact process for identifying when the "mean has shifted permanently" vs. when it's a temporary extreme.**
    - What technical or fundamental signals trigger a "mean update"?
    - How long do you wait before updating the mean (e.g., 1 week, 1 month)?

24. **For a mean-reversion edge that works 65% of the time, what is your Kelly-optimal position size?**
    - Assume 2:1 reward-to-risk ratio and 1% account risk per trade.
    - What happens if you're forced to size at 2x Kelly due to account constraints?

25. **How do you backtest mean-reversion across different market regimes?**
    - Is the edge stronger in bull markets, bear markets, or sideways markets?
    - If it's weaker in one regime, do you reduce size, skip trades, or adjust your criteria?

### Tactical Execution

26. **Do you enter mean-reversion trades all at once or scale in (e.g., 1/3 at 2σ, 1/3 at 2.5σ, 1/3 at 3σ)?**
    - What are the pros and cons of each approach?
    - How does position averaging affect your average fill price and overall return?

27. **In a mean-reversion position, do you scale out (take 1/3 profit at each level: 1σ, 0.5σ, mean) or all-at-once at target?**
    - How does this choice affect your overall expectancy and Sharpe ratio?
    - Does scaling out reduce your max-profit potential?

28. **How do you handle "overshoots" in mean-reversion?**
    - Example: You're short a stock at 2σ above the mean, targeting the mean. Price hits the mean but keeps falling to -0.5σ.
    - Do you add to your position? Take full profits? Let winners run?

29. **For a mean-reversion trade that's profitable but slow to converge, do you ever "give up" and exit early to recycle capital to a faster opportunity?**
    - How do you quantify the opportunity cost of holding a slow position?
    - Is there a "maximum time in trade before capitulation" rule?

30. **How do you ensure that your mean-reversion entries are not influenced by recent losses (revenge trading)?**
    - What safeguards do you have to avoid over-trading after a losing streak?
    - Is there a daily or weekly limit on the number of mean-reversion entries?

31. **In a mean-reversion trade, how do you adjust your stop-loss if the underlying volatility spikes?**
    - Do you widen the stop, or do you reduce position size and keep the same absolute stop?
    - How does this decision affect your risk profile?

32. **How do you distinguish between "normal mean-reversion candidates" and "trap trades" that spike further before reverting?**
    - Are there early warning signs (e.g., earnings announcement, insider selling)?
    - How much extra due diligence do you do on extreme outliers?

---

## III. Options Selling & Axiom IV (20 Questions)

### Volatility Selling Framework

33. **What is your exact entry criteria for "IV > RV" (Implied Vol > Realized Vol)?**
    - Do you require IV to be 2x RV, or is 1.3x enough?
    - How do you measure RV (20-day, 30-day, implied move)?

34. **For a short vertical spread on $AAPL with 30 days to expiration, how much premium is "enough" to justify the trade?**
    - Do you require 1.5x your max loss, 2x, or something else?
    - How does this threshold vary by volatility environment?

35. **You sell a 30-day short call spread, targeting 30% max profit. Price starts moving toward your short strike. At what unrealized loss do you exit?**
    - 25% of max profit lost (-$75 on a $300 max profit trade)?
    - 50% (-$150)?
    - Or do you have a fixed-dollar stop loss instead?

36. **Describe your exact delta-hedging or rebalancing frequency for a short straddle or strangle.**
    - Do you rebalance every day, every 3 days, or when delta drifts past a threshold (e.g., delta > ±0.30)?
    - How many rebalances are acceptable before the "friction costs" (commissions, slippage, taxes) eat your edge?

37. **For a short put spread (bullish income trade), how do you select the strike to sell?**
    - At the 25-delta, 30-delta, or 35-delta level?
    - How does this choice affect your win rate, average profit, and max loss?

38. **In a declining market, do you avoid short premium strategies entirely, or do you adjust by changing the strikes and holding periods?**
    - Example: Instead of 30-day short puts, switch to 14-day short puts at lower strikes?
    - How does this affect your Sharpe ratio and drowdown profile?

39. **How do you avoid the "pin risk" of holding a short option at-the-money near expiration?**
    - Do you always close by Friday of expiration week, or do you hold into settlement?
    - Has this ever caused a surprise gap and loss?

40. **For a multi-leg option strategy (iron condor, butterfly, etc.), how do you decide whether to close the trade early or hold to expiration?**
    - Profit target? Time-based exit? Volatility-based exit?
    - How does commissions/slippage affect your decision to adjust vs. close?

41. **How do you model the relationship between Theta decay (your enemy in options) and time decay (your friend as a short seller)?**
    - In a short vertical spread, you're short theta and long theta simultaneously.
    - How do you optimize the structure to maximize theta decay benefit?

42. **Describe your exact risk management for selling naked calls or puts.**
    - Or do you avoid naked selling entirely and always use spreads?
    - If you sell spreads, how wide is your max loss tolerance as a % of account?

43. **How do you handle early assignment risk on short options?**
    - Example: You sell a short call spread; the short call gets assigned early when there's a dividend.
    - How does this change your tax lot management and overall P&L?

44. **For "Axiom IV focus" strategies (volatility harvesting), how much of your total capital allocation should be options-selling vs. other strategies?**
    - 20%? 50%? 100%?
    - How does concentration in options affect your portfolio Sharpe ratio vs. diversifying with stocks?

45. **How do you backtest options-selling strategies without survivorship bias?**
    - Do you include periods where the strategy might have blown up (e.g., 2008, March 2020)?
    - What is your maximum acceptable drawdown for an options-selling system?

46. **In a "short straddle" setup (sell both a call and put at-the-money), how do you ensure you're not exposed to both-side risk simultaneously?**
    - How close to expiration before you're willing to hold both sides open?
    - What's your "too late to manage, just close everything" rule?

### Tax Optimization in Options

47. **For a short call spread that you close after 6 days (before 30 days), is the gain short-term capital gain?**
    - How do you track the tax treatment of multi-leg options trades?
    - Does the IRS treat the vertical spread as a single transaction or separate legs?

48. **If you sell a short-term covered call on a stock you own for long-term gains, does the covered call dividend your holding period?**
    - Is this a wash sale situation, or is the holding period continuous?
    - How do you plan this tax-efficiently when you have long-term holdings?

49. **How do you harvest losses in options positions to offset gains from other strategies?**
    - Example: You have a short vertical spread loss; can you use it to offset a mean-reversion gain?
    - Are there wash sale complications?

50. **What is your "target annual loss harvesting amount" as a % of expected short-term gains?**
    - Do you aim for a 1:1 ratio (all gains offset by losses), or do you accept some tax drag?
    - How does this change depending on your income level and tax bracket?

---

## IV. Tax-Aware Trading & Loss Harvesting (20 Questions)

### Loss Harvesting Strategy

51. **Describe your exact criteria for identifying a "tax-loss harvesting candidate."**
    - Must it be down ≥10% from entry? Any threshold?
    - How do you avoid harvesting a loss on a stock that's about to reverse sharply?

52. **When you harvest a loss, how long do you wait before re-entering a substantially identical position?**
    - Do you use the IRS 30-day wash sale window, or do you wait longer to be safe?
    - How do you handle the case where you want to re-enter after 25 days but price is down further?

53. **For a stock where you have both a winning and losing lot, which lot do you sell for tax purposes?**
    - Always the winner (to harvest gains)? Or alternate?
    - How do you ensure your broker correctly identifies the specific lot you're selling?

54. **If you harvest a $5,000 loss in a stock, do you immediately redeploy the $5,000 into a mean-reversion short on the same stock?**
    - Why is this advantageous or disadvantageous?
    - Does the timing of the short entry (same day vs. 31 days later) affect your tax position?

55. **How do you calculate your "effective tax rate" on a swing trade after accounting for loss-harvesting benefits?**
    - Example: You have 10 winning trades at +$1,000 each and 4 losing trades at -$500 each.
    - After tax-loss harvesting, what is your true after-tax gain?

56. **Describe your tax-lot tracking system for a high-volume trader (e.g., 20+ trades per month).**
    - Do you use specific ID or average cost?
    - How do you ensure your broker's records match your tax records?

57. **For a stock that's been a "repeated loser" (harvested 3x in 2 years), do you stop trading it entirely, or do you keep harvesting?**
    - At what point does harvesting the same loss seem like "artificial tax alpha"?
    - How do auditors view repeated loss harvesting on the same security?

58. **How do you handle the case where you harvest a loss in December, but in January (before 31 days), the stock recovers and you want to re-enter long?**
    - Do you wait the full 31 days, or do you re-enter at day 31?
    - How close to the window edge is acceptable?

59. **When you execute a loss-harvesting trade, do you simultaneously buy a correlated-but-not-identical security (e.g., sell $AAPL, buy $MSFT)?**
    - How do you ensure the IRS doesn't consider them "substantially identical"?
    - What is the minimum correlation difference required (e.g., ρ < 0.90)?

60. **For an options loss-harvesting scenario, if you harvest a loss on a short call spread, can you immediately sell a similar call spread for a new trade?**
    - Is this a wash sale (buying back at a loss, immediately selling)?
    - How does the wash-sale rule apply to options?

### Short-Term vs. Long-Term Planning

61. **At what point in a trade do you make the "long-term vs. short-term" decision?**
    - Entry? Day 365? Or only at exit when you know the holding period?
    - Can you change your mind mid-trade?

62. **For a trade that hits its target on Day 359, do you hold the last 6 days to get long-term capital gains treatment?**
    - How do you weigh the tax benefit against the risk of losing the profit?
    - What's the minimum annual tax savings needed to justify holding 6 extra days?

63. **If a short-term gain from a swing would push you into a higher tax bracket, do you defer the sale into the next year?**
    - How do you model the "bracketing benefit" of spreading gains across tax years?
    - Does this ever cause you to hold winners longer than your edge supports?

64. **Describe your "year-end tax planning strategy" for November/December.**
    - Do you avoid entering new short-term trades in October to prevent December realizations?
    - How many trades do you deliberately hold past December 31 to defer into next year?

65. **If you're on track for a large short-term capital gains tax bill in 2026, what actions do you take in Q4 2026?**
    - Harvest losses? Stop trading temporarily? Use offshore strategies?
    - How do you prevent "surprise" tax bills?

66. **For a systematic short-term swing trader, what is your expected annual "tax drag" as a % of gross returns?**
    - Is 15-20% reasonable for a trader in the top bracket?
    - How does this compare to a long-term buy-and-hold strategy?

67. **How do you optimize the timing of your trades to minimize wash sales?**
    - Example: You want to trade $AAPL and $MSFT as a pair (correlated shorts), but you're about to harvest an $AAPL loss.
    - Do you delay trading $MSFT until after the 30-day window?

68. **If a trade that started as a "1-month swing" accidentally crosses into month 2 and eventually becomes 13 months in duration, what is the tax treatment?**
    - Short-term for the first year, then long-term if held past 365 days?
    - How does this affect your decision to hold or exit?

69. **What is your policy on taking realized losses vs. "paper losses"?**
    - Do you ever hold a losing position through the end of the year to harvest the loss in January of next year?
    - How long can a "losing position" sit before it's no longer a valid trade but a sunk cost?

70. **How do you educate clients or stakeholders about the "tax drag" inherent in high-frequency swing trading?**
    - Do you report pre-tax or after-tax returns?
    - How do you set expectations about the 30-50% effective tax rate on high-turnover strategies?

---

## V. Risk Management & Position Sizing (20 Questions)

### Volatility-Adjusted Sizing

71. **Describe your exact formula for volatility-adjusted position sizing.**
    - Example: Position Size = (Account Risk %) ÷ (ATR × Multiplier)?
    - How do you choose the multiplier? Fixed (e.g., 2) or dynamic?

72. **If ATR on $AAPL expands from $4 to $10 suddenly (implied vol spike), do you reduce your position size mid-trade?**
    - Or do you only adjust on new entries?
    - How many trades do you adjust before the volatility "settles"?

73. **For a stock with bimodal volatility (very calm most days, then huge spikes on specific triggers like earnings), how do you set position size?**
    - Do you use the long-term ATR or the recent ATR?
    - How do you account for upcoming earnings or events?

74. **At what volatility threshold do you stop trading a stock entirely?**
    - Example: If ATR > $15 on a $300 stock (5% daily move expected), is that too risky?
    - How does this threshold vary by account size?

### Multi-Position Portfolio Risk

75. **For a T1 trader holding 5-10 concurrent 2-month swings, how do you ensure the portfolio delta is neutral (if that's your target)?**
    - Do you balance longs and shorts systematically?
    - Or do you allow directional bias (e.g., 60% net long)?

76. **If you have 8 positions open and correlation spikes from 0.3 to 0.7 (market stress), do you reduce the number of positions?**
    - How many positions is "safe" in a high-correlation environment?
    - Do you exit your highest conviction trade or your smallest position?

77. **Describe your "maximum drawdown plan" if the market drops 10%, 20%, or 30%.**
    - At what drawdown level do you halt new entries?
    - At what level do you start force-closing positions?

78. **For mean-reversion trades, you might be short 3 different stocks simultaneously. If the market rallies 5% and all three reverse against you, how do you handle it?**
    - Do you add to the positions (increase conviction), reduce size, or exit?
    - How do you distinguish between a "buying opportunity" and a "broken strategy signal"?

79. **What is your maximum "open risk" at any time as a % of account equity?**
    - 5%? 10%? 20%?
    - How does this change based on portfolio volatility?

80. **If you're at your maximum open risk and a fresh mean-reversion signal fires, do you take it, or do you wait for a position to close first?**
    - How long do you "skip signals" while waiting for capital?
    - How does this affect your annual return?

### Stop-Loss & Catastrophe Management

81. **Describe your exact stop-loss placement for a mean-reversion short.**
    - Example: Short at +2σ above the mean, stop at +3σ?
    - How do you adjust the stop if volatility spikes?

82. **For a short options position (e.g., short call spread), at what unrealized loss do you close the entire position?**
    - 50% of max profit lost? 100%? Or do you have a fixed-dollar stop?
    - How does time-to-expiration affect this decision?

83. **If you have a "black swan" stop-loss triggered overnight (e.g., earnings gap), do you re-enter the same setup the next day?**
    - Or do you consider the setup "broken" and avoid it for a week?
    - How do you avoid revenge trading after a stop-loss?

84. **For a 1-month swing that hits your stop-loss on Day 5, do you immediately re-enter with a tighter stop, or do you wait for fresh confirmation?**
    - How many consecutive stop-losses on the same setup before you suspect the edge is broken?
    - What's your protocol for "broken setups"?

85. **Describe your "max loss per day" rule (if you have one).**
    - Do you halt trading after 2 consecutive losses?
    - How many daily losses trigger a "systems review" before re-entry?

86. **If a single position is responsible for 50% of your portfolio drawdown, what is your exit protocol?**
    - Do you exit immediately, or do you wait for a bounce?
    - How do you prevent large positions from becoming catastrophic?

87. **For a leveraged account (e.g., 2:1 margin), at what margin level do you start reducing positions?**
    - 40% margin used? 60%? 80%?
    - How does this affect your trading frequency?

88. **Describe your "catastrophe stop" for the overall portfolio.**
    - Example: If account is down 20% from peak in any month, freeze all new entries?
    - If down 30%, start force-closing oldest positions?

### Capital Allocation

89. **How do you allocate capital across the T1 strategy vs. other strategies (e.g., T2, buy-and-hold)?**
    - Is it 50/50, 60/40, or all-in on T1?
    - How does this change based on market conditions?

90. **If the T1 strategy is in a 5-trade losing streak, do you reduce your capital allocation to it?**
    - How many trades or how much drawdown before reallocation?
    - How do you re-allocate (stay away for a month, then return)?

---

## VI. Behavioral & Execution Edge (10 Questions)

### Discretion vs. Automation

91. **For a T1 trader, how much of your trading should be rule-based and automated vs. discretionary?**
    - 100% mechanical rules?
    - 70% rules, 30% discretion?
    - Or is discretion only allowed for position sizing, not entry/exit?

92. **Describe a scenario where you would override a mechanical trading rule.**
    - Example: The signal fires, but you see a macro headwind (Fed event, war, etc.).
    - How often do you override? If >5% of signals, is discretion your edge or your liability?

93. **How do you avoid "analysis paralysis" (waiting for perfect entry) in a T1 strategy?**
    - Is there a "enter within X% of the signal price" rule?
    - What's the cost of missing a trade vs. entering sub-optimally?

94. **For a mean-reversion short that triggers at 2.1σ but you're expecting 2.5σ, do you wait for further extremes or enter now?**
    - How many times do you miss the trade by waiting too long?
    - How many times do you enter and it reverts immediately?

95. **If you're overconfident in a specific trade setup, do you size it 2x normal, or do you keep it at 1x?**
    - How many "overconfident trades" hit your max loss limit?
    - Does overconfidence add edge or subtract it?

96. **How do you handle "revenge trading" after a stop-loss?**
    - Do you sit out trading the next day, or do you jump back in?
    - What is your rule for re-entry after an emotional loss?

97. **Describe your "conviction sizing" approach.**
    - Do all trades get 1x position size, or do you size higher for higher-conviction setups?
    - How do you prevent your highest conviction trades from being your biggest losers?

98. **For a position in the red (unrealized loss), how does that affect your psychology and decision-making?**
    - Do you hold longer, hoping to break even (sunk cost fallacy)?
    - Or do you exit faster to preserve capital?

99. **How do you ensure you're not "picking up pennies in front of a steamroller" in short-volatility trades?**
    - What safeguards prevent you from selling premium before earnings, product launches, or macro events?
    - How do you stress-test your short options positions?

100. **After a 10-trade winning streak, are you more likely to increase position size, decrease it, or keep it constant?**
    - How does recent success bias affect your subsequent trade quality?
    - What rule do you have to prevent "betting too big after a win"?

---

## Summary: T1 Trader Development Path

### Quick Checklist for T1 Traders

- [ ] **Defined optimal holding period** (e.g., 30-60 days for mean-reversion, 14-30 days for earnings gaps)
- [ ] **Quantified mean-reversion edge** (60%+ win rate? 1.5:1 reward-to-risk?)
- [ ] **Backtested IV > RV entry criteria** for options selling (2x threshold? 1.3x?)
- [ ] **Tax-loss harvesting plan** (annual target loss amount? specific wash-sale protocol?)
- [ ] **Volatility-adjusted position sizing formula** with daily monitoring
- [ ] **Stop-loss placement rules** for both stocks and options
- [ ] **Portfolio correlation limits** (6% rule? Daily rebalancing?)
- [ ] **After-tax return expectations** (accounting for short-term capital gains treatment)
- [ ] **Drawdown tolerance** and force-close rules
- [ ] **Loss-streak protocol** (how many consecutive losses before pause/review)

### Key Metrics to Track

1. **Holding Period Distribution**: What % of trades last <30 days, 30-60 days, 60-90 days?
2. **Win Rate by Timeframe**: Does your 30-day win rate differ from your 60-day win rate?
3. **Tax Efficiency**: What % of gross returns do you lose to taxes?
4. **Slippage Impact**: How much is bid-ask spread + commission eroding your edge?
5. **Volatility-Adjusted Sharpe**: After adjusting for position size changes, is your risk-adjusted return stable?
6. **Correlation Monitoring**: Daily average correlation between open positions?
7. **Loss-Harvesting Ratio**: Are you harvesting 50%, 100%, or >100% of your annual gains?
8. **Drawdown Recovery Time**: How many trading days to recover from a 10% drawdown?

---

## References & Further Reading

- Kirilenko, A. A., & Lo, A. W. (2013). "Moore's Law versus Murphy's Law: Algorithmic Trading and Its Discontents."
- Fernholz, E. R., Karatzas, I., & Ruf, J. (2016). "Volatility and Arbitrage."
- IRS Publication 550: "Investment Income and Expenses"
- Shleifer, A., & Vishny, R. W. (1997). "The Limits of Arbitrage."

---

**Document Version:** 1.0  
**Last Updated:** May 1, 2026  
**Target Audience:** T1 Traders (Tactical Opportunists) with 1-3 month holding periods
