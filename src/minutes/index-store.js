/**
 * Meeting Minutes Index Store
 *
 * Maintains a JSON index file alongside the minutes markdown files.
 * Stores searchable metadata for each meeting session:
 *   - Session ID (unique identifier)
 *   - Date and time
 *   - Channel name and ID
 *   - Guild name and ID
 *   - Participant list
 *   - Duration
 *   - File path to the minutes markdown
 *   - Language
 *   - Transcript entry count
 *
 * The index enables fast lookup without parsing markdown files,
 * and supports filtering by date range, channel, participants, etc.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Directory for storing generated minutes */
const DATA_DIR = join(process.cwd(), 'data');
const MINUTES_DIR = join(DATA_DIR, 'minutes');
const INDEX_FILE = join(MINUTES_DIR, 'index.json');

/**
 * @typedef {Object} MinutesIndexEntry
 * @property {string} sessionId          - Unique session identifier
 * @property {string} date               - ISO date string (YYYY-MM-DD)
 * @property {string} time               - Time string (HH:MM)
 * @property {string} startedAt          - Full ISO timestamp
 * @property {number} durationSeconds    - Session duration in seconds
 * @property {string} guildId            - Discord guild ID
 * @property {string} guildName          - Discord guild name
 * @property {string} channelId          - Voice channel ID
 * @property {string} channelName        - Voice channel name
 * @property {string[]} participants     - List of participant display names
 * @property {number} participantCount   - Number of participants
 * @property {number} transcriptCount    - Number of transcript entries
 * @property {string} language           - Language code (ko/en)
 * @property {string} startedBy          - User who started the session
 * @property {string} filename           - Minutes markdown filename
 * @property {string} filePath           - Full path to minutes file
 * @property {string} createdAt          - When this index entry was created (ISO)
 */

/**
 * @typedef {Object} MinutesIndex
 * @property {number} version            - Index format version
 * @property {string} updatedAt          - Last update timestamp (ISO)
 * @property {MinutesIndexEntry[]} entries - All indexed minutes
 */

/**
 * Load the minutes index from disk.
 * Returns an empty index if the file doesn't exist.
 *
 * @returns {Promise<MinutesIndex>}
 */
export async function loadIndex() {
  try {
    const raw = await readFile(INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    // Validate basic structure
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      return parsed;
    }

    console.warn('[MinutesIndex] Invalid index format, creating new index');
    return createEmptyIndex();
  } catch (err) {
    if (err.code === 'ENOENT') {
      return createEmptyIndex();
    }
    console.error('[MinutesIndex] Failed to load index:', err.message);
    return createEmptyIndex();
  }
}

/**
 * Save the minutes index to disk.
 *
 * @param {MinutesIndex} index
 * @returns {Promise<void>}
 */
export async function saveIndex(index) {
  await mkdir(MINUTES_DIR, { recursive: true });
  index.updatedAt = new Date().toISOString();
  const json = JSON.stringify(index, null, 2);
  await writeFile(INDEX_FILE, json, 'utf-8');
}

/**
 * Add a new entry to the minutes index.
 *
 * @param {Object} params
 * @param {string} params.filename            - Minutes markdown filename
 * @param {string} params.filePath            - Full path to the minutes file
 * @param {string} [params.sessionId]         - Session ID (auto-generated if not provided)
 * @param {Date|string} params.startedAt      - Session start time
 * @param {number} params.durationSeconds     - Session duration
 * @param {string} [params.guildId]           - Discord guild ID
 * @param {string} [params.guildName]         - Discord guild name
 * @param {string} [params.channelId]         - Voice channel ID
 * @param {string} [params.channelName]       - Voice channel name
 * @param {string[]} [params.participants]    - Participant display names
 * @param {number} [params.transcriptCount]   - Number of transcript entries
 * @param {string} [params.language]          - Language code
 * @param {string} [params.startedBy]         - User who started the session
 * @returns {Promise<MinutesIndexEntry>}
 */
