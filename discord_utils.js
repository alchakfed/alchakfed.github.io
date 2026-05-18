const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

let discordLib = null;
let discordLoadError = null;

function getDiscordLib() {
    if (discordLib) {
        return discordLib;
    }

    if (discordLoadError) {
        return null;
    }

    try {
        discordLib = require('discord.js');
        return discordLib;
    } catch (err) {
        discordLoadError = err;
        console.warn(`[Discord] discord.js is unavailable: ${err.message}`);
        return null;
    }
}

function getConfig() {
    return loadConfig();
}

function normalizeWebhookTargets(webhooks = []) {
    if (!Array.isArray(webhooks)) {
        return [];
    }

    return webhooks
        .map((entry) => {
            if (typeof entry === 'string') {
                return { url: entry.trim(), nations: ['Alchak_Federation'], nation_roles: {} };
            }

            if (!entry || typeof entry !== 'object') {
                return null;
            }

            const url = String(entry.url || '').trim();
            const nations = Array.isArray(entry.nations)
                ? entry.nations.map((nation) => String(nation).trim()).filter(Boolean)
                : [];
            const nationRoles = entry.nation_roles && typeof entry.nation_roles === 'object' && !Array.isArray(entry.nation_roles)
                ? Object.fromEntries(
                    Object.entries(entry.nation_roles)
                        .map(([nation, roleId]) => [String(nation).trim(), String(roleId || '').trim()])
                        .filter(([nation, roleId]) => nation && roleId)
                )
                : {};

            if (!url) {
                return null;
            }

            return { url, nations, nation_roles: nationRoles };
        })
        .filter(Boolean);
}

function formatMoney(amount) {
    return Number(amount || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function getNationCode(nation) {
    if (!nation) {
        return 'NON';
    }

    if (nation.includes('_')) {
        return nation
            .split('_')
            .filter(Boolean)
            .map((part) => part[0] || '')
            .join('')
            .toUpperCase();
    }

    return nation.slice(0, 3).toUpperCase();
}

function formatTownLine(town) {
    const prefix = town.days_rounded <= 2 ? ':warning: ' : '';
    const nation = getNationCode(town.nation);
    const bank = formatMoney(town.bank || 0);
    const upkeep = formatMoney(town.upkeep || 0);
    const nextDayBalance = formatMoney((town.bank || 0) - (town.upkeep || 0));
    return `${prefix}${town.town} [${nation}] | bal-${bank} | upkeep - ${upkeep} | pending bal - ${nextDayBalance} | ${town.days_rounded} days`;
}

function buildTownFieldValue(towns) {
    if (towns.length === 0) {
        return 'No towns under 5 days.';
    }

    const maxLines = 20;
    const sortedTowns = [...towns].sort((a, b) => {
        const dayDiff = (a.days_rounded ?? Number.MAX_SAFE_INTEGER) - (b.days_rounded ?? Number.MAX_SAFE_INTEGER);
        if (dayDiff !== 0) return dayDiff;
        return (a.town || '').localeCompare(b.town || '');
    });
    const lines = sortedTowns.slice(0, maxLines).map(formatTownLine);
    if (sortedTowns.length > maxLines) {
        lines.push(`...and ${sortedTowns.length - maxLines} more.`);
    }

    return lines.join('\n');
}

let client = null;

async function startBot() {
    const config = getConfig();
    if (!config.discord_bot_token) {
        console.log('[Discord] No bot token provided. Skipping bot startup.');
        return;
    }

    const discord = getDiscordLib();
    if (!discord) {
        console.log('[Discord] Bot startup skipped because discord.js is not installed.');
        return;
    }

    const { Client, GatewayIntentBits } = discord;

    client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

    client.once('ready', () => {
        console.log(`[Discord] Logged in as ${client.user.tag}`);
    });

    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isStringSelectMenu()) return;

        if (interaction.customId === 'nation_report_select') {
            await handleNationReport(interaction);
        }
    });

    try {
        await client.login(config.discord_bot_token);
    } catch (err) {
        console.error('[Discord] Failed to login:', err.message);
    }
}

