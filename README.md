# Alchak Federation GitHub Setup

This repo can run locally with `daemon.js`, and it can also run on GitHub Actions every day.

## Local

1. Copy `config.example.json` to `config.json`.
2. Fill in your Discord bot token locally in `config.json`. That file is gitignored, so the token does not get committed.
3. Install dependencies with `npm install`.
4. Run `node daemon.js serve` for the dashboard and bot, or `node run_daily.js` for a one-off scrape plus Discord delivery.

## Discord Bot

- Run the bot locally with `npm run bot`.
- Use `/configure` in the Discord channel where you want the reports.
- `/configure` creates one persistent message per preset watched nation and one nation-picker message for all other nations.
- The bot stores message IDs in `discord_state.json`, which is safe to commit because it contains no secrets.
- The daily updater edits those same messages instead of posting new ones.

## Render Bot Host

If you host the bot on Render, let Render handle Discord and let GitHub only send fresh town data there.

Visiting the Render root URL wakes the service with a blank page:

```text
https://alchakfed-github-io.onrender.com/
```

Render environment variables:

- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `SYNC_SHARED_SECRET`
- `CONFIG_JSON`

Render start command:

```text
npm start
```

GitHub repository secrets for Render sync:

- `RENDER_SYNC_URL`
  - example: `https://your-render-service.onrender.com/api/towns-sync`
- `SYNC_SHARED_SECRET`
  - must match the same value set on Render

How it works:

1. Render keeps the Discord bot online 24/7.
2. GitHub Actions runs the scraper on schedule.
3. GitHub `POST`s the new `towns.json` payload to Render at `/api/towns-sync`.
4. Render saves the payload locally and refreshes the persistent Discord messages.

Each preset nation report includes a town dropdown for that nation. Selecting a town sends a private detail message with bank, upkeep, pending balance, and `Claim` / `Fall` buttons. `Claim` marks the town with a checkmark in the public report list, and `Fall` marks it with an X.

## GitHub Actions

The scheduled workflow lives in `.github/workflows/scrape.yml`.

- Cron: `30 19 * * *`
- As of May 18, 2026 this is `21:30` in `Europe/Budapest` while daylight saving time is active.
- GitHub cron uses UTC year-round, so during winter this will run at `20:30` in Budapest.

Create these repository secrets before enabling the workflow:

- `CONFIG_JSON`
- `RENDER_SYNC_URL`
- `SYNC_SHARED_SECRET`

Example secret value:

```json
{
  "upkeep_channel_id": "replace-with-channel-id",
  "default_watched_nations": ["Alchak_Federation"],
  "nation_role_ids": {
    "Alchak_Federation": "replace-with-role-id"
  },
  "auto_scrape": true,
  "max_manual_runs_per_hour": 5
}
```

The scheduled workflow:

1. runs `node scraper.js`
2. refreshes `towns.json`
3. sends the payload to your Render bot host
4. commits `towns.json` back to `main` if it changed