export async function addEntry(params) {
  const index = await loadIndex();

  const startedAt = params.startedAt instanceof Date
    ? params.startedAt
    : new Date(params.startedAt ?? Date.now());

  /** @type {MinutesIndexEntry} */
  const entry = {
    sessionId: params.sessionId ?? randomUUID(),
    date: startedAt.toISOString().split('T')[0],
    time: startedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    startedAt: startedAt.toISOString(),
    durationSeconds: params.durationSeconds ?? 0,
    guildId: params.guildId ?? '',
    guildName: params.guildName ?? 'Unknown Server',
    channelId: params.channelId ?? '',
    channelName: params.channelName ?? 'Unknown Channel',
    participants: params.participants ?? [],
    participantCount: params.participants?.length ?? 0,
    transcriptCount: params.transcriptCount ?? 0,
    language: params.language ?? 'ko',
    startedBy: params.startedBy ?? 'Unknown',
    filename: params.filename,
    filePath: params.filePath,
    createdAt: new Date().toISOString(),
  };

  index.entries.push(entry);
  await saveIndex(index);

  console.log(`[MinutesIndex] Added entry: sessionId=${entry.sessionId} file=${entry.filename}`);
  return entry;
}

/**
 * Search the minutes index by various criteria.
 * All filter parameters are optional — omit to skip that filter.
 *
 * @param {Object} [filters]
 * @param {string} [filters.sessionId]       - Exact session ID match
 * @param {string} [filters.guildId]         - Filter by guild ID
 * @param {string} [filters.channelName]     - Partial match on channel name (case-insensitive)
 * @param {string} [filters.participant]     - Partial match on any participant name (case-insensitive)
 * @param {string} [filters.dateFrom]        - Start date (YYYY-MM-DD, inclusive)
 * @param {string} [filters.dateTo]          - End date (YYYY-MM-DD, inclusive)
 * @param {string} [filters.language]        - Filter by language code
 * @param {string} [filters.query]           - Free-text search across channel, participants, guild
 * @param {number} [filters.limit]           - Max results (default 50)
 * @param {number} [filters.offset]          - Skip first N results (default 0)
 * @returns {Promise<{ entries: MinutesIndexEntry[], total: number, showing: number }>}
 */
export async function searchEntries(filters = {}) {
  const index = await loadIndex();
  let results = [...index.entries];

  // --- Apply filters ---

  if (filters.sessionId) {
    results = results.filter(e => e.sessionId === filters.sessionId);
  }

  if (filters.guildId) {
    results = results.filter(e => e.guildId === filters.guildId);
  }

  if (filters.channelName) {
    const needle = filters.channelName.toLowerCase();
    results = results.filter(e => e.channelName.toLowerCase().includes(needle));
  }

  if (filters.participant) {
    const needle = filters.participant.toLowerCase();
    results = results.filter(e =>
      e.participants.some(p => p.toLowerCase().includes(needle))
    );
  }

  if (filters.dateFrom) {
    results = results.filter(e => e.date >= filters.dateFrom);
  }

  if (filters.dateTo) {
    results = results.filter(e => e.date <= filters.dateTo);
  }

  if (filters.language) {
    results = results.filter(e => e.language === filters.language);
  }

  if (filters.query) {
    const q = filters.query.toLowerCase();
    results = results.filter(e =>
      e.channelName.toLowerCase().includes(q) ||
      e.guildName.toLowerCase().includes(q) ||
      e.startedBy.toLowerCase().includes(q) ||
      e.participants.some(p => p.toLowerCase().includes(q)) ||
      e.sessionId.toLowerCase().includes(q)
    );
  }

  // Sort by date descending (newest first)
  results.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

  const total = results.length;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  const paged = results.slice(offset, offset + limit);

  return {
    entries: paged,
    total,
    showing: paged.length,
  };
}

/**
 * Get a single entry by session ID.
 *
 * @param {string} sessionId
 * @returns {Promise<MinutesIndexEntry | null>}
 */
export async function getEntryBySessionId(sessionId) {
  const index = await loadIndex();
  return index.entries.find(e => e.sessionId === sessionId) ?? null;
}

/**
 * Get the most recent entry, optionally filtered by guild.
 *
 * @param {string} [guildId]
 * @returns {Promise<MinutesIndexEntry | null>}
 */
