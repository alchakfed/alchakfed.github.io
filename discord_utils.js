const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

const TOWNS_PATH = path.join(__dirname, 'towns.json');
const STATE_PATH = path.join(__dirname, 'discord_state.json');
const REPORT_CUSTOM_ID_PREFIX = 'nation_report_select';
const MAX_FIELD_LENGTH = 1024;

let discordLib = null;
let discordLoadError = null;
let botClient = null;

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
    } catch (error) {
        discordLoadError = error;
        console.warn(`[Discord] discord.js is unavailable: ${error.message}`);
        return null;
    }
}

function getConfig() {
    return loadConfig();
}

function loadTownsData() {
    if (!fs.existsSync(TOWNS_PATH)) {
        return [];
    }

    return JSON.parse(fs.readFileSync(TOWNS_PATH, 'utf8')).towns || [];
}

function readState() {
    if (!fs.existsSync(STATE_PATH)) {
        return {
            report_messages: {},
            nation_menu_message: null
        };
    }

    try {
        const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        return {
            report_messages: state.report_messages && typeof state.report_messages === 'object'
                ? state.report_messages
                : {},
            nation_menu_message: state.nation_menu_message && typeof state.nation_menu_message === 'object'
                ? state.nation_menu_message
                : null
        };
    } catch (error) {
        console.warn(`[Discord] Failed to parse discord_state.json: ${error.message}`);
        return {
            report_messages: {},
            nation_menu_message: null
        };
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function formatMoney(amount) {
    return Number(amount || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function prettifyNationName(name) {
    return String(name || 'Independent')
        .split('_')
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function formatDays(days) {
    if (days === null || days === undefined) {
        return 'n/a';
    }

    return `${days}d`;
}

function getNationColor(stats) {
    if (stats.critical.length > 0) {
        return 0xe74c3c;
    }

    if (stats.warning.length > 0) {
        return 0xf39c12;
    }

    return 0x2ecc71;
}

function chunkItems(items, size) {
    const result = [];
    for (let index = 0; index < items.length; index += size) {
        result.push(items.slice(index, index + size));
    }
    return result;
}

function trimFieldValue(lines, fallback = 'Nothing to show.') {
    if (!Array.isArray(lines) || lines.length === 0) {
        return fallback;
    }

    const collected = [];
    for (const line of lines) {
        const next = collected.length === 0 ? line : `${collected.join('\n')}\n${line}`;
        if (next.length > MAX_FIELD_LENGTH) {
            break;
        }
        collected.push(line);
    }

    return collected.length > 0 ? collected.join('\n') : fallback;
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

function getAllNationNames(townsData) {
    return [...new Set(townsData.map((town) => town.nation).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function getWatchedNations(config, townsData) {
    const explicit = Array.isArray(config.default_watched_nations)
        ? config.default_watched_nations.map((nation) => String(nation).trim()).filter(Boolean)
        : [];

    if (explicit.length > 0) {
        return [...new Set(explicit)];
    }

    const configuredRoles = config.nation_role_ids && typeof config.nation_role_ids === 'object'
        ? Object.keys(config.nation_role_ids).map((nation) => String(nation).trim()).filter(Boolean)
        : [];

    if (configuredRoles.length > 0) {
        return [...new Set(configuredRoles)];
    }

    const webhookNations = normalizeWebhookTargets(config.webhooks)
        .flatMap((entry) => entry.nations || [])
        .map((nation) => String(nation).trim())
        .filter(Boolean);

    if (webhookNations.length > 0) {
        return [...new Set(webhookNations)];
    }

    return getAllNationNames(townsData).slice(0, 5);
}

function getNationStats(townsData, nation) {
    const nationTowns = townsData
        .filter((town) => town.nation === nation)
        .sort((left, right) => {
            const leftDays = left.days_rounded ?? Number.MAX_SAFE_INTEGER;
            const rightDays = right.days_rounded ?? Number.MAX_SAFE_INTEGER;
            if (leftDays !== rightDays) {
                return leftDays - rightDays;
            }
            return String(left.town || '').localeCompare(String(right.town || ''));
        });

    const critical = nationTowns.filter((town) => town.days_rounded !== null && town.days_rounded <= 2);
    const warning = nationTowns.filter((town) => town.days_rounded !== null && town.days_rounded >= 3 && town.days_rounded <= 5);
    const lowestBuffers = nationTowns.slice(0, 8);
    const totalBank = nationTowns.reduce((sum, town) => sum + Number(town.bank || 0), 0);
    const totalUpkeep = nationTowns.reduce((sum, town) => sum + Number(town.upkeep || 0), 0);

    return {
        nationTowns,
        critical,
        warning,
        lowestBuffers,
        totalBank,
        totalUpkeep
    };
}

function formatTownLine(town) {
    const emoji = town.days_rounded !== null && town.days_rounded <= 2
        ? '🚨'
        : town.days_rounded !== null && town.days_rounded <= 5
            ? '⚠️'
            : '•';

    return `${emoji} **${town.town}** • ${formatDays(town.days_rounded)} • bank $${formatMoney(town.bank)} • upkeep $${formatMoney(town.upkeep)}`;
}

function buildNationEmbed(discord, nation, townsData) {
    const { EmbedBuilder } = discord;
    const stats = getNationStats(townsData, nation);
    const riskCount = stats.critical.length + stats.warning.length;
    const lowestTown = stats.lowestBuffers[0];

    const embed = new EmbedBuilder()
        .setTitle(`${prettifyNationName(nation)} Status`)
        .setColor(getNationColor(stats))
        .setDescription([
            `**Towns:** ${stats.nationTowns.length}`,
            `**At risk:** ${riskCount}`,
            `**Total bank:** $${formatMoney(stats.totalBank)}`,
            `**Daily upkeep:** $${formatMoney(stats.totalUpkeep)}`,
            `**Lowest buffer:** ${lowestTown ? `${lowestTown.town} (${formatDays(lowestTown.days_rounded)})` : 'n/a'}`
        ].join('\n'))
        .setFooter({ text: 'Updated automatically from towns.json' })
        .setTimestamp();

    embed.addFields(
        {
            name: 'Critical (<= 2 days)',
            value: trimFieldValue(stats.critical.map(formatTownLine), 'No critical towns right now.')
        },
        {
            name: 'Watchlist (3-5 days)',
            value: trimFieldValue(stats.warning.map(formatTownLine), 'No towns in the 3-5 day range.')
        },
        {
            name: 'Lowest Buffers Overall',
            value: trimFieldValue(stats.lowestBuffers.map(formatTownLine), 'No towns found for this nation.')
        }
    );

    return embed;
}

function buildNationSelectRows(discord, townsData, watchedNations) {
    const { ActionRowBuilder, StringSelectMenuBuilder } = discord;
    const watched = new Set(watchedNations);
    const otherNations = getAllNationNames(townsData).filter((nation) => !watched.has(nation));

    return chunkItems(otherNations, 25).slice(0, 5).map((chunk, index) =>
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${REPORT_CUSTOM_ID_PREFIX}:${index}`)
                .setPlaceholder(index === 0 ? 'Browse other nations' : `More nations (${index + 1})`)
                .addOptions(
                    chunk.map((nation) => ({
                        label: prettifyNationName(nation).slice(0, 100),
                        value: nation.slice(0, 100),
                        description: 'Show the latest status for this nation.'
                    }))
                )
        )
    );
}

function buildNationMenuPayload(discord, townsData, watchedNations) {
    const rows = buildNationSelectRows(discord, townsData, watchedNations);

    return {
        content: rows.length > 0
            ? 'Use the dropdown menus below to view the latest report for any non-preset nation.'
            : 'All available nations are already covered by the preset watched reports.',
        components: rows
    };
}

async function registerCommands(client, config) {
    const commands = [
        {
            name: 'configure',
            description: 'Create or refresh the preset nation report messages in this channel.'
        }
    ];

    try {
        if (config.discord_guild_id) {
            const guild = await client.guilds.fetch(config.discord_guild_id);
            await guild.commands.set(commands);
            console.log(`[Discord] Registered /configure for guild ${config.discord_guild_id}.`);
            return;
        }

        await client.application.commands.set(commands);
        console.log('[Discord] Registered /configure globally.');
    } catch (error) {
        console.error(`[Discord] Failed to register slash commands: ${error.message}`);
    }
}

async function fetchTextChannel(client, channelId) {
    if (!channelId) {
        return null;
    }

    const channel = await client.channels.fetch(channelId);
    return channel && channel.isTextBased() ? channel : null;
}

async function upsertMessage(channel, existingRef, payload) {
    if (existingRef && existingRef.message_id) {
        try {
            const existing = await channel.messages.fetch(existingRef.message_id);
            await existing.edit(payload);
            return existing;
        } catch (error) {
            console.warn(`[Discord] Failed to edit message ${existingRef.message_id}: ${error.message}`);
        }
    }

    return channel.send(payload);
}

async function configureReportsInChannel(interaction) {
    const discord = getDiscordLib();
    const config = getConfig();
    const townsData = loadTownsData();
    const watchedNations = getWatchedNations(config, townsData);

    if (!interaction.channel || !interaction.channel.isTextBased()) {
        await interaction.reply({ content: 'This command needs to be used in a text channel.', ephemeral: true });
        return;
    }

    if (watchedNations.length === 0) {
        await interaction.reply({ content: 'No watched nations are configured yet.', ephemeral: true });
        return;
    }

    const state = readState();
    const updatedState = {
        ...state,
        report_messages: { ...state.report_messages }
    };

    for (const nation of watchedNations) {
        const embed = buildNationEmbed(discord, nation, townsData);
        const existingRef = state.report_messages?.[nation]?.channel_id === interaction.channelId
            ? state.report_messages[nation]
            : null;
        const sent = await upsertMessage(interaction.channel, existingRef, { embeds: [embed] });
        updatedState.report_messages[nation] = {
            channel_id: interaction.channelId,
            message_id: sent.id
        };
    }

    const menuPayload = buildNationMenuPayload(discord, townsData, watchedNations);
    const existingMenu = state.nation_menu_message?.channel_id === interaction.channelId
        ? state.nation_menu_message
        : null;
    const menuMessage = await upsertMessage(interaction.channel, existingMenu, menuPayload);
    updatedState.nation_menu_message = {
        channel_id: interaction.channelId,
        message_id: menuMessage.id
    };

    saveState(updatedState);

    await interaction.reply({
        content: `Configured ${watchedNations.length} preset nation reports and refreshed the nation picker in <#${interaction.channelId}>.`,
        ephemeral: true
    });
}

async function handleNationReport(interaction) {
    const discord = getDiscordLib();
    if (!discord) {
        await interaction.reply({ content: 'discord.js is not installed on the host.', ephemeral: true });
        return;
    }

    const townsData = loadTownsData();
    const nation = interaction.values[0];
    const embed = buildNationEmbed(discord, nation, townsData);

    await interaction.reply({
        embeds: [embed],
        ephemeral: true
    });
}

async function createTransientClient(config) {
    const discord = getDiscordLib();
    if (!discord) {
        return null;
    }

    const { Client, GatewayIntentBits } = discord;
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(config.discord_bot_token);
    await new Promise((resolve) => {
        if (client.isReady()) {
            resolve();
            return;
        }

        client.once('ready', resolve);
    });

    return client;
}

async function syncBotMessages(townsData) {
    const config = getConfig();
    if (!config.discord_bot_token) {
        console.log('[Discord] No bot token provided. Skipping bot message sync.');
        return;
    }

    const discord = getDiscordLib();
    if (!discord) {
        console.log('[Discord] Bot sync skipped because discord.js is not installed.');
        return;
    }

    const state = readState();
    const watchedNations = getWatchedNations(config, townsData);
    const client = await createTransientClient(config);
    let stateChanged = false;

    try {
        for (const nation of watchedNations) {
            const channelId = state.report_messages?.[nation]?.channel_id || config.upkeep_channel_id;
            const channel = await fetchTextChannel(client, channelId);

            if (!channel) {
                console.warn(`[Discord] No text channel available for ${nation}.`);
                continue;
            }

            const embed = buildNationEmbed(discord, nation, townsData);
            const sent = await upsertMessage(channel, state.report_messages?.[nation], { embeds: [embed] });

            if (!state.report_messages[nation] || state.report_messages[nation].message_id !== sent.id || state.report_messages[nation].channel_id !== channel.id) {
                state.report_messages[nation] = {
                    channel_id: channel.id,
                    message_id: sent.id
                };
                stateChanged = true;
            }
        }

        const menuChannelId = state.nation_menu_message?.channel_id || config.upkeep_channel_id;
        const menuChannel = await fetchTextChannel(client, menuChannelId);
        if (menuChannel) {
            const payload = buildNationMenuPayload(discord, townsData, watchedNations);
            const sent = await upsertMessage(menuChannel, state.nation_menu_message, payload);

            if (!state.nation_menu_message || state.nation_menu_message.message_id !== sent.id || state.nation_menu_message.channel_id !== sent.channelId) {
                state.nation_menu_message = {
                    channel_id: sent.channelId,
                    message_id: sent.id
                };
                stateChanged = true;
            }
        }
    } finally {
        await client.destroy();
    }

    if (stateChanged) {
        saveState(state);
    }

    console.log('[Discord] Bot messages synced.');
}

async function sendWebhookUpdate(townsData) {
    const config = getConfig();
    const webhookTargets = normalizeWebhookTargets(config.webhooks);

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
            ? townsData.filter((town) => watchedNations.includes(town.nation) && town.days_rounded !== null && town.days_rounded <= 5)
            : townsData.filter((town) => town.days_rounded !== null && town.days_rounded <= 5);
        const criticalCount = scopedTowns.filter((town) => town.days_rounded <= 2).length;

        const embed = new EmbedBuilder()
            .setTitle('Daily Upkeep Watch')
            .setColor(criticalCount > 0 ? 0xe74c3c : 0xf39c12)
            .setDescription(`Watching ${watchedNations.length > 0 ? watchedNations.map(prettifyNationName).join(', ') : 'all nations'}`)
            .addFields({
                name: 'At-Risk Towns',
                value: trimFieldValue(scopedTowns.slice(0, 20).map(formatTownLine), 'No towns are at or below 5 days right now.')
            })
            .setTimestamp();

        const payload = { embeds: [embed] };

        try {
            const webhook = new WebhookClient({ url: target.url });
            await webhook.send(payload);
            console.log('[Discord] Sent webhook update.');
        } catch (error) {
            console.error(`[Discord] Webhook failed: ${error.message}`);
        }
    }
}

async function runDiscordDelivery(townsData) {
    await syncBotMessages(townsData);
    await sendWebhookUpdate(townsData);
}

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

    botClient = new Client({ intents: [GatewayIntentBits.Guilds] });

    botClient.once('ready', async () => {
        console.log(`[Discord] Logged in as ${botClient.user.tag}`);
        await registerCommands(botClient, config);
    });

    botClient.on('interactionCreate', async (interaction) => {
        try {
            if (interaction.isChatInputCommand() && interaction.commandName === 'configure') {
                await configureReportsInChannel(interaction);
                return;
            }

            if (interaction.isStringSelectMenu() && interaction.customId.startsWith(REPORT_CUSTOM_ID_PREFIX)) {
                await handleNationReport(interaction);
            }
        } catch (error) {
            console.error(`[Discord] Interaction failed: ${error.message}`);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'Something went wrong while processing that Discord action.', ephemeral: true });
            }
        }
    });

    try {
        await botClient.login(config.discord_bot_token);
    } catch (error) {
        console.error(`[Discord] Failed to login: ${error.message}`);
    }
}

module.exports = {
    startBot,
    sendWebhookUpdate: runDiscordDelivery,
    STATE_PATH
};
