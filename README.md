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

## GitHub Actions

The scheduled workflow lives in `.github/workflows/scrape.yml`.

- Cron: `30 19 * * *`
- As of May 18, 2026 this is `21:30` in `Europe/Budapest` while daylight saving time is active.
- GitHub cron uses UTC year-round, so during winter this will run at `20:30` in Budapest.

Create these repository secrets before enabling the workflow:

- `CONFIG_JSON`
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID` (optional, but recommended for instant slash-command registration in one server)

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

1. runs `node run_daily.js`
2. refreshes `towns.json`
3. edits the saved Discord bot messages using `discord_state.json`
4. optionally still sends webhook updates if `CONFIG_JSON` contains `webhooks`
5. commits `towns.json` and `discord_state.json` back to `main` if they changed