export async function getLatestEntry(guildId) {
  const index = await loadIndex();
  let entries = index.entries;

  if (guildId) {
    entries = entries.filter(e => e.guildId === guildId);
  }

  if (entries.length === 0) return null;

  // Sort newest first
  entries.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return entries[0];
}

/**
 * Remove an entry from the index by session ID.
 * Does NOT delete the file on disk.
 *
 * @param {string} sessionId
 * @returns {Promise<boolean>} - true if entry was found and removed
 */
export async function removeEntry(sessionId) {
  const index = await loadIndex();
  const before = index.entries.length;
  index.entries = index.entries.filter(e => e.sessionId !== sessionId);

  if (index.entries.length < before) {
    await saveIndex(index);
    console.log(`[MinutesIndex] Removed entry: sessionId=${sessionId}`);
    return true;
  }

  return false;
}

/**
 * Rebuild the index from existing minutes files on disk.
 * Useful for recovering from a corrupted or missing index.
 * Parses metadata from the markdown file headers.
 *
 * @returns {Promise<MinutesIndex>}
 */
export async function rebuildIndex() {
  const { readdir } = await import('node:fs/promises');

  let files;
  try {
    files = await readdir(MINUTES_DIR);
  } catch {
    console.log('[MinutesIndex] No minutes directory, creating empty index');
    const index = createEmptyIndex();
    await saveIndex(index);
    return index;
  }

  const mdFiles = files.filter(f => f.endsWith('.md'));
  const index = createEmptyIndex();

  for (const filename of mdFiles) {
    const filePath = join(MINUTES_DIR, filename);
    try {
      const content = await readFile(filePath, 'utf-8');
      const entry = parseMetadataFromMarkdown(content, filename, filePath);
      index.entries.push(entry);
    } catch (err) {
      console.warn(`[MinutesIndex] Failed to parse ${filename}: ${err.message}`);
    }
  }

  // Sort newest first
  index.entries.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

  await saveIndex(index);
  console.log(`[MinutesIndex] Rebuilt index with ${index.entries.length} entries`);
  return index;
}

/**
 * Parse metadata from a meeting minutes markdown file header.
 * Extracts info from the markdown table at the top of the file.
 *
 * @param {string} content - Markdown content
 * @param {string} filename
 * @param {string} filePath
 * @returns {MinutesIndexEntry}
 */