async function sendWebhookUpdate(townsData) {
    const config = getConfig();
    const webhookTargets = normalizeWebhookTargets(config.webhooks);
    const lowUpkeepTowns = townsData.filter((town) => town.days_rounded !== null && town.days_rounded <= 5);

    if (webhookTargets.length === 0) {
        console.log('[Discord] No webhooks configured.');
        return;
    }

    const discord = getDiscordLib();
    if (!discord) {
        console.log('[Discord] Webhook update skipped because discord.js is not installed.');
        return;
    }

    const { EmbedBuilder, WebhookClient } = discord;

    for (const target of webhookTargets) {
        const watchedNations = target.nations;
        const scopedTowns = watchedNations.length > 0
            ? lowUpkeepTowns.filter((town) => watchedNations.includes(town.nation))
            : lowUpkeepTowns;
        const pingTowns = scopedTowns.filter((town) => town.days_rounded <= 2);
        const scopeLabel = watchedNations.length > 0
            ? watchedNations.map(getNationCode).join(', ')
            : 'ALL';

        const embed = new EmbedBuilder()
            .setTitle('Daily Scrape Results')
            .setDescription(`Scraped ${townsData.length} towns. Watching: ${scopeLabel}`)
            .addFields({
                name: 'Towns with Low Upkeep',
                value: buildTownFieldValue(scopedTowns)
            })
            .setTimestamp();

        const payload = { embeds: [embed] };
        const roleMentions = [...new Set(
            pingTowns
                .map((town) => target.nation_roles?.[town.nation])
                .filter(Boolean)
                .map((roleId) => `<@&${roleId}>`)
        )];

        if (roleMentions.length > 0) {
            payload.content = roleMentions.join(' ');
        }

        try {
            const webhook = new WebhookClient({ url: target.url });
            await webhook.send(payload);
            console.log(`[Discord] Sent webhook update for ${scopeLabel}.`);
        } catch (err) {
            console.error(`[Discord] Webhook failed for ${scopeLabel}:`, err.message);
        }
    }
}

async function handleNationReport(interaction) {
    const discord = getDiscordLib();
    if (!discord) {
        await interaction.reply({ content: 'discord.js is not installed on the host.', ephemeral: true });
        return;
    }

    const { EmbedBuilder } = discord;
    const nation = interaction.values[0];
    const townsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'towns.json'), 'utf8')).towns;
    const nationTowns = townsData.filter((town) => town.nation === nation && town.days_rounded !== null && town.days_rounded <= 5);

    const embed = new EmbedBuilder()
        .setTitle(`Low Upkeep Report: ${nation}`)
        .setDescription(
            nationTowns.length > 0
                ? [...nationTowns]
                    .sort((a, b) => {
                        const dayDiff = (a.days_rounded ?? Number.MAX_SAFE_INTEGER) - (b.days_rounded ?? Number.MAX_SAFE_INTEGER);
                        if (dayDiff !== 0) return dayDiff;
                        return (a.town || '').localeCompare(b.town || '');
                    })
                    .map((town) => formatTownLine(town))
                    .join('\n')
                : 'No towns with <= 5 days upkeep found in this nation.'
        );

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function sendNationSelectMenu(message) {
    try {
        const discord = getDiscordLib();
        if (!discord) {
            await message.reply('discord.js is not installed on the host.');
            return;
        }

        const { ActionRowBuilder, StringSelectMenuBuilder } = discord;
        const townsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'towns.json'), 'utf8')).towns;
        const nations = [...new Set(townsData.map((town) => town.nation).filter(Boolean))].sort();

        const options = nations.slice(0, 25).map((nation) => ({
            label: nation.substring(0, 100),
            value: nation.substring(0, 100)
        }));

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('nation_report_select')
                .setPlaceholder('Select a nation')
                .addOptions(options)
        );

        await message.reply({ content: 'Use the dropdown list below to choose a nation.', components: [row] });
    } catch (err) {
        console.error('[Discord] Failed to send menu:', err);
        await message.reply('Failed to load nation data.');
    }
}

module.exports = { startBot, sendWebhookUpdate };
