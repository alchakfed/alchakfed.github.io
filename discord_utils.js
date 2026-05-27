const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig, saveConfig } = require('./config');

const TOWNS_PATH = path.join(__dirname, 'towns.json');
const STATE_PATH = path.join(__dirname, 'discord_state.json');
const REPORT_CUSTOM_ID_PREFIX = 'nation_report_select';
const TOWN_SELECT_CUSTOM_ID_PREFIX = 'town_select';
const TOWN_STATUS_CUSTOM_ID_PREFIX = 'town_status';
const TOWN_TOKEN_CUSTOM_ID_PREFIX = 'tt';
const RESCRAPE_CUSTOM_ID = 'rescrape_towns';
const MAX_FIELD_LENGTH = 1024;
const MAX_SELECT_ROWS = 5;
const TOWN_STATUS_TTL_MS = 2 * 24 * 60 * 60 * 1000;

let discordLib = null;
let discordLoadError = null;
let botClient = null;
let discordScrapeJob = null;

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

function normalizeTownsPayload(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.towns)) {
        throw new Error('Payload must be a JSON object with a towns array.');
    }

    return {
        scraped_at: payload.scraped_at || new Date().toISOString(),
        source: payload.source || null,
        towns: payload.towns
    };
}

function loadTownsPayload() {
    if (!fs.existsSync(TOWNS_PATH)) {
        return {
            scraped_at: null,
            source: null,
            towns: []
        };
    }

    return normalizeTownsPayload(JSON.parse(fs.readFileSync(TOWNS_PATH, 'utf8')));
}

function loadTownsData() {
    return loadTownsPayload().towns;
}