function parseMetadataFromMarkdown(content, filename, filePath) {
  const lines = content.split('\n');

  // Extract key-value pairs from the markdown table
  const tableValues = {};
  for (const line of lines) {
    const match = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|\s*(.+?)\s*\|$/);
    if (match) {
      tableValues[match[1]] = match[2].trim();
    }
  }

  // Extract date from table or filename
  const dateStr = tableValues['Date'] ?? tableValues['\ub0a0\uc9dc'] ?? '';  // 날짜
  const timeStr = tableValues['Time'] ?? tableValues['\uc2dc\uac04'] ?? '';  // 시간
  const guildName = tableValues['Server'] ?? tableValues['\uc11c\ubc84'] ?? 'Unknown Server';  // 서버
  const channelName = tableValues['Channel'] ?? tableValues['\ucc44\ub110'] ?? 'Unknown Channel';  // 채널
  const startedBy = tableValues['Started by'] ?? tableValues['\uc2dc\uc791'] ?? 'Unknown';  // 시작
  const durationStr = tableValues['Duration'] ?? tableValues['\uc18c\uc694\uc2dc\uac04'] ?? '';  // 소요시간

  // Parse duration from "Xh Ym Zs" or "Ym Zs"
  const durationSeconds = parseDurationString(durationStr);

  // Try to build a Date from the extracted date + time
  let startedAt;
  try {
    startedAt = dateStr ? new Date(`${dateStr}T${timeStr || '00:00'}:00`) : new Date();
    if (isNaN(startedAt.getTime())) startedAt = new Date();
  } catch {
    startedAt = new Date();
  }

  // Extract participants from the attendees table
  const participants = [];
  let inAttendeesSection = false;
  let headerRowsPassed = 0;
  for (const line of lines) {
    if (line.match(/^##\s+(Attendees|참석자)/)) {
      inAttendeesSection = true;
      headerRowsPassed = 0;
      continue;
    }
    if (inAttendeesSection && line.startsWith('## ')) {
      break; // Next section
    }
    if (inAttendeesSection && line.startsWith('|')) {
      headerRowsPassed++;
      if (headerRowsPassed <= 2) continue; // Skip header row and separator
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length > 0 && cells[0] !== '---') {
        participants.push(cells[0]);
      }
    }
  }

  // Detect language from title
  const title = lines[0] ?? '';
  const language = title.includes('\ud68c\uc758\ub85d') ? 'ko' : 'en';  // 회의록

  // Extract transcript count from summary or estimate
  let transcriptCount = 0;
  const transcriptMatch = content.match(/\*\*(\d+)\*\*\s*(?:건의 발화|utterances)/);
  if (transcriptMatch) {
    transcriptCount = parseInt(transcriptMatch[1], 10);
  }

  // Try to extract date from filename as fallback: minutes_YYYY-MM-DD_HHMMSS_channel.md
  let filenameDate = null;
  const fnMatch = filename.match(/minutes_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (fnMatch) {
    filenameDate = new Date(`${fnMatch[1]}T${fnMatch[2]}:${fnMatch[3]}:${fnMatch[4]}`);
    if (isNaN(filenameDate.getTime())) filenameDate = null;
  }

  if (!dateStr && filenameDate) {
    startedAt = filenameDate;
  }

  return {
    sessionId: randomUUID(),
    date: startedAt.toISOString().split('T')[0],
    time: startedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    startedAt: startedAt.toISOString(),
    durationSeconds,
    guildId: '',
    guildName,
    channelId: '',
    channelName,
    participants,
    participantCount: participants.length,
    transcriptCount,
    language,
    startedBy,
    filename,
    filePath,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Parse a duration string like "1h 30m 15s" or "5m 30s" into seconds.
 * @param {string} str
 * @returns {number}
 */
function parseDurationString(str) {
  if (!str) return 0;
  let total = 0;
  const hMatch = str.match(/(\d+)\s*h/);
  const mMatch = str.match(/(\d+)\s*m/);
  const sMatch = str.match(/(\d+)\s*s/);
  if (hMatch) total += parseInt(hMatch[1], 10) * 3600;
  if (mMatch) total += parseInt(mMatch[1], 10) * 60;
  if (sMatch) total += parseInt(sMatch[1], 10);
  return total;
}

/**
 * Create an empty index structure.
 * @returns {MinutesIndex}
 */
function createEmptyIndex() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [],
  };
}

/**
 * Search entries and return results with full file content.
 * Supports all the same filters as searchEntries, plus content-level keyword search.
 *
 * @param {Object} [filters]
 * @param {string} [filters.query]           - Free-text search (also searched in file content)
 * @param {string} [filters.guildId]         - Filter by guild ID
 * @param {string} [filters.channelName]     - Partial match on channel name (case-insensitive)
 * @param {string} [filters.participant]     - Partial match on any participant name (case-insensitive)
 * @param {string} [filters.dateFrom]        - Start date (YYYY-MM-DD, inclusive)
 * @param {string} [filters.dateTo]          - End date (YYYY-MM-DD, inclusive)
 * @param {string} [filters.language]        - Filter by language code
 * @param {string[]} [filters.keywords]      - Keywords to search within file content
 * @param {number} [filters.limit]           - Max results (default 10)
 * @param {number} [filters.offset]          - Skip first N results (default 0)
 * @param {boolean} [filters.includeContent] - Whether to include full file content (default true)
 * @returns {Promise<{ entries: Array<MinutesIndexEntry & { content?: string, matchedKeywords?: string[] }>, total: number, showing: number }>}
 */
