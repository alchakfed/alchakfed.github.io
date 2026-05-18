# Alchak Federation GitHub Setup

This repo can run locally with `daemon.js`, and it can also run on GitHub Actions every day.

## Local

1. Copy `config.example.json` to `config.json`.
2. Fill in your Discord webhook URLs or bot token if you use them.
3. Install dependencies with `npm install`.
4. Run `node daemon.js serve` for the dashboard or `node run_daily.js` for a one-off scrape plus webhook send.

## GitHub Actions

The scheduled workflow lives in `.github/workflows/scrape.yml`.

- Cron: `30 19 * * *`
- As of May 18, 2026 this is `21:30` in `Europe/Budapest` while daylight saving time is active.
- GitHub cron uses UTC year-round, so during winter this will run at `20:30` in Budapest.

Create this repository secret before enabling the workflow:

- `CONFIG_JSON`

Example secret value:

```json
{
  "webhooks": [
    {
      "url": "https://discord.com/api/webhooks/replace-me",
      "nations": ["Alchak_Federation"],
      "nation_roles": {}
    }
  ],
  "discord_bot_token": "",
  "auto_scrape": true,
  "max_manual_runs_per_hour": 5
}
```

The scheduled workflow:

1. runs `node run_daily.js`
2. refreshes `towns.json`
3. sends Discord webhook updates if `CONFIG_JSON` contains webhooks
4. commits the updated `towns.json` back to `main` if it changed