function saveTownsPayload(payload) {
    const normalized = normalizeTownsPayload(payload);
    fs.writeFileSync(TOWNS_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
}

function readState() {
    if (!fs.existsSync(STATE_PATH)) {
        return {
            report_messages: {},
            nation_menu_message: null,
            server_report_messages: {},
            server_nation_menu_messages: {},
            town_statuses: {},
            town_tokens: {}
        };
    }

    try {
        const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        const normalized = {
            report_messages: state.report_messages && typeof state.report_messages === 'object'
                ? state.report_messages
                : {},
            nation_menu_message: state.nation_menu_message && typeof state.nation_menu_message === 'object'
                ? state.nation_menu_message
                : null,
            server_report_messages: state.server_report_messages && typeof state.server_report_messages === 'object'
                ? state.server_report_messages
                : {},
            server_nation_menu_messages: state.server_nation_menu_messages && typeof state.server_nation_menu_messages === 'object'
                ? state.server_nation_menu_messages
                : {},
            town_statuses: state.town_statuses && typeof state.town_statuses === 'object'
                ? state.town_statuses
                : {},
            town_tokens: state.town_tokens && typeof state.town_tokens === 'object'
                ? state.town_tokens
                : {}
        };
        const changed = normalizeTownStatuses(normalized);
        if (changed) {
            saveState(normalized);
        }
        return normalized;
    } catch (error) {
        console.warn(`[Discord] Failed to parse discord_state.json: ${error.message}`);
        return {
            report_messages: {},
            nation_menu_message: null,
            server_report_messages: {},
            server_nation_menu_messages: {},
            town_statuses: {},
            town_tokens: {}
        };
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function normalizeTownStatuses(state, now = Date.now()) {
    let changed = false;
    state.town_statuses = state.town_statuses && typeof state.town_statuses === 'object'
        ? state.town_statuses
        : {};

    for (const [nation, towns] of Object.entries(state.town_statuses)) {
        if (!towns || typeof towns !== 'object' || Array.isArray(towns)) {
            delete state.town_statuses[nation];
            changed = true;
            continue;
        }

        for (const [townName, entry] of Object.entries(towns)) {
            if (entry === 'claim' || entry === 'fall') {
                towns[townName] = {
                    status: entry,
                    marked_at: new Date(now).toISOString()
                };
                changed = true;
                continue;
            }

            if (!entry || typeof entry !== 'object' || !['claim', 'fall'].includes(entry.status)) {
                delete towns[townName];
                changed = true;
                continue;
            }

            const markedAt = Date.parse(entry.marked_at || '');
            if (!Number.isFinite(markedAt) || now - markedAt >= TOWN_STATUS_TTL_MS) {
                delete towns[townName];
                changed = true;
            }
        }

        if (Object.keys(towns).length === 0) {
            delete state.town_statuses[nation];
            changed = true;
        }
    }

    return changed;
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

function normalizeDiscordServers(config) {
    const configuredServers = Array.isArray(config.discord_servers)
        ? config.discord_servers
        : [];

    const servers = configuredServers
        .map((entry, index) => {
            if (!entry || typeof entry !== 'object') {
                return null;
            }

            const guildId = String(entry.guild_id || entry.discord_guild_id || '').trim();
            const channelId = String(entry.upkeep_channel_id || entry.channel_id || '').trim();
            if (!guildId && !channelId) {
                return null;
            }

            return {
                key: String(entry.id || guildId || channelId || `server_${index}`).trim(),
                guild_id: guildId,
                upkeep_channel_id: channelId,
                default_watched_nations: Array.isArray(entry.default_watched_nations)
                    ? entry.default_watched_nations
                    : config.default_watched_nations,
                nation_role_ids: entry.nation_role_ids && typeof entry.nation_role_ids === 'object'
                    ? entry.nation_role_ids
                    : config.nation_role_ids,
                ping_role_id: entry.ping_role_id || config.ping_role_id || ''
            };
        })
        .filter(Boolean);

    if (servers.length > 0) {
        return servers;
    }

    return [{
        key: 'default',
        guild_id: String(config.discord_guild_id || '').trim(),
        upkeep_channel_id: String(config.upkeep_channel_id || '').trim(),
        default_watched_nations: config.default_watched_nations,
        nation_role_ids: config.nation_role_ids,
        ping_role_id: config.ping_role_id || ''
    }];
}

function getServerStateKey(serverConfig = {}) {
    return String(serverConfig.key || serverConfig.guild_id || serverConfig.upkeep_channel_id || 'default');
}

function getServerForInteraction(config, interaction) {
    const servers = normalizeDiscordServers(config);
    return servers.find((server) => server.guild_id && server.guild_id === interaction.guildId)
        || servers.find((server) => server.upkeep_channel_id && server.upkeep_channel_id === interaction.channelId)
        || {
            key: interaction.guildId || interaction.channelId || 'default',
            guild_id: interaction.guildId || '',
            upkeep_channel_id: interaction.channelId || '',
            default_watched_nations: config.default_watched_nations,
            nation_role_ids: config.nation_role_ids,
            ping_role_id: config.ping_role_id || ''
        };
}

function getScopedReportMessages(state, serverConfig) {
    const key = getServerStateKey(serverConfig);
    if (key === 'default') {
        return state.report_messages || {};
    }

    state.server_report_messages = state.server_report_messages || {};
    state.server_report_messages[key] = state.server_report_messages[key] || {};
    return state.server_report_messages[key];
}

function setScopedReportMessage(state, serverConfig, nation, ref) {
    const reports = getScopedReportMessages(state, serverConfig);
    reports[nation] = ref;
}

function getScopedMenuMessage(state, serverConfig) {
    const key = getServerStateKey(serverConfig);
    if (key === 'default') {
        return state.nation_menu_message || null;
    }

    state.server_nation_menu_messages = state.server_nation_menu_messages || {};
    return state.server_nation_menu_messages[key] || null;
}

function setScopedMenuMessage(state, serverConfig, ref) {
    const key = getServerStateKey(serverConfig);
    if (key === 'default') {
        state.nation_menu_message = ref;
        return;
    }

    state.server_nation_menu_messages = state.server_nation_menu_messages || {};
    state.server_nation_menu_messages[key] = ref;
}

function getWatchedNations(config, townsData, serverConfig = null) {
    const source = serverConfig || config;
    const explicit = Array.isArray(source.default_watched_nations)
        ? source.default_watched_nations.map((nation) => String(nation).trim()).filter(Boolean)
        : [];

    if (explicit.length > 0) {
        return [...new Set(explicit)];
    }

    const configuredRoles = source.nation_role_ids && typeof source.nation_role_ids === 'object'
        ? Object.keys(source.nation_role_ids).map((nation) => String(nation).trim()).filter(Boolean)
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

function getTownStatus(state, nation, townName) {
    const entry = state.town_statuses?.[nation]?.[townName] || null;
    if (!entry) {
        return null;
    }

    if (typeof entry === 'string') {
        return entry;
    }

    return entry.status || null;
}

function getTownStatusMarker(status) {
    if (status === 'claim') {
        return '\u2705';
    }

    if (status === 'fall') {
        return '\u274c';
    }

    return null;
}

function formatTownLine(town, state = readState()) {
    const savedMarker = getTownStatusMarker(getTownStatus(state, town.nation, town.town));
    const marker = savedMarker || (town.days_rounded !== null && town.days_rounded <= 2
        ? '[CRITICAL]'
        : town.days_rounded !== null && town.days_rounded <= 5
            ? '[WATCH]'
            : '[OK]');

    return `${marker} **${town.town}** | ${formatDays(town.days_rounded)} | bank $${formatMoney(town.bank)} | upkeep $${formatMoney(town.upkeep)}`;
}

function buildNationEmbed(discord, nation, townsData, state = readState()) {
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
        .setFooter({ text: 'Updated automatically from synced towns data' })
        .setTimestamp();

    embed.addFields(
        {
            name: 'Critical (<= 2 days)',
            value: trimFieldValue(stats.critical.map((town) => formatTownLine(town, state)), 'No critical towns right now.')
        },
        {
            name: 'Watchlist (3-5 days)',
            value: trimFieldValue(stats.warning.map((town) => formatTownLine(town, state)), 'No towns in the 3-5 day range.')
        },
        {
            name: 'Lowest Buffers Overall',
            value: trimFieldValue(stats.lowestBuffers.map((town) => formatTownLine(town, state)), 'No towns found for this nation.')
        }
    );

    return embed;
}

function encodeCustomPart(value) {
    return Buffer.from(String(value), 'utf8').toString('base64url');
}

function decodeCustomPart(value) {
    return Buffer.from(String(value), 'base64url').toString('utf8');
}

function getTownToken(nation, townName) {
    const encoded = encodeCustomPart(`${nation}\n${townName}`);
    return encoded.slice(0, 48);
}

function rememberTownToken(state, nation, townName) {
    state.town_tokens = state.town_tokens || {};
    const token = getTownToken(nation, townName);
    state.town_tokens[token] = { nation, town: townName };
    saveState(state);
    return token;
}

function resolveTownToken(state, token) {
    return state.town_tokens?.[token] || null;
}

function getNationTowns(townsData, nation) {
    return townsData
        .filter((town) => town.nation === nation)
        .sort((left, right) => String(left.town || '').localeCompare(String(right.town || '')));
}

function buildTownSelectRows(discord, nation, townsData) {
    const { ActionRowBuilder, StringSelectMenuBuilder } = discord;
    const nationTowns = getNationTowns(townsData, nation);
    const encodedNation = encodeCustomPart(nation);

    return chunkItems(nationTowns, 25).slice(0, MAX_SELECT_ROWS).map((chunk, index) =>
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${TOWN_SELECT_CUSTOM_ID_PREFIX}:${encodedNation}:${index}`)
                .setPlaceholder(index === 0 ? `Select a ${prettifyNationName(nation)} town` : `More towns (${index + 1})`)
                .addOptions(
                    chunk.map((town) => ({
                        label: String(town.town || 'Unknown').slice(0, 100),
                        value: String(town.town || '').slice(0, 100),
                        description: `${formatDays(town.days_rounded)} | bank $${formatMoney(town.bank)} | upkeep $${formatMoney(town.upkeep)}`.slice(0, 100)
                    }))
                )
        )
    );
}

function buildNationReportPayload(discord, nation, townsData, state = readState()) {
    return {
        embeds: [buildNationEmbed(discord, nation, townsData, state)],
        components: buildTownSelectRows(discord, nation, townsData)
    };
}

function findTown(townsData, nation, townName) {
    return townsData.find((town) => town.nation === nation && town.town === townName);
}

function getPendingBalance(town) {
    return Number(town.bank || 0) - Number(town.upkeep || 0);
}

function buildTownDetailPayload(discord, nation, town, state = readState(), options = {}) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = discord;
    const token = rememberTownToken(state, nation, town.town);
    const status = getTownStatus(state, nation, town.town);
    const statusLabel = status === 'claim' ? 'Claimed' : status === 'fall' ? 'Falling' : 'Unmarked';

    const embed = new EmbedBuilder()
        .setTitle(`${town.town} Details`)
        .setColor(status === 'fall' ? 0xe74c3c : status === 'claim' ? 0x2ecc71 : 0x3498db)
        .setDescription([
            `**Nation:** ${prettifyNationName(nation)}`,
            `**Days:** ${formatDays(town.days_rounded)}`,
            `**Bank:** $${formatMoney(town.bank)}`,
            `**Upkeep:** $${formatMoney(town.upkeep)}`,
            `**Pending balance:** $${formatMoney(getPendingBalance(town))}`,
            `**Status:** ${statusLabel}`
        ].join('\n'))
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${TOWN_STATUS_CUSTOM_ID_PREFIX}:claim:${token}`)
            .setLabel('Claim')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`${TOWN_STATUS_CUSTOM_ID_PREFIX}:fall:${token}`)
            .setLabel('Fall')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`${TOWN_STATUS_CUSTOM_ID_PREFIX}:clear:${token}`)
            .setLabel('Unclaim')
            .setStyle(ButtonStyle.Secondary)
    );

    const payload = {
        embeds: [embed],
        components: [row]
    };

    if (options.ephemeral !== false) {
        payload.ephemeral = true;
    }

    return payload;
}

function buildNationSelectRows(discord, townsData, watchedNations, maxRows = MAX_SELECT_ROWS) {
    const { ActionRowBuilder, StringSelectMenuBuilder } = discord;
    const watched = new Set(watchedNations);
    const otherNations = getAllNationNames(townsData).filter((nation) => !watched.has(nation));

    return chunkItems(otherNations, 25).slice(0, maxRows).map((chunk, index) =>
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
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = discord;
    const rows = buildNationSelectRows(discord, townsData, watchedNations, MAX_SELECT_ROWS - 1);
    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(RESCRAPE_CUSTOM_ID)
            .setLabel('Rescrape towns')
            .setStyle(ButtonStyle.Primary)
    );

    return {
        content: rows.length > 0
            ? 'Use the dropdown menus below to view the latest report for any non-preset nation.'
            : 'All available nations are already covered by the preset watched reports.',
        components: [...rows, buttonRow]
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
        const guildIds = [...new Set(normalizeDiscordServers(config).map((server) => server.guild_id).filter(Boolean))];
        if (guildIds.length > 0) {
            for (const guildId of guildIds) {
                const guild = await client.guilds.fetch(guildId);
                await guild.commands.set(commands);
                console.log(`[Discord] Registered /configure for guild ${guildId}.`);
            }
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
    const serverConfig = getServerForInteraction(config, interaction);
    const watchedNations = getWatchedNations(config, townsData, serverConfig);

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
        report_messages: { ...state.report_messages },
        server_report_messages: { ...state.server_report_messages },
        server_nation_menu_messages: { ...state.server_nation_menu_messages }
    };
    const scopedReports = getScopedReportMessages(state, serverConfig);

    for (const nation of watchedNations) {
        const existingRef = scopedReports?.[nation]?.channel_id === interaction.channelId
            ? scopedReports[nation]
            : null;
        const sent = await upsertMessage(interaction.channel, existingRef, buildNationReportPayload(discord, nation, townsData, state));
        setScopedReportMessage(updatedState, serverConfig, nation, {
            channel_id: interaction.channelId,
            message_id: sent.id
        });
    }

    const menuPayload = buildNationMenuPayload(discord, townsData, watchedNations);
    const currentMenu = getScopedMenuMessage(state, serverConfig);
    const existingMenu = currentMenu?.channel_id === interaction.channelId
        ? currentMenu
        : null;
    const menuMessage = await upsertMessage(interaction.channel, existingMenu, menuPayload);
    setScopedMenuMessage(updatedState, serverConfig, {
        channel_id: interaction.channelId,
        message_id: menuMessage.id
    });

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

async function handleTownSelect(interaction) {
    const discord = getDiscordLib();
    if (!discord) {
        await interaction.reply({ content: 'discord.js is not installed on the host.', ephemeral: true });
        return;
    }

    const [, encodedNation] = interaction.customId.split(':');
    const nation = decodeCustomPart(encodedNation);
    const townName = interaction.values[0];
    const townsData = loadTownsData();
    const town = findTown(townsData, nation, townName);

    if (!town) {
        await interaction.reply({ content: 'That town is no longer present in the latest town data.', ephemeral: true });
        return;
    }

    await interaction.reply(buildTownDetailPayload(discord, nation, town));
}

async function refreshNationReportMessage(client, nation, townsData, state) {
    const discord = getDiscordLib();
    const ref = state.report_messages?.[nation];
    if (!discord || !ref?.channel_id || !ref?.message_id) {
        return false;
    }

    const channel = await fetchTextChannel(client, ref.channel_id);
    if (!channel) {
        return false;
    }

    const message = await channel.messages.fetch(ref.message_id);
    await message.edit(buildNationReportPayload(discord, nation, townsData, state));
    return true;
}

async function refreshNationReportMessages(client, nation, townsData, state) {
    const discord = getDiscordLib();
    if (!discord) {
        return 0;
    }

    const refs = [];
    if (state.report_messages?.[nation]) {
        refs.push(state.report_messages[nation]);
    }

    for (const reports of Object.values(state.server_report_messages || {})) {
        if (reports?.[nation]) {
            refs.push(reports[nation]);
        }
    }

    let refreshed = 0;
    for (const ref of refs) {
        if (!ref?.channel_id || !ref?.message_id) {
            continue;
        }

        const channel = await fetchTextChannel(client, ref.channel_id);
        if (!channel) {
            continue;
        }

        const message = await channel.messages.fetch(ref.message_id);
        await message.edit(buildNationReportPayload(discord, nation, townsData, state));
        refreshed += 1;
    }

    return refreshed;
}

async function refreshAllReportMessages(client, townsData, state) {
    const discord = getDiscordLib();
    if (!discord) {
        return 0;
    }

    const refs = [
        ...Object.entries(state.report_messages || {}).map(([nation, ref]) => ({ nation, ref })),
        ...Object.values(state.server_report_messages || {})
            .flatMap((reports) => Object.entries(reports || {}).map(([nation, ref]) => ({ nation, ref })))
    ];

    let refreshed = 0;
    for (const { nation, ref } of refs) {
        if (!ref?.channel_id || !ref?.message_id) {
            continue;
        }

        const channel = await fetchTextChannel(client, ref.channel_id);
        if (!channel) {
            continue;
        }

        const message = await channel.messages.fetch(ref.message_id);
        await message.edit(buildNationReportPayload(discord, nation, townsData, state));
        refreshed += 1;
    }

    return refreshed;
}

async function handleTownStatusButton(interaction) {
    const discord = getDiscordLib();
    if (!discord) {
        await interaction.reply({ content: 'discord.js is not installed on the host.', ephemeral: true });
        return;
    }

    const [, status, token] = interaction.customId.split(':');
    const tokenState = readState();
    const tokenEntry = resolveTownToken(tokenState, token);
    if (!tokenEntry) {
        await interaction.reply({ content: 'That town action expired. Select the town again from the dropdown.', ephemeral: true });
        return;
    }

    const nation = tokenEntry.nation;
    const townName = tokenEntry.town;
    const townsData = loadTownsData();
    const town = findTown(townsData, nation, townName);

    if (!town) {
        await interaction.reply({ content: 'That town is no longer present in the latest town data.', ephemeral: true });
        return;
    }

    const state = readState();
    state.town_statuses = state.town_statuses || {};
    state.town_statuses[nation] = state.town_statuses[nation] || {};
    if (status === 'clear') {
        delete state.town_statuses[nation][townName];
        if (Object.keys(state.town_statuses[nation]).length === 0) {
            delete state.town_statuses[nation];
        }
    } else {
        state.town_statuses[nation][townName] = {
            status: status === 'fall' ? 'fall' : 'claim',
            marked_at: new Date().toISOString()
        };
    }
    saveState(state);

    try {
        await refreshNationReportMessages(interaction.client, nation, townsData, state);
    } catch (error) {
        console.warn(`[Discord] Failed to refresh report for ${nation}/${townName}: ${error.message}`);
    }

    await interaction.update(buildTownDetailPayload(discord, nation, town, state, { ephemeral: false }));
}

function runScraperProcess() {
    return new Promise((resolve, reject) => {
        const child = spawn('node', ['scraper.js'], {
            cwd: __dirname,
            shell: true
        });

        let stderrData = '';

        child.stderr.on('data', (data) => {
            stderrData += data.toString();
        });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(stderrData || `scraper.js exited with code ${code}`));
        });
    });
}

async function handleRescrapeButton(interaction) {
    if (discordScrapeJob) {
        await interaction.reply({ content: 'A town scrape is already running. Try again in a minute.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    discordScrapeJob = runScraperProcess();

    try {
        await discordScrapeJob;
        const townsData = loadTownsData();
        const config = getConfig();
        config.last_run = new Date().toISOString().split('T')[0];
        saveConfig(config);
        await syncBotMessages(townsData);
        await interaction.editReply({ content: `Rescraped ${townsData.length} towns and refreshed the Discord reports.` });
    } catch (error) {
        await interaction.editReply({ content: `Rescrape failed: ${error.message || error}` });
    } finally {
        discordScrapeJob = null;
    }
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

async function getDeliveryClient(config) {
    if (botClient?.isReady()) {
        return {
            client: botClient,
            destroyWhenDone: false
        };
    }

    return {
        client: await createTransientClient(config),
        destroyWhenDone: true
    };
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
    const serverConfigs = normalizeDiscordServers(config);
    const delivery = await getDeliveryClient(config);
    const client = delivery.client;
    let stateChanged = false;

    try {
        for (const serverConfig of serverConfigs) {
            const watchedNations = getWatchedNations(config, townsData, serverConfig);
            const scopedReports = getScopedReportMessages(state, serverConfig);
            const serverKey = getServerStateKey(serverConfig);

            for (const nation of watchedNations) {
                const channelId = scopedReports?.[nation]?.channel_id || serverConfig.upkeep_channel_id;
                const channel = await fetchTextChannel(client, channelId);

                if (!channel) {
                    console.warn(`[Discord] No text channel available for ${nation} on ${serverKey}.`);
                    continue;
                }

                const sent = await upsertMessage(channel, scopedReports?.[nation], buildNationReportPayload(discord, nation, townsData, state));

                if (!scopedReports[nation] || scopedReports[nation].message_id !== sent.id || scopedReports[nation].channel_id !== channel.id) {
                    setScopedReportMessage(state, serverConfig, nation, {
                        channel_id: channel.id,
                        message_id: sent.id
                    });
                    stateChanged = true;
                }
            }

            const currentMenu = getScopedMenuMessage(state, serverConfig);
            const menuChannelId = currentMenu?.channel_id || serverConfig.upkeep_channel_id;
            const menuChannel = await fetchTextChannel(client, menuChannelId);
            if (menuChannel) {
                const payload = buildNationMenuPayload(discord, townsData, watchedNations);
                const sent = await upsertMessage(menuChannel, currentMenu, payload);

                if (!currentMenu || currentMenu.message_id !== sent.id || currentMenu.channel_id !== sent.channelId) {
                    setScopedMenuMessage(state, serverConfig, {
                        channel_id: sent.channelId,
                        message_id: sent.id
                    });
                    stateChanged = true;
                }
            }
        }
    } finally {
        if (delivery.destroyWhenDone && client) {
            await client.destroy();
        }
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

async function processIncomingTownsPayload(payload) {
    const normalized = saveTownsPayload(payload);
    await runDiscordDelivery(normalized.towns);
    return normalized;
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
                return;
            }

            if (interaction.isStringSelectMenu() && interaction.customId.startsWith(TOWN_SELECT_CUSTOM_ID_PREFIX)) {
                await handleTownSelect(interaction);
                return;
            }

            if (interaction.isButton() && interaction.customId.startsWith(TOWN_STATUS_CUSTOM_ID_PREFIX)) {
                await handleTownStatusButton(interaction);
                return;
            }

            if (interaction.isButton() && interaction.customId === RESCRAPE_CUSTOM_ID) {
                await handleRescrapeButton(interaction);
            }
        } catch (error) {
            console.error(`[Discord] Interaction failed (${interaction.type}:${interaction.customId || interaction.commandName || 'unknown'}): ${error.stack || error.message}`);
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
    loadTownsPayload,
    processIncomingTownsPayload,
    saveTownsPayload,
    startBot,
    sendWebhookUpdate: runDiscordDelivery,
    STATE_PATH
};
