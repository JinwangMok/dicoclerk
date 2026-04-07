/**
 * Meeting Minutes Generator Pipeline
 *
 * Orchestrates the end-to-end minutes generation flow:
 * 1. Receives transcript + session metadata
 * 2. Formats structured meeting minutes (Markdown)
 * 3. Saves the minutes file to disk
 * 4. Sends the file to the Discord text channel (with retry + fallback)
 *
 * Designed to complete within 1~2 minutes of session end.
 * Runs as a fire-and-forget async pipeline — errors are logged
 * and reported to the text channel, never thrown to the caller.
 *
 * Sub-AC 5.4: Discord file delivery
 * - Retry up to MAX_DELIVERY_ATTEMPTS times with exponential backoff
 * - Fallback to text-only notification when file attachment fails
 * - pipeline success = file saved to disk (delivery errors are non-fatal)
 * - deliverySuccess / deliveryError fields communicate delivery outcome
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatMeetingMinutes, generateMinutesFilename } from './formatter.js';
import { processWithLLM } from './llm-processor.js';
import { addEntry as addIndexEntry } from './index-store.js';
import { aggregateSessionData, toFormatterMetadata } from './aggregator.js';
import { AttachmentBuilder } from 'discord.js';

/** Directory for storing generated minutes */
const DATA_DIR = join(process.cwd(), 'data');
const MINUTES_DIR = join(DATA_DIR, 'minutes');

/** SLA timeout for the full minutes generation pipeline (2 minutes) */
const GENERATION_TIMEOUT_MS = 2 * 60 * 1000;

/** Maximum number of Discord delivery retry attempts */
const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * Base delay (ms) for exponential backoff between delivery retries.
 * Attempts: 1st retry after 2s, 2nd retry after 4s.
 * Override via _DELIVERY_RETRY_DELAY_MS for testing.
 */
let _DELIVERY_RETRY_DELAY_MS = 2000;

/**
 * Override the delivery retry base delay. Intended for tests only.
 * @param {number} ms
 */
export function _setDeliveryRetryDelayMs(ms) {
  _DELIVERY_RETRY_DELAY_MS = ms;
}

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
 * @property {boolean} success             - true if the minutes file was saved to disk
 * @property {string|null} filePath        - Path to saved minutes file on disk
 * @property {string|null} error           - Error message if pipeline failed (not delivery)
 * @property {boolean} deliverySuccess     - true if file was delivered to Discord channel
 * @property {string|null} deliveryError   - Error message if Discord delivery failed
 * @property {number} generationTimeMs     - How long the pipeline took end-to-end
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
  const { session, client } = input;

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
      deliverySuccess: false,
      deliveryError: null,
      generationTimeMs,
    };
  }
}

