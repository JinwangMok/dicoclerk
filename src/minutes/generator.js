/**
 * Meeting Minutes Generator Pipeline
 *
 * Orchestrates the end-to-end minutes generation flow:
 * 1. Receives transcript + session metadata
 * 2. Formats structured meeting minutes (Markdown)
 * 3. Saves the minutes file to disk
 * 4. Sends the file to the Discord text channel
 *
 * Designed to complete within 1~2 minutes of session end.
 * Runs as a fire-and-forget async pipeline — errors are logged
 * and reported to the text channel, never thrown to the caller.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatMeetingMinutes, generateMinutesFilename } from './formatter.js';
import { addEntry as addIndexEntry } from './index-store.js';
import { AttachmentBuilder } from 'discord.js';

/** Directory for storing generated minutes */
const DATA_DIR = join(process.cwd(), 'data');
const MINUTES_DIR = join(DATA_DIR, 'minutes');

/** SLA timeout for the full minutes generation pipeline (2 minutes) */
const GENERATION_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * @typedef {Object} GeneratorInput
 * @property {Array<Object>} transcript     - Transcript entries from the session
 * @property {Object} session               - SessionInfo from SessionManager
 * @property {Object} [transcriptResult]    - Result from AudioSessionCoordinator.stop()
 * @property {import('discord.js').Client} client - Discord client for channel access
 * @property {string} reason                - Why the session ended ('manual_stop' | 'channel_empty' | 'connection_destroyed')
 * @property {number} duration              - Session duration in seconds
 */

/**
 * @typedef {Object} GeneratorResult
 * @property {boolean} success
 * @property {string|null} filePath        - Path to saved minutes file on disk
 * @property {string|null} error           - Error message if failed
 * @property {number} generationTimeMs     - How long generation took
 */

/**
 * Run the complete minutes generation pipeline.
 *
 * This is designed to be called as a fire-and-forget operation after
 * session end. It handles its own errors and sends status updates to
 * the Discord text channel.
 *
 * @param {GeneratorInput} input
 * @returns {Promise<GeneratorResult>}
 */
