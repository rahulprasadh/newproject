# newproject: trading toolkit for Claude Code

This repo gives Claude Code two things when you open it:

1. **74 trading skills** in `.claude/skills/`, from
   [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills)
   (MIT, see `THIRD_PARTY_NOTICES.md`): screeners, position sizing, breakout
   planning, a trade journal, backtesting, market breadth, options and more.
2. **A MetaTrader 5 connector** in `.mcp.json`, using
   [meta-trader-mcp](https://github.com/shubhvisputek/meta-trader-mcp) 1.2.2:
   quotes, candles, account info, positions, technical analysis and backtests
   from your own MT5 terminal.

## Setup

```bash
git clone https://github.com/rahulprasadh/newproject
cd newproject
pip install -r requirements.txt     # Python deps for the skill scripts
claude                              # approve "meta-trader-mcp" when asked
```

You also need [uv](https://docs.astral.sh/uv/) installed (the connector runs
through `uvx`).

### Skills

Skills load automatically. Ask in plain language, for example "size a trade
with entry 2850 and stop 2780 on a 5 lakh account", or run
`/trading-skills-navigator` to get a workflow for your goal.

Most screeners and calendars need a free
[Financial Modeling Prep](https://site.financialmodelingprep.com/) key
(250 requests/day). Set it before starting `claude`:

```bash
export FMP_API_KEY=your_key
```

These work with no key: `position-sizer`, `market-breadth-analyzer`,
`uptrend-analyzer`, `trader-memory-core`, `signal-postmortem`.

Most screeners are built around US stocks. Reports go to `reports/` and the
trade journal to `state/`; both are git-ignored because this repo is public.

### MetaTrader 5 connector

Needs the MT5 desktop terminal running and logged in to your broker on the
same machine. It does not work in Claude Code on the web, which has no MT5
terminal.

- **Windows:** works as is.
- **macOS / Linux:** MT5 runs under Wine. Set these before starting `claude`,
  then run `uvx --from meta-trader-mcp==1.2.2 --with "mcp<2" meta-trader-mcp setup-wine`
  once:

  ```bash
  export MTM_PACKAGE='meta-trader-mcp==1.2.2'
  export MTM_MODE=local-wine
  ```

If the terminal is already logged in you don't need to give it credentials.
Otherwise set `MT5_LOGIN`, `MT5_SERVER` and `MT5_PASSWORD` in your shell.
Never put them in this repo.

#### Safety defaults

| Setting | Default here | Meaning |
|---|---|---|
| `MTM_ENABLE_TRADING` | `false` | Read-only. Order tools return "Trading is disabled". |
| `MTM_ENABLE_EXEC` | `false` (fixed) | Blocks the shell, Python and MQL execution tools. |
| `MTM_MAX_LOT` | `0.1` | Largest single order allowed. The package's own default is 10 lots. |
| `MTM_MAX_DRAWDOWN_PCT` | `5.0` | Blocks new positions past this equity drawdown. |

To allow trading, try it on a **demo account** first, then start Claude with
`MTM_ENABLE_TRADING=true claude`. Orders can use `dry_run=true` to preview
them through your broker without sending them.

`--with "mcp<2"` in `.mcp.json` is required: meta-trader-mcp 1.2.2 crashes on
startup with `mcp` 2.x.

None of this is financial advice. Check every order before it goes out.