export async function searchEntriesWithContent(filters = {}) {
  // First get metadata-filtered results (without limit, so we can do content filtering)
  const index = await loadIndex();
  let results = [...index.entries];

  // --- Apply metadata filters (same as searchEntries) ---

  if (filters.guildId) {
    results = results.filter(e => e.guildId === filters.guildId);
  }

  if (filters.channelName) {
    const needle = filters.channelName.toLowerCase();
    results = results.filter(e => e.channelName.toLowerCase().includes(needle));
  }

  if (filters.participant) {
    const needle = filters.participant.toLowerCase();
    results = results.filter(e =>
      e.participants.some(p => p.toLowerCase().includes(needle))
    );
  }

  if (filters.dateFrom) {
    results = results.filter(e => e.date >= filters.dateFrom);
  }

  if (filters.dateTo) {
    results = results.filter(e => e.date <= filters.dateTo);
  }

  if (filters.language) {
    results = results.filter(e => e.language === filters.language);
  }

  // Metadata-level free-text query (same as searchEntries)
  if (filters.query) {
    const q = filters.query.toLowerCase();
    results = results.filter(e =>
      e.channelName.toLowerCase().includes(q) ||
      e.guildName.toLowerCase().includes(q) ||
      e.startedBy.toLowerCase().includes(q) ||
      e.participants.some(p => p.toLowerCase().includes(q)) ||
      e.sessionId.toLowerCase().includes(q)
    );
  }

  // Sort by date descending (newest first)
  results.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

  // --- Load file content and apply content-level keyword filtering ---
  const includeContent = filters.includeContent !== false;
  const keywords = filters.keywords?.map(k => k.toLowerCase()).filter(Boolean) ?? [];

  const enriched = [];
  for (const entry of results) {
    let content = null;
    try {
      content = await readFile(entry.filePath, 'utf-8');
    } catch {
      // File missing — skip if keywords required, include without content otherwise
      if (keywords.length > 0) continue;
    }

    // Content-level keyword filtering
    if (keywords.length > 0 && content) {
      const contentLower = content.toLowerCase();
      const matchedKeywords = keywords.filter(kw => contentLower.includes(kw));
      if (matchedKeywords.length === 0) continue; // No keyword match — skip
      enriched.push({
        ...entry,
        ...(includeContent ? { content } : {}),
        matchedKeywords,
      });
    } else {
      enriched.push({
        ...entry,
        ...(includeContent && content ? { content } : {}),
      });
    }
  }

  // Also apply free-text query to content if no metadata match was found
  // (already filtered above, so this extends to content search)
  let finalResults = enriched;
  if (filters.query && keywords.length === 0) {
    // Re-check: also include entries where the query matches file content
    // (entries already passed metadata filter, so just enrich)
    // For entries that didn't pass metadata filter, we'd need a second pass.
    // Instead, do a content-level query search on the full index:
    const q = filters.query.toLowerCase();
    const contentMatches = [];
    const existingIds = new Set(finalResults.map(e => e.sessionId));

    // Search content of all entries not already included
    const allEntries = [...index.entries];
    for (const entry of allEntries) {
      if (existingIds.has(entry.sessionId)) continue;
      // Apply non-query filters
      if (filters.guildId && entry.guildId !== filters.guildId) continue;
      if (filters.dateFrom && entry.date < filters.dateFrom) continue;
      if (filters.dateTo && entry.date > filters.dateTo) continue;
      if (filters.language && entry.language !== filters.language) continue;
      if (filters.channelName && !entry.channelName.toLowerCase().includes(filters.channelName.toLowerCase())) continue;
      if (filters.participant && !entry.participants.some(p => p.toLowerCase().includes(filters.participant.toLowerCase()))) continue;

      try {
        const content = await readFile(entry.filePath, 'utf-8');
        if (content.toLowerCase().includes(q)) {
          contentMatches.push({
            ...entry,
            ...(includeContent ? { content } : {}),
          });
        }
      } catch {
        // File missing — skip
      }
    }

    finalResults = [...finalResults, ...contentMatches];
    // Re-sort after merging
    finalResults.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }

  const total = finalResults.length;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 10;
  const paged = finalResults.slice(offset, offset + limit);

  return {
    entries: paged,
    total,
    showing: paged.length,
  };
}

export {
  INDEX_FILE,
  MINUTES_DIR,
  createEmptyIndex,
  parseMetadataFromMarkdown,
  parseDurationString,
};