async function _runPipeline(input, startTime, guild, textChannel) {
  const { transcript, session, transcriptResult, duration, reason } = input;

  // --- Step 1: Aggregate all session data into a single structured object ---
  const minutesData = aggregateSessionData({
    session,
    coordinatorResult: {
      transcript: transcriptResult?.transcript ?? transcript ?? null,
      filePath: transcriptResult?.filePath ?? null,
      speakerMap: transcriptResult?.speakerMap ?? null,
    },
    speakerMap: transcriptResult?.speakerMap ?? null,
    guild,
    durationSeconds: duration,
    reason: reason ?? 'unknown',
  });

  // --- Step 1b: Derive legacy metadata shape for the formatter ---
  const metadata = toFormatterMetadata(minutesData);

  // Use the normalised, chronologically-sorted transcript from the aggregator
  const transcriptEntries = minutesData.transcript;

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
      deliverySuccess: false,
      deliveryError: null,
      generationTimeMs: Date.now() - startTime,
    };
  }

  // --- Step 2: AI-enhanced content generation (optional, graceful fallback) ---
  console.log(`[MinutesGenerator] Requesting AI-generated content for ${transcriptEntries.length} entries…`);
  const aiContent = await processWithLLM(transcriptEntries, metadata);
  if (aiContent) {
    console.log(`[MinutesGenerator] AI content received from ${aiContent.provider}`);
  } else {
    console.log('[MinutesGenerator] Using heuristic extraction (no AI content available)');
  }

  // --- Step 3: Format the meeting minutes (with AI content injected when available) ---
  console.log(`[MinutesGenerator] Formatting minutes for ${transcriptEntries.length} entries...`);
  const markdown = formatMeetingMinutes(transcriptEntries, metadata, {}, aiContent);

  // --- Step 3: Save to disk ---
  await mkdir(MINUTES_DIR, { recursive: true });
  const filename = generateMinutesFilename(metadata);
  const filePath = join(MINUTES_DIR, filename);

  await writeFile(filePath, markdown, 'utf-8');
  console.log(`[MinutesGenerator] Minutes saved: ${filePath}`);

  // --- Step 3b: Update the minutes index ---
  try {
    const participantNames = minutesData.speakers.length > 0
      ? minutesData.speakers.map(s => s.displayName)
      : [...metadata.speakerMap.values()];

    await addIndexEntry({
      sessionId: minutesData.sessionId,
      filename,
      filePath,
      startedAt: minutesData.startedAt,
      durationSeconds: minutesData.durationSeconds,
      guildId: minutesData.guildId,
      guildName: minutesData.guildName,
      channelId: minutesData.channelId,
      channelName: minutesData.channelName,
      participants: participantNames,
      transcriptCount: minutesData.transcriptCount,
      language: minutesData.language,
      startedBy: minutesData.startedBy,
    });
  } catch (indexErr) {
    console.warn('[MinutesGenerator] Failed to update minutes index:', indexErr.message);
    // Non-fatal: minutes file is already saved
  }

  // --- Step 4: Send to Discord text channel (with retry + fallback) ---
  let deliverySuccess = false;
  let deliveryError = null;

  if (textChannel) {
    try {
      await _deliverWithRetry(textChannel, markdown, filename, metadata, transcriptEntries.length);
      deliverySuccess = true;
    } catch (sendError) {
      deliveryError = sendError.message;
      console.error(
        `[MinutesGenerator] Discord delivery failed after ${MAX_DELIVERY_ATTEMPTS} attempts: ${sendError.message}`
      );

      // Fallback: send a text-only notification so the user knows the file is on disk
      await _sendDeliveryFailureNotification(textChannel, filename, sendError.message, metadata.language);
    }
  } else {
    console.warn(
      `[MinutesGenerator] Text channel ${session.textChannelId} not found, skipping Discord delivery`
    );
  }

  const generationTimeMs = Date.now() - startTime;
  console.log(
    `[MinutesGenerator] Pipeline complete in ${generationTimeMs}ms` +
    ` (delivery: ${deliverySuccess ? 'ok' : 'failed'})`
  );

  return {
    success: true,
    filePath,
    error: null,
    deliverySuccess,
    deliveryError,
    generationTimeMs,
  };
}

// ---------------------------------------------------------------------------
// Delivery helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to deliver the minutes file to the channel up to MAX_DELIVERY_ATTEMPTS
 * times, using exponential backoff between retries.
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {string} markdown
 * @param {string} filename
 * @param {Object} metadata
 * @param {number} entryCount
 * @returns {Promise<void>} Resolves on success, throws after all attempts fail
 */
async function _deliverWithRetry(channel, markdown, filename, metadata, entryCount) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    try {
      await sendMinutesToChannel(channel, markdown, filename, metadata, entryCount);
      console.log(
        `[MinutesGenerator] Minutes delivered to channel ${channel.id}` +
        (attempt > 1 ? ` (attempt ${attempt})` : '')
      );
      return; // success
    } catch (err) {
      lastError = err;
      console.warn(
        `[MinutesGenerator] Delivery attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS} failed: ${err.message}`
      );

      if (attempt < MAX_DELIVERY_ATTEMPTS) {
        const delay = _DELIVERY_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[MinutesGenerator] Retrying delivery in ${delay}ms...`);
        await _sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Send a fallback text-only notification when file delivery has failed.
 * The message tells users the minutes are saved on disk and why delivery failed.
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {string} filename
 * @param {string} errorMessage
 * @param {string} language - 'en' | 'ko'
 */
async function _sendDeliveryFailureNotification(channel, filename, errorMessage, language) {
  const isKo = language === 'ko';

  const lines = isKo
    ? [
        '⚠️ **회의록 파일 전송 실패**',
        `오류: ${errorMessage}`,
        `회의록은 디스크에 저장되었습니다: \`${filename}\``,
        '파일을 직접 확인하거나 나중에 다시 시도해 주세요.',
      ]
    : [
        '⚠️ **Meeting minutes delivery failed**',
        `Error: ${errorMessage}`,
        `The minutes file has been saved to disk: \`${filename}\``,
        'Please retrieve the file manually or try again later.',
      ];

  try {
    await channel.send({ content: lines.join('\n') });
    console.log('[MinutesGenerator] Delivery failure notification sent to channel');
  } catch (notifyError) {
    // Notification also failed — log only, never throw
    console.error(
      '[MinutesGenerator] Failed to send delivery failure notification:',
      notifyError.message
    );
  }
}

/**
 * Promisified sleep helper. Extracted so tests can override _DELIVERY_RETRY_DELAY_MS
 * to 0 and avoid waiting during retries.
 * @param {number} ms
 */
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public helpers (also used directly in tests)
// ---------------------------------------------------------------------------

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
  MAX_DELIVERY_ATTEMPTS,
};