export async function generateAndDeliverMinutes(input) {
  const startTime = Date.now();
  const { transcript, session, transcriptResult, client, reason, duration } = input;

  // Resolve the text channel for sending the minutes
  const guild = client?.guilds?.cache?.get(session.guildId);
  const textChannel = guild?.channels?.cache?.get(session.textChannelId);

  // SLA watchdog: if the pipeline stalls beyond GENERATION_TIMEOUT_MS, abort and notify
  let timeoutHandle;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Minutes generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s`));
    }, GENERATION_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([_runPipeline(input, startTime, guild, textChannel), timeoutPromise]);
    clearTimeout(timeoutHandle);
    return result;
  } catch (error) {
    clearTimeout(timeoutHandle);
    const generationTimeMs = Date.now() - startTime;
    const isTimeout = error.message.includes('timed out');
    console.error(`[MinutesGenerator] Pipeline ${isTimeout ? 'timed out' : 'failed'} after ${generationTimeMs}ms:`, error);

    if (textChannel) {
      const content = isTimeout
        ? '⏱️ **Meeting minutes generation timed out**\nThe process took too long and was aborted. The raw transcript has been saved to disk.'
        : [
            '❌ **Meeting minutes generation failed**',
            `Error: ${error.message}`,
            'The raw transcript has been saved to disk. You can regenerate minutes later.',
          ].join('\n');
      await textChannel.send({ content }).catch(console.error);
    }

    return {
      success: false,
      filePath: null,
      error: error.message,
      generationTimeMs,
    };
  }
}

async function _runPipeline(input, startTime, guild, textChannel) {
  const { transcript, session, transcriptResult, duration } = input;

  // --- Step 1: Build metadata for the formatter ---
  const metadata = buildMetadata(session, transcriptResult, guild, duration);

  // Use transcript from coordinator result if available, otherwise session transcript
  const transcriptEntries = transcriptResult?.transcript ?? transcript ?? session.transcript ?? [];

  if (transcriptEntries.length === 0) {
    const msg = 'No transcript entries recorded. Skipping minutes generation.';
    console.log(`[MinutesGenerator] ${msg}`);

    if (textChannel) {
      await textChannel.send({ content: `📝 ${msg}` }).catch(console.error);
    }

    return {
      success: true,
      filePath: null,
      error: null,
      generationTimeMs: Date.now() - startTime,
    };
  }

  // --- Step 2: Format the meeting minutes ---
  console.log(`[MinutesGenerator] Formatting minutes for ${transcriptEntries.length} entries...`);
  const markdown = formatMeetingMinutes(transcriptEntries, metadata);

  // --- Step 3: Save to disk ---
  await mkdir(MINUTES_DIR, { recursive: true });
  const filename = generateMinutesFilename(metadata);
  const filePath = join(MINUTES_DIR, filename);

  await writeFile(filePath, markdown, 'utf-8');
  console.log(`[MinutesGenerator] Minutes saved: ${filePath}`);

  // --- Step 3b: Update the minutes index ---
  try {
    const participantNames = metadata.speakerMap
      ? [...metadata.speakerMap.values()]
      : [];

    await addIndexEntry({
      filename,
      filePath,
      startedAt: metadata.startedAt,
      durationSeconds: metadata.durationSeconds,
      guildId: session.guildId ?? '',
      guildName: metadata.guildName,
      channelId: session.voiceChannelId ?? '',
      channelName: metadata.channelName,
      participants: participantNames,
      transcriptCount: transcriptEntries.length,
      language: metadata.language,
      startedBy: metadata.startedBy,
    });
  } catch (indexErr) {
    console.warn('[MinutesGenerator] Failed to update minutes index:', indexErr.message);
    // Non-fatal: minutes file is already saved
  }

  // --- Step 4: Send to Discord text channel ---
  if (textChannel) {
    await sendMinutesToChannel(textChannel, markdown, filename, metadata, transcriptEntries.length);
  } else {
    console.warn(`[MinutesGenerator] Text channel ${session.textChannelId} not found, skipping Discord delivery`);
  }

  const generationTimeMs = Date.now() - startTime;
  console.log(`[MinutesGenerator] Pipeline complete in ${generationTimeMs}ms`);

  return {
    success: true,
    filePath,
    error: null,
    generationTimeMs,
  };
}

/**
 * Build SessionMetadata from session info and guild data.
 *
 * @param {Object} session - SessionInfo
 * @param {Object} [transcriptResult] - AudioSessionCoordinator.stop() result
 * @param {import('discord.js').Guild} [guild] - Discord guild
 * @param {number} durationSeconds
 * @returns {import('./formatter.js').SessionMetadata}
 */
function buildMetadata(session, transcriptResult, guild, durationSeconds) {
  // Resolve voice channel name
  let channelName = 'Unknown Channel';
  if (guild) {
    const voiceChannel = guild.channels?.cache?.get(session.voiceChannelId);
    channelName = voiceChannel?.name ?? channelName;
  }

  // Build speaker map from coordinator's speaker map or participants
  const speakerMap = new Map();
  if (transcriptResult?.speakerMap) {
    // speakerMap from coordinator is a Map<number, string> or plain object
    const srcMap = transcriptResult.speakerMap;
    if (srcMap instanceof Map) {
      for (const [k, v] of srcMap) speakerMap.set(k, v);
    } else if (typeof srcMap === 'object') {
      for (const [k, v] of Object.entries(srcMap)) {
        speakerMap.set(isNaN(Number(k)) ? k : Number(k), v);
      }
    }
  }

  return {
    guildName: guild?.name ?? 'Unknown Server',
    channelName,
    startedAt: session.startedAt ?? new Date(),
    durationSeconds: durationSeconds ?? 0,
    startedBy: session.startedBy ?? 'Unknown',
    language: session.language ?? 'ko',
    speakerMap,
  };
}

/**
 * Send the meeting minutes file and a summary embed to a Discord text channel.
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {string} markdown - Full markdown content
 * @param {string} filename - Filename for the attachment
 * @param {Object} metadata - Session metadata
 * @param {number} entryCount - Number of transcript entries
 */
async function sendMinutesToChannel(channel, markdown, filename, metadata, entryCount) {
  const lang = metadata.language;

  // Create file attachment
  const attachment = new AttachmentBuilder(Buffer.from(markdown, 'utf-8'), {
    name: filename,
    description: lang === 'en' ? 'Meeting Minutes' : '회의록',
  });

  // Build a summary message with metadata (session date, channel name, duration)
  const durationStr = formatDurationSimple(metadata.durationSeconds);
  const sessionDate = (metadata.startedAt ?? new Date());
  const dateStr = sessionDate.toISOString().split('T')[0];
  const timeStr = sessionDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const headerLabel = lang === 'en' ? 'Meeting Minutes' : '회의록';
  const dateLabel = lang === 'en' ? 'Date' : '날짜';
  const durationLabel = lang === 'en' ? 'Duration' : '소요시간';
  const entriesLabel = lang === 'en' ? 'Transcript entries' : '녹취 항목';
  const channelLabel = lang === 'en' ? 'Channel' : '채널';
  const participantsLabel = lang === 'en' ? 'Participants' : '참석자';

  // Resolve participant count from speakerMap or entryCount
  const participantCount = metadata.speakerMap?.size ?? 0;

  const summaryLines = [
    `📝 **${headerLabel}** — ${metadata.channelName}`,
    '',
    `| | |`,
    `|---|---|`,
    `| **${dateLabel}** | ${dateStr} ${timeStr} |`,
    `| **${channelLabel}** | ${metadata.channelName} |`,
    `| **${durationLabel}** | ${durationStr} |`,
    `| **${entriesLabel}** | ${entryCount} |`,
    ...(participantCount > 0 ? [`| **${participantsLabel}** | ${participantCount} |`] : []),
    '',
    lang === 'en'
      ? '_Download the attached file for the full minutes._'
      : '_첨부 파일에서 전체 회의록을 확인하세요._',
  ];

  await channel.send({
    content: summaryLines.join('\n'),
    files: [attachment],
  });

  console.log(`[MinutesGenerator] Minutes delivered to channel ${channel.id}`);
}

/**
 * Simple duration formatter for summary messages.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatDurationSimple(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export {
  buildMetadata,
  sendMinutesToChannel,
  formatDurationSimple,
  MINUTES_DIR,
};
