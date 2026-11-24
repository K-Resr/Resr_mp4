import express from 'express';
import type {Request, Response} from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import {Readable} from 'stream';
import {fileURLToPath} from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface YouTubeTrack {
  id: string;
  title: string;
  channel: string;
  channelId?: string;
  duration: string;
  durationSeconds: number;
  thumbnail: string;
  viewCountText: string;
}

interface YouTubeChannel {
  channelId: string;
  title: string;
  handle: string;
  subscriberText: string;
  thumbnail: string;
  description: string;
}

interface ChannelCollectionItem {
  id: string;
  kind: 'playlist' | 'release';
  title: string;
  subtitle: string;
  videoCountText: string;
  thumbnail: string;
  seedVideoId?: string;
  channelTitle?: string;
}

interface ChannelDetailPayload {
  channelId: string;
  channelTitle: string;
  subscriberText: string;
  thumbnail: string;
  tracks: YouTubeTrack[];
  videos: YouTubeTrack[];
  playlists: ChannelCollectionItem[];
  releases: ChannelCollectionItem[];
  hasReleases: boolean;
}

interface CacheEntry<T> {
  expiresAt: number;
  data: T;
}

interface SearchCursorPayload {
  t: string;
  k: string;
  v: string;
}

interface SearchPageResult {
  tracks: YouTubeTrack[];
  nextCursor: string | null;
}

interface AudioStreamEntry {
  url: string;
  mimeType: string;
  bitrate: number;
  contentLength?: string;
}

type ChartPlatformSource = 'melon' | 'genie' | 'flo' | 'vibe' | 'apple';

interface RawChartItem {
  source: ChartPlatformSource;
  label: string;
  rank: number;
  title: string;
  artist: string;
  albumArt: string;
}

interface UnifiedChartEntry {
  unifiedRank: number;
  title: string;
  artist: string;
  albumArt: string;
  score: number;
  platformCount: number;
  platforms: Array<{source: ChartPlatformSource; label: string; rank: number}>;
  track: YouTubeTrack | null;
}

interface UnifiedChartPayload {
  updatedAt: number;
  activeSources: Array<{source: ChartPlatformSource; label: string; count: number}>;
  entries: UnifiedChartEntry[];
}

const searchCache = new Map<string, CacheEntry<SearchPageResult>>();
const channelSearchCache = new Map<string, CacheEntry<YouTubeChannel[]>>();
const channelDetailCache = new Map<string, CacheEntry<ChannelDetailPayload>>();
const playlistCollectionCache = new Map<
  string,
  CacheEntry<{title: string; tracks: YouTubeTrack[]}>
>();
const audioStreamCache = new Map<string, CacheEntry<AudioStreamEntry | null>>();
let unifiedChartCache: CacheEntry<UnifiedChartPayload> | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000;
const STREAM_CACHE_TTL_MS = 25 * 60 * 1000;
const STREAM_FAIL_TTL_MS = 3 * 60 * 1000;
const CHART_CACHE_TTL_MS = 10 * 60 * 1000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function parseDurationSeconds(label: string): number {
  if (!label || label === 'LIVE') return 0;
  const parts = label
    .trim()
    .split(':')
    .map((n) => Number.parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return 'LIVE';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function parseIsoDuration(iso: string): number {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!match) return 0;
  const hours = Number.parseInt(match[1] || '0', 10);
  const minutes = Number.parseInt(match[2] || '0', 10);
  const seconds = Number.parseInt(match[3] || '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}

function parseViewCount(viewText: string): number {
  if (!viewText) return 0;
  const clean = viewText.replace(/,/g, '').toLowerCase();
  const numMatch = /([\d.]+)/.exec(clean);
  if (!numMatch) return 0;
  const base = Number.parseFloat(numMatch[1]);
  if (Number.isNaN(base)) return 0;
  if (clean.includes('억')) return base * 100_000_000;
  if (clean.includes('만')) return base * 10_000;
  if (clean.includes('천')) return base * 1_000;
  if (clean.includes('b')) return base * 1_000_000_000;
  if (clean.includes('m')) return base * 1_000_000;
  if (clean.includes('k')) return base * 1_000;
  return base;
}

function extractText(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return '';
  const record = obj as Record<string, unknown>;
  if (typeof record.simpleText === 'string') return record.simpleText;
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.runs)) {
    return record.runs
      .map((r) =>
        r && typeof r === 'object' && typeof (r as Record<string, unknown>).text === 'string'
          ? (r as Record<string, unknown>).text
          : '',
      )
      .join('');
  }
  return '';
}

function extractJsonAssignment(html: string, varName: string): Record<string, unknown> | null {
  const markers = [`var ${varName} = `, `window["${varName}"] = `, `${varName} = `];
  for (const marker of markers) {
    const startIdx = html.indexOf(marker);
    if (startIdx === -1) continue;
    const jsonStart = html.indexOf('{', startIdx + marker.length);
    if (jsonStart === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = jsonStart; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(jsonStart, i + 1)) as Record<string, unknown>;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function collectRenderers(node: unknown, seen: Set<string>, out: YouTubeTrack[], maxItems: number): void {
  if (!node || typeof node !== 'object' || out.length >= maxItems) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (out.length >= maxItems) break;
      collectRenderers(item, seen, out, maxItems);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  const renderer = (
    record.videoRenderer ||
    record.playlistVideoRenderer ||
    record.playlistPanelVideoRenderer
  ) as Record<string, unknown> | undefined;

  if (renderer && typeof renderer.videoId === 'string') {
    const id = renderer.videoId;
    if (!seen.has(id)) {
      const title = extractText(renderer.title).trim();
      const channel = (
        extractText(renderer.ownerText) ||
        extractText(renderer.shortBylineText) ||
        extractText(renderer.longBylineText) ||
        'YouTube'
      ).trim();

      let channelId: string | undefined;
      const runs =
        ((renderer.ownerText as Record<string, unknown> | undefined)?.runs as Array<Record<string, unknown>> | undefined) ||
        ((renderer.shortBylineText as Record<string, unknown> | undefined)?.runs as Array<Record<string, unknown>> | undefined);
      const browseId = (
        runs?.[0]?.navigationEndpoint as Record<string, unknown> | undefined
      )?.browseEndpoint as Record<string, unknown> | undefined;
      if (browseId && typeof browseId.browseId === 'string') {
        channelId = browseId.browseId;
      }

      const durationLabel = extractText(renderer.lengthText).trim();
      const durationSeconds =
        typeof renderer.lengthSeconds === 'string'
          ? Number.parseInt(renderer.lengthSeconds, 10)
          : parseDurationSeconds(durationLabel);
      const duration = durationLabel || formatDuration(durationSeconds);
      const viewCountText = extractText(renderer.shortViewCountText).trim();

      if (id && title) {
        seen.add(id);
        out.push({
          id,
          title,
          channel,
          ...(channelId ? {channelId} : {}),
          duration: duration || 'LIVE',
          durationSeconds: Number.isNaN(durationSeconds) ? 0 : durationSeconds,
          thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          viewCountText,
        });
      }
    }
  }

  // Also support YouTube channel /videos lockupViewModel
  const lockup = record.lockupViewModel as Record<string, unknown> | undefined;
  if (
    lockup &&
    typeof lockup.contentId === 'string' &&
    lockup.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST'
  ) {
    const id = lockup.contentId;
    if (!seen.has(id) && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
      const metaRoot = (lockup.metadata as Record<string, unknown> | undefined)
        ?.lockupMetadataViewModel as Record<string, unknown> | undefined;
      const title = extractText(metaRoot?.title).trim();

      let durationLabel = '';
      const overlays = ((lockup.contentImage as Record<string, unknown> | undefined)
        ?.thumbnailViewModel as Record<string, unknown> | undefined)
        ?.overlays as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(overlays)) {
        for (const ov of overlays) {
          const badges = (ov.thumbnailBottomOverlayViewModel as Record<string, unknown> | undefined)
            ?.badges as Array<Record<string, unknown>> | undefined;
          const text = (badges?.[0]?.thumbnailBadgeViewModel as Record<string, unknown> | undefined)?.text;
          if (typeof text === 'string' && text.trim()) {
            durationLabel = text.trim();
            break;
          }
        }
      }

      let viewCountText = '';
      const metaRows = ((metaRoot?.metadata as Record<string, unknown> | undefined)
        ?.contentMetadataViewModel as Record<string, unknown> | undefined)
        ?.metadataRows as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(metaRows)) {
        for (const row of metaRows) {
          const parts = row.metadataParts as Array<Record<string, unknown>> | undefined;
          const partText = extractText(parts?.[0]?.text).trim();
          if (partText) {
            viewCountText = partText;
            break;
          }
        }
      }

      const durationSeconds = parseDurationSeconds(durationLabel);
      if (title) {
        seen.add(id);
        out.push({
          id,
          title,
          channel: 'YouTube',
          duration: durationLabel || formatDuration(durationSeconds),
          durationSeconds,
          thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          viewCountText,
        });
      }
    }
  }

  for (const val of Object.values(record)) {
    if (out.length >= maxItems) break;
    if (val && typeof val === 'object') {
      collectRenderers(val, seen, out, maxItems);
    }
  }
}

function collectChannels(
  node: unknown,
  seen: Set<string>,
  out: YouTubeChannel[],
  maxItems: number,
): void {
  if (!node || typeof node !== 'object' || out.length >= maxItems) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (out.length >= maxItems) break;
      collectChannels(item, seen, out, maxItems);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  const ch = record.channelRenderer as Record<string, unknown> | undefined;
  if (ch && typeof ch.channelId === 'string') {
    const channelId = ch.channelId;
    if (!seen.has(channelId)) {
      const title = extractText(ch.title).trim();
      const handle = extractText(ch.subscriberCountText).trim();
      const videoCountText = extractText(ch.videoCountText).trim();
      const subscriberText =
        handle && videoCountText && handle !== videoCountText
          ? `${handle} · ${videoCountText}`
          : videoCountText || handle || 'YouTube 채널';
      const thumbs = (ch.thumbnail as Record<string, unknown> | undefined)
        ?.thumbnails as Array<{url?: string}> | undefined;
      const rawThumb = thumbs?.[thumbs.length - 1]?.url || thumbs?.[0]?.url || '';
      const thumbnail = rawThumb.startsWith('//') ? `https:${rawThumb}` : rawThumb;
      const description = extractText(ch.descriptionSnippet).trim();

      if (title) {
        seen.add(channelId);
        out.push({
          channelId,
          title,
          handle: handle.startsWith('@') ? handle : '',
          subscriberText,
          thumbnail,
          description,
        });
      }
    }
  }

  for (const val of Object.values(record)) {
    if (out.length >= maxItems) break;
    if (val && typeof val === 'object') {
      collectChannels(val, seen, out, maxItems);
    }
  }
}

function rankMusicTracks(
  tracks: YouTubeTrack[],
  query: string,
  musicFocus: boolean,
  preferredChannels: Set<string>,
): YouTubeTrack[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const musicSignals = [
    'official',
    'audio',
    'm/v',
    'mv',
    'lyrics',
    '가사',
    'live',
    'topic',
    'music',
    'session',
    'acoustic',
    'playlist',
    '플레이리스트',
    '노래',
    '음원',
  ];

  const scored = tracks.map((track, originalIdx) => {
    const titleLow = track.title.toLowerCase();
    const channelLow = track.channel.toLowerCase();
    let score = Math.max(0, 45 - originalIdx * 0.6);

    for (const tok of tokens) {
      if (titleLow.includes(tok)) score += 16;
      if (channelLow.includes(tok)) score += 12;
    }

    if (musicFocus) {
      for (const sig of musicSignals) {
        if (titleLow.includes(sig) || channelLow.includes(sig)) {
          score += 7;
        }
      }
    }

    if (preferredChannels.has(channelLow)) {
      score += 22;
    }

    const views = parseViewCount(track.viewCountText);
    if (views > 0) {
      score += Math.min(18, Math.log10(views + 1) * 2.2);
    }

    // Demote tiny shorts (< 30s) in standard music search unless live (0s)
    if (track.durationSeconds > 0 && track.durationSeconds < 30) {
      score -= 25;
    } else if (track.durationSeconds >= 90 && track.durationSeconds <= 600) {
      score += 6;
    }

    return {track, score};
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.track);
}

async function searchWithDataApi(query: string, apiKey: string, limit = 24): Promise<YouTubeTrack[]> {
  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('videoCategoryId', '10');
  searchUrl.searchParams.set('maxResults', String(limit));
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('key', apiKey);

  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) {
    throw new Error(`YouTube API search failed: ${searchRes.status}`);
  }
  const searchData = (await searchRes.json()) as {
    items?: Array<{
      id?: {videoId?: string};
      snippet?: {
        title?: string;
        channelTitle?: string;
        channelId?: string;
        thumbnails?: {high?: {url?: string}; medium?: {url?: string}};
      };
    }>;
  };

  const ids = (searchData.items || [])
    .map((item) => item.id?.videoId)
    .filter((id): id is string => Boolean(id));

  if (ids.length === 0) return [];

  const videosUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  videosUrl.searchParams.set('part', 'contentDetails,statistics');
  videosUrl.searchParams.set('id', ids.join(','));
  videosUrl.searchParams.set('key', apiKey);

  const videosRes = await fetch(videosUrl);
  const detailsMap = new Map<string, {durationSeconds: number; viewCountText: string}>();
  if (videosRes.ok) {
    const videosData = (await videosRes.json()) as {
      items?: Array<{
        id?: string;
        contentDetails?: {duration?: string};
        statistics?: {viewCount?: string};
      }>;
    };
    for (const item of videosData.items || []) {
      if (!item.id) continue;
      const durSec = parseIsoDuration(item.contentDetails?.duration || '');
      const views = item.statistics?.viewCount
        ? `${Number.parseInt(item.statistics.viewCount, 10).toLocaleString()}회`
        : '';
      detailsMap.set(item.id, {durationSeconds: durSec, viewCountText: views});
    }
  }

  return (searchData.items || [])
    .map((item) => {
      const id = item.id?.videoId;
      if (!id) return null;
      const detail = detailsMap.get(id);
      const durationSeconds = detail?.durationSeconds || 0;
      return {
        id,
        title: item.snippet?.title || '제목 없음',
        channel: item.snippet?.channelTitle || 'YouTube',
        ...(item.snippet?.channelId ? {channelId: item.snippet.channelId} : {}),
        duration: formatDuration(durationSeconds),
        durationSeconds,
        thumbnail:
          item.snippet?.thumbnails?.high?.url ||
          item.snippet?.thumbnails?.medium?.url ||
          `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        viewCountText: detail?.viewCountText || '',
      };
    })
    .filter((t): t is YouTubeTrack => t !== null);
}

function findSearchContinuationToken(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findSearchContinuationToken(item);
      if (found) return found;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const contItem = record.continuationItemRenderer as Record<string, unknown> | undefined;
  const endpoint = contItem?.continuationEndpoint as Record<string, unknown> | undefined;
  const cmd = endpoint?.continuationCommand as Record<string, unknown> | undefined;
  if (typeof cmd?.token === 'string' && cmd.token.length > 0) {
    return cmd.token;
  }
  for (const val of Object.values(record)) {
    if (val && typeof val === 'object') {
      const found = findSearchContinuationToken(val);
      if (found) return found;
    }
  }
  return null;
}

function encodeSearchCursor(payload: SearchCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeSearchCursor(cursor: string): SearchCursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<SearchCursorPayload>;
    if (
      typeof parsed.t === 'string' &&
      parsed.t.length > 0 &&
      typeof parsed.k === 'string' &&
      parsed.k.length > 0 &&
      typeof parsed.v === 'string' &&
      parsed.v.length > 0
    ) {
      return {t: parsed.t, k: parsed.k, v: parsed.v};
    }
  } catch {
    // Invalid cursor
  }
  return null;
}

async function fetchYouTubeContinuationPage(
  token: string,
  apiKey: string,
  clientVersion: string,
  seen: Set<string>,
  maxCollect = 30,
): Promise<{tracks: YouTubeTrack[]; nextToken: string | null}> {
  const response = await fetch(
    `https://www.youtube.com/youtubei/v1/search?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion,
            hl: 'ko',
            gl: 'KR',
          },
        },
        continuation: token,
      }),
    },
  );

  if (!response.ok) {
    return {tracks: [], nextToken: null};
  }

  const json = (await response.json()) as Record<string, unknown>;
  const tracks: YouTubeTrack[] = [];
  collectRenderers(json, seen, tracks, maxCollect);
  const nextToken = findSearchContinuationToken(json);
  return {tracks, nextToken};
}

async function fetchYouTubeInitialPage(
  query: string,
  sort: 'relevance' | 'popular' | 'recent',
  seen: Set<string>,
  maxCollect = 30,
): Promise<{tracks: YouTubeTrack[]; apiKey: string | null; clientVersion: string; nextToken: string | null}> {
  const sp =
    sort === 'popular'
      ? 'CAMSAhAB'
      : sort === 'recent'
        ? 'CAISAhAB'
        : 'EgIQAQ%3D%3D';

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${sp}`;
  const response = await fetch(searchUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  if (!response.ok) {
    throw new Error(`YouTube search HTTP ${response.status}`);
  }

  const html = await response.text();
  const apiKeyMatch = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html);
  const verMatch = /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html);
  const apiKey = apiKeyMatch?.[1] || null;
  const clientVersion = verMatch?.[1] || '2.20261119.07.00';

  const initialData = extractJsonAssignment(html, 'ytInitialData');
  const tracks: YouTubeTrack[] = [];
  let nextToken: string | null = null;
  if (initialData) {
    collectRenderers(initialData, seen, tracks, maxCollect);
    nextToken = findSearchContinuationToken(initialData);
  }

  return {tracks, apiKey, clientVersion, nextToken};
}

async function searchYouTubePaginated(
  query: string,
  minTarget = 40,
  sort: 'relevance' | 'popular' | 'recent' = 'relevance',
): Promise<SearchPageResult> {
  const cacheKey = `search:${query.toLowerCase()}:${sort}:${minTarget}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const dataApiKey = process.env.YOUTUBE_API_KEY;
  if (dataApiKey && sort === 'relevance') {
    try {
      const tracks = await searchWithDataApi(query, dataApiKey, Math.max(40, minTarget));
      if (tracks.length >= 30) {
        const result: SearchPageResult = {tracks, nextCursor: null};
        searchCache.set(cacheKey, {expiresAt: Date.now() + CACHE_TTL_MS, data: result});
        return result;
      }
    } catch (err) {
      console.warn('YouTube Data API fallback to public search:', err);
    }
  }

  const seen = new Set<string>();
  const allTracks: YouTubeTrack[] = [];

  const first = await fetchYouTubeInitialPage(query, sort, seen, 30);
  allTracks.push(...first.tracks);

  let nextToken = first.nextToken;
  const apiKey = first.apiKey;
  const clientVersion = first.clientVersion;

  // Automatically fetch continuation pages so initial search provides 30+ unique results (target ~40)
  let pageCount = 1;
  while (allTracks.length < minTarget && nextToken && apiKey && pageCount < 4) {
    pageCount++;
    try {
      const page = await fetchYouTubeContinuationPage(nextToken, apiKey, clientVersion, seen, 30);
      if (page.tracks.length === 0) {
        nextToken = page.nextToken;
        if (!nextToken) break;
        continue;
      }
      allTracks.push(...page.tracks);
      nextToken = page.nextToken;
    } catch {
      break;
    }
  }

  // If a very narrow query returned < 30 unique tracks, supplement with a broader music query
  if (allTracks.length < 30) {
    const hasKorean = /[가-힣]/.test(query);
    const supplementQuery = hasKorean ? `${query} 노래` : `${query} music`;
    if (supplementQuery.toLowerCase() !== query.toLowerCase()) {
      try {
        const supp = await fetchYouTubeInitialPage(supplementQuery, sort, seen, 35 - allTracks.length);
        allTracks.push(...supp.tracks);
        if (!nextToken && supp.nextToken && supp.apiKey) {
          nextToken = supp.nextToken;
        }
      } catch {
        // Ignore supplement failures
      }
    }
  }

  const nextCursor =
    nextToken && apiKey
      ? encodeSearchCursor({t: nextToken, k: apiKey, v: clientVersion})
      : null;

  const result: SearchPageResult = {tracks: allTracks, nextCursor};
  if (allTracks.length > 0) {
    searchCache.set(cacheKey, {expiresAt: Date.now() + CACHE_TTL_MS, data: result});
  }
  return result;
}

async function searchYouTubeContinuationByCursor(
  cursor: string,
  excludeIds: Set<string>,
): Promise<SearchPageResult> {
  const payload = decodeSearchCursor(cursor);
  if (!payload) {
    return {tracks: [], nextCursor: null};
  }

  const seen = new Set<string>(excludeIds);
  const collected: YouTubeTrack[] = [];
  let token: string | null = payload.t;
  let attempts = 0;

  while (token && collected.length < 18 && attempts < 2) {
    attempts++;
    const page = await fetchYouTubeContinuationPage(token, payload.k, payload.v, seen, 30);
    collected.push(...page.tracks);
    token = page.nextToken;
    if (page.tracks.length === 0 && !token) break;
  }

  const nextCursor = token
    ? encodeSearchCursor({t: token, k: payload.k, v: payload.v})
    : null;

  return {tracks: collected, nextCursor};
}

async function searchYouTubeChannels(query: string, limit = 16): Promise<YouTubeChannel[]> {
  const cacheKey = `ch:${query.toLowerCase()}:${limit}`;
  const cached = channelSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%3D%3D`;
  const response = await fetch(searchUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  if (!response.ok) {
    throw new Error(`YouTube channel search HTTP ${response.status}`);
  }

  const html = await response.text();
  const initialData = extractJsonAssignment(html, 'ytInitialData');
  const channels: YouTubeChannel[] = [];
  if (initialData) {
    collectChannels(initialData, new Set<string>(), channels, limit);
  }

  if (channels.length > 0) {
    channelSearchCache.set(cacheKey, {expiresAt: Date.now() + CACHE_TTL_MS, data: channels});
  }
  return channels;
}

function normalizeYtThumbUrl(url: string): string {
  if (!url) return '';
  return url.startsWith('//') ? `https:${url}` : url;
}

function getSelectedBrowseTab(
  initialData: Record<string, unknown> | null,
): {tab: Record<string, unknown>; title: string; url: string} | null {
  if (!initialData) return null;
  const twoCol = (initialData.contents as Record<string, unknown> | undefined)
    ?.twoColumnBrowseResultsRenderer as Record<string, unknown> | undefined;
  const tabs = twoCol?.tabs as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tabs)) return null;

  for (const item of tabs) {
    const tab = item.tabRenderer as Record<string, unknown> | undefined;
    if (tab && tab.selected === true) {
      const title = typeof tab.title === 'string' ? tab.title.trim() : extractText(tab.title).trim();
      const url = String(
        (
          (tab.endpoint as Record<string, unknown> | undefined)
            ?.commandMetadata as Record<string, unknown> | undefined
        )?.webCommandMetadata
          ? (
              (
                (tab.endpoint as Record<string, unknown> | undefined)
                  ?.commandMetadata as Record<string, unknown> | undefined
              )?.webCommandMetadata as Record<string, unknown>
            ).url || ''
          : '',
      );
      return {tab, title, url};
    }
  }
  return null;
}

function extractChannelHeaderMeta(initialData: Record<string, unknown> | null): {
  channelTitle: string;
  subscriberText: string;
  thumbnail: string;
} {
  let channelTitle = '';
  let subscriberText = '';
  let thumbnail = '';
  if (!initialData) return {channelTitle, subscriberText, thumbnail};

  const metadata = (initialData.metadata as Record<string, unknown> | undefined)
    ?.channelMetadataRenderer as Record<string, unknown> | undefined;
  if (metadata) {
    if (typeof metadata.title === 'string') channelTitle = metadata.title.trim();
    const thumbs = (metadata.avatar as Record<string, unknown> | undefined)
      ?.thumbnails as Array<{url?: string}> | undefined;
    if (thumbs?.length) {
      thumbnail = normalizeYtThumbUrl(thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || '');
    }
  }

  const header = (initialData.header as Record<string, unknown> | undefined)
    ?.pageHeaderRenderer as Record<string, unknown> | undefined;
  if (header) {
    const pageTitle = extractText(header.pageTitle).trim();
    if (pageTitle) channelTitle = pageTitle;

    const metaRows = (
      (
        (header.content as Record<string, unknown> | undefined)
          ?.pageHeaderViewModel as Record<string, unknown> | undefined
      )?.metadata as Record<string, unknown> | undefined
    )?.contentMetadataViewModel as Record<string, unknown> | undefined;
    const rows = metaRows?.metadataRows as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(rows)) {
      const partsText: string[] = [];
      for (const row of rows) {
        const parts = row.metadataParts as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
          const t = extractText(p.text).trim();
          if (t && !t.startsWith('@') && (t.includes('구독자') || t.includes('subscriber') || t.includes('동영상') || t.includes('video'))) {
            partsText.push(t);
          }
        }
      }
      if (partsText.length > 0) {
        subscriberText = partsText.join(' · ');
      }
    }
  }

  const c4 = (initialData.header as Record<string, unknown> | undefined)
    ?.c4TabbedHeaderRenderer as Record<string, unknown> | undefined;
  if (c4) {
    if (!channelTitle && typeof c4.title === 'string') channelTitle = c4.title.trim();
    if (!subscriberText) subscriberText = extractText(c4.subscriberCountText).trim();
  }

  return {channelTitle, subscriberText, thumbnail};
}

function collectChannelCollections(
  node: unknown,
  kind: 'playlist' | 'release',
  channelTitle: string,
  seen: Set<string>,
  out: ChannelCollectionItem[],
  maxItems: number,
): void {
  if (!node || typeof node !== 'object' || out.length >= maxItems) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (out.length >= maxItems) break;
      collectChannelCollections(item, kind, channelTitle, seen, out, maxItems);
    }
    return;
  }

  const record = node as Record<string, unknown>;

  // 1) Classic playlistRenderer / gridPlaylistRenderer (used heavily in /releases and some /playlists)
  const plRenderer = (record.playlistRenderer || record.gridPlaylistRenderer) as
    | Record<string, unknown>
    | undefined;
  if (plRenderer && typeof plRenderer.playlistId === 'string') {
    const id = plRenderer.playlistId.trim();
    if (id && !seen.has(id)) {
      const title = extractText(plRenderer.title).trim();
      const watchEndpoint = (
        plRenderer.navigationEndpoint as Record<string, unknown> | undefined
      )?.watchEndpoint as Record<string, unknown> | undefined;
      const seedVideoId =
        typeof watchEndpoint?.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(watchEndpoint.videoId)
          ? watchEndpoint.videoId
          : undefined;

      // Pick best thumbnail
      let thumbnail = '';
      const thumbGroups = plRenderer.thumbnails as Array<{thumbnails?: Array<{url?: string}>}> | undefined;
      if (Array.isArray(thumbGroups) && thumbGroups[0]?.thumbnails?.length) {
        const arr = thumbGroups[0].thumbnails;
        thumbnail = normalizeYtThumbUrl(arr[arr.length - 1]?.url || arr[0]?.url || '');
      }
      if (!thumbnail) {
        const singleThumb = (plRenderer.thumbnail as Record<string, unknown> | undefined)
          ?.thumbnails as Array<{url?: string}> | undefined;
        if (singleThumb?.length) {
          thumbnail = normalizeYtThumbUrl(singleThumb[singleThumb.length - 1]?.url || singleThumb[0]?.url || '');
        }
      }
      if (!thumbnail && seedVideoId) {
        thumbnail = `https://i.ytimg.com/vi/${seedVideoId}/hqdefault.jpg`;
      }

      const rawCount =
        typeof plRenderer.videoCount === 'string' && plRenderer.videoCount.trim()
          ? `${plRenderer.videoCount.trim()}곡`
          : '';
      const countText = extractText(plRenderer.videoCountText).trim();
      const bylineText = (
        extractText(plRenderer.shortBylineText) ||
        extractText(plRenderer.longBylineText) ||
        extractText(plRenderer.publishedTimeText)
      ).trim();

      let videoCountText = rawCount || countText;
      let subtitle = '';
      if (kind === 'release') {
        const cleanedMeta = bylineText || (countText && !countText.includes('곡') && !countText.includes('개') ? countText : '');
        subtitle = cleanedMeta ? cleanedMeta.replace(/\s*•\s*/g, ' · ') : '공식 발표곡';
        if (!videoCountText) videoCountText = '수록곡 모음';
      } else {
        subtitle = bylineText || '채널 재생목록';
        if (!videoCountText) videoCountText = '재생목록';
      }

      if (title) {
        seen.add(id);
        out.push({
          id,
          kind,
          title,
          subtitle,
          videoCountText,
          thumbnail,
          ...(seedVideoId ? {seedVideoId} : {}),
          ...(channelTitle ? {channelTitle} : {}),
        });
      }
    }
  }

  // 2) Modern lockupViewModel (used in /playlists and occasionally /releases)
  const lockup = record.lockupViewModel as Record<string, unknown> | undefined;
  if (lockup && typeof lockup.contentId === 'string') {
    const onTapCommand = (
      (lockup.rendererContext as Record<string, unknown> | undefined)
        ?.commandContext as Record<string, unknown> | undefined
    )?.onTap as Record<string, unknown> | undefined;
    const innertubeCmd = onTapCommand?.innertubeCommand as Record<string, unknown> | undefined;
    const watchEndpoint = innertubeCmd?.watchEndpoint as Record<string, unknown> | undefined;
    const playlistId =
      (typeof watchEndpoint?.playlistId === 'string' && watchEndpoint.playlistId.trim()) ||
      (lockup.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' ? lockup.contentId.trim() : '');

    if (playlistId && !seen.has(playlistId)) {
      const metaRoot = (lockup.metadata as Record<string, unknown> | undefined)
        ?.lockupMetadataViewModel as Record<string, unknown> | undefined;
      const title = extractText(metaRoot?.title).trim();
      const seedVideoId =
        typeof watchEndpoint?.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(watchEndpoint.videoId)
          ? watchEndpoint.videoId
          : undefined;

      // Thumbnail from collectionThumbnailViewModel or thumbnailViewModel
      let thumbnail = '';
      const contentImage = lockup.contentImage as Record<string, unknown> | undefined;
      const thumbVm =
        ((contentImage?.collectionThumbnailViewModel as Record<string, unknown> | undefined)
          ?.primaryThumbnail as Record<string, unknown> | undefined)?.thumbnailViewModel ||
        contentImage?.thumbnailViewModel;
      const thumbObj = thumbVm as Record<string, unknown> | undefined;
      const sources = (thumbObj?.image as Record<string, unknown> | undefined)
        ?.sources as Array<{url?: string}> | undefined;
      if (sources?.length) {
        thumbnail = normalizeYtThumbUrl(sources[sources.length - 1]?.url || sources[0]?.url || '');
      }
      if (!thumbnail && seedVideoId) {
        thumbnail = `https://i.ytimg.com/vi/${seedVideoId}/hqdefault.jpg`;
      }

      // Badge text e.g. "동영상 35개"
      let videoCountText = '';
      const overlays = thumbObj?.overlays as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(overlays)) {
        for (const ov of overlays) {
          const badges = (ov.thumbnailOverlayBadgeViewModel as Record<string, unknown> | undefined)
            ?.thumbnailBadges as Array<Record<string, unknown>> | undefined;
          const badgeText = (badges?.[0]?.thumbnailBadgeViewModel as Record<string, unknown> | undefined)
            ?.text;
          if (typeof badgeText === 'string' && badgeText.trim()) {
            videoCountText = badgeText.trim();
            break;
          }
        }
      }

      // Metadata rows
      const metaDetails: string[] = [];
      const metaRows = ((metaRoot?.metadata as Record<string, unknown> | undefined)
        ?.contentMetadataViewModel as Record<string, unknown> | undefined)
        ?.metadataRows as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(metaRows)) {
        for (const row of metaRows) {
          const parts = row.metadataParts as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(parts)) continue;
          for (const part of parts) {
            const text = extractText(part.text).trim();
            if (
              text &&
              text !== '전체 재생목록 보기' &&
              text !== 'View full playlist' &&
              text !== '재생목록' &&
              text !== 'Playlist'
            ) {
              metaDetails.push(text);
            }
          }
        }
      }

      const subtitle =
        metaDetails.join(' · ') || (kind === 'release' ? '공식 발표곡' : '채널 재생목록');

      if (title) {
        seen.add(playlistId);
        out.push({
          id: playlistId,
          kind,
          title,
          subtitle,
          videoCountText: videoCountText || (kind === 'release' ? '수록곡 모음' : '재생목록'),
          thumbnail,
          ...(seedVideoId ? {seedVideoId} : {}),
          ...(channelTitle ? {channelTitle} : {}),
        });
      }
    }
  }

  for (const val of Object.values(record)) {
    if (out.length >= maxItems) break;
    if (val && typeof val === 'object') {
      collectChannelCollections(val, kind, channelTitle, seen, out, maxItems);
    }
  }
}

async function fetchChannelTabPage(
  channelId: string,
  tabSlug: 'videos' | 'playlists' | 'releases',
): Promise<Record<string, unknown> | null> {
  const url = `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/${tabSlug}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  if (!response.ok) return null;
  const html = await response.text();
  return extractJsonAssignment(html, 'ytInitialData');
}

async function fetchChannelDetail(channelId: string, limit = 36): Promise<ChannelDetailPayload> {
  const cacheKey = `chdetail:${channelId}`;
  const cached = channelDetailCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const [videosData, playlistsData, releasesData] = await Promise.all([
    fetchChannelTabPage(channelId, 'videos').catch(() => null),
    fetchChannelTabPage(channelId, 'playlists').catch(() => null),
    fetchChannelTabPage(channelId, 'releases').catch(() => null),
  ]);

  if (!videosData && !playlistsData && !releasesData) {
    throw new Error('YouTube 채널 정보를 불러오지 못했습니다.');
  }

  const primaryMetaSource = videosData || playlistsData || releasesData;
  const headerMeta = extractChannelHeaderMeta(primaryMetaSource);
  const channelTitle = headerMeta.channelTitle || 'YouTube 채널';
  const subscriberText = headerMeta.subscriberText;
  const thumbnail = headerMeta.thumbnail;

  // 1) Videos tab
  const videos: YouTubeTrack[] = [];
  if (videosData) {
    const selectedTab = getSelectedBrowseTab(videosData);
    const scopeNode = selectedTab?.tab || videosData;
    collectRenderers(scopeNode, new Set<string>(), videos, limit);
    for (const t of videos) {
      if (t.channel === 'YouTube' && channelTitle) {
        t.channel = channelTitle;
      }
      if (!t.channelId) t.channelId = channelId;
    }
  }

  // 2) Playlists tab (verify YouTube actually landed on Playlists rather than falling back to Home)
  const playlists: ChannelCollectionItem[] = [];
  if (playlistsData) {
    const selectedTab = getSelectedBrowseTab(playlistsData);
    const isPlaylistTab =
      !selectedTab ||
      selectedTab.url.includes('/playlists') ||
      selectedTab.title === '재생목록' ||
      selectedTab.title.toLowerCase() === 'playlists';
    if (isPlaylistTab) {
      collectChannelCollections(
        selectedTab?.tab || playlistsData,
        'playlist',
        channelTitle,
        new Set<string>(),
        playlists,
        30,
      );
    }
  }

  // 3) Releases tab (only collect if this channel genuinely has a Releases / 발표곡 tab)
  const releases: ChannelCollectionItem[] = [];
  if (releasesData) {
    const selectedTab = getSelectedBrowseTab(releasesData);
    const isReleaseTab = Boolean(
      selectedTab &&
        (selectedTab.url.includes('/releases') ||
          selectedTab.title === '발표곡' ||
          selectedTab.title.toLowerCase() === 'releases'),
    );
    if (isReleaseTab && selectedTab) {
      collectChannelCollections(
        selectedTab.tab,
        'release',
        channelTitle,
        new Set<string>(),
        releases,
        30,
      );
    }
  }

  const result: ChannelDetailPayload = {
    channelId,
    channelTitle,
    subscriberText,
    thumbnail,
    tracks: videos,
    videos,
    playlists,
    releases,
    hasReleases: releases.length > 0,
  };

  if (videos.length > 0 || playlists.length > 0 || releases.length > 0) {
    channelDetailCache.set(cacheKey, {expiresAt: Date.now() + CACHE_TTL_MS, data: result});
  }
  return result;
}

async function fetchVideoMetadata(videoId: string): Promise<YouTubeTrack> {
  const fallback: YouTubeTrack = {
    id: videoId,
    title: `YouTube Track (${videoId})`,
    channel: 'YouTube',
    duration: '0:00',
    durationSeconds: 0,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    viewCountText: '',
  };

  try {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const res = await fetch(watchUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    if (res.ok) {
      const html = await res.text();
      const playerResponse = extractJsonAssignment(html, 'ytInitialPlayerResponse');
      const details = playerResponse?.videoDetails as Record<string, unknown> | undefined;
      if (details) {
        const lenSec = Number.parseInt(String(details.lengthSeconds || '0'), 10);
        return {
          id: videoId,
          title: typeof details.title === 'string' ? details.title : fallback.title,
          channel: typeof details.author === 'string' ? details.author : fallback.channel,
          ...(typeof details.channelId === 'string' ? {channelId: details.channelId} : {}),
          duration: formatDuration(Number.isNaN(lenSec) ? 0 : lenSec),
          durationSeconds: Number.isNaN(lenSec) ? 0 : lenSec,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          viewCountText: '',
        };
      }
    }
  } catch {
    // Fall through to oEmbed
  }

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}&format=json`;
    const res = await fetch(oembedUrl, {headers: {'User-Agent': USER_AGENT}});
    if (res.ok) {
      const data = (await res.json()) as {title?: string; author_name?: string; thumbnail_url?: string};
      return {
        ...fallback,
        title: data.title || fallback.title,
        channel: data.author_name || fallback.channel,
        thumbnail: data.thumbnail_url || fallback.thumbnail,
      };
    }
  } catch {
    // Return fallback
  }

  return fallback;
}

function findFirstWatchVideoId(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstWatchVideoId(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const watchEp = record.watchEndpoint as Record<string, unknown> | undefined;
  if (watchEp && typeof watchEp.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(watchEp.videoId)) {
    return watchEp.videoId;
  }
  const lockup = record.lockupViewModel as Record<string, unknown> | undefined;
  if (
    lockup &&
    typeof lockup.contentId === 'string' &&
    lockup.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST' &&
    /^[a-zA-Z0-9_-]{11}$/.test(lockup.contentId)
  ) {
    return lockup.contentId;
  }
  for (const val of Object.values(record)) {
    const found = findFirstWatchVideoId(val);
    if (found) return found;
  }
  return undefined;
}

async function fetchPlaylistTracks(
  listId: string,
  limit = 60,
  seedVideoId?: string,
  fallbackChannelTitle?: string,
): Promise<{title: string; tracks: YouTubeTrack[]}> {
  const cacheKey = `pl:${listId}:${limit}`;
  const cached = playlistCollectionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  };

  let playlistTitle = 'YouTube 재생목록';
  let tracks: YouTubeTrack[] = [];
  let discoveredSeed =
    seedVideoId && /^[a-zA-Z0-9_-]{11}$/.test(seedVideoId) ? seedVideoId : undefined;

  // 1) For OLAK releases or when seedVideoId is already known, /watch?v=seed&list=listId reliably exposes
  // the exact ordered playlistPanelVideoRenderer list (and we can still fall back to /playlist?list=).
  if (discoveredSeed) {
    try {
      const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(
        discoveredSeed,
      )}&list=${encodeURIComponent(listId)}`;
      const wRes = await fetch(watchUrl, {signal: AbortSignal.timeout(8000), headers});
      if (wRes.ok) {
        const wHtml = await wRes.text();
        const wData = extractJsonAssignment(wHtml, 'ytInitialData');
        if (wData) {
          const panel = (
            (
              (
                (wData.contents as Record<string, unknown> | undefined)
                  ?.twoColumnWatchNextResults as Record<string, unknown> | undefined
              )?.playlist as Record<string, unknown> | undefined
            )?.playlist as Record<string, unknown> | undefined
          );
          if (panel) {
            const pTitle =
              (typeof panel.title === 'string' && panel.title.trim()) ||
              extractText(panel.titleText).trim();
            if (pTitle) playlistTitle = pTitle;
            collectRenderers(panel, new Set<string>(), tracks, limit);
          }
        }
      }
    } catch {
      // Fall through to /playlist?list=
    }
  }

  // 2) Fetch /playlist?list= if panel gave no tracks (or seed was missing)
  if (tracks.length === 0) {
    const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
    const res = await fetch(playlistUrl, {signal: AbortSignal.timeout(8000), headers});
    if (!res.ok) {
      throw new Error(`YouTube playlist HTTP ${res.status}`);
    }
    const html = await res.text();
    const initialData = extractJsonAssignment(html, 'ytInitialData');

    if (initialData) {
      const metadata = initialData.metadata as Record<string, unknown> | undefined;
      const renderer = metadata?.playlistMetadataRenderer as Record<string, unknown> | undefined;
      if (renderer && typeof renderer.title === 'string' && renderer.title.trim()) {
        playlistTitle = renderer.title.trim();
      }
      collectRenderers(initialData, new Set<string>(), tracks, limit);

      // YouTube now renders some playlists/OLAK albums with lockupViewModel without durations on /playlist,
      // or empty playlistVideoRenderer; if tracks are empty or missing durations, try /watch?v=seed&list=.
      const hasMissingDurations = tracks.length > 0 && tracks.every((t) => t.durationSeconds === 0);
      if (tracks.length === 0 || hasMissingDurations) {
        const fallbackSeed = tracks[0]?.id || discoveredSeed || findFirstWatchVideoId(initialData);
        if (fallbackSeed) {
          try {
            const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(
              fallbackSeed,
            )}&list=${encodeURIComponent(listId)}`;
            const wRes = await fetch(watchUrl, {signal: AbortSignal.timeout(8000), headers});
            if (wRes.ok) {
              const wHtml = await wRes.text();
              const wData = extractJsonAssignment(wHtml, 'ytInitialData');
              const panel = (
                (
                  (
                    (wData?.contents as Record<string, unknown> | undefined)
                      ?.twoColumnWatchNextResults as Record<string, unknown> | undefined
                  )?.playlist as Record<string, unknown> | undefined
                )?.playlist as Record<string, unknown> | undefined
              );
              if (panel) {
                const panelTracks: YouTubeTrack[] = [];
                collectRenderers(panel, new Set<string>(), panelTracks, limit);
                if (panelTracks.length >= tracks.length) {
                  tracks = panelTracks;
                }
              }
            }
          } catch {
            // Keep tracks from /playlist?list=
          }
        }
      }
    }
  }

  if (fallbackChannelTitle) {
    for (const t of tracks) {
      if (t.channel === 'YouTube') {
        t.channel = fallbackChannelTitle;
      }
    }
  }

  const result = {title: playlistTitle, tracks};
  if (tracks.length > 0) {
    playlistCollectionCache.set(cacheKey, {expiresAt: Date.now() + CACHE_TTL_MS, data: result});
  }
  return result;
}

function parseYouTubeUrl(input: string): {videoId?: string; listId?: string} {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return {videoId: trimmed};
  }
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const listId = url.searchParams.get('list') || undefined;
    let videoId = url.searchParams.get('v') || undefined;

    if (!videoId && url.hostname.includes('youtu.be')) {
      const seg = url.pathname.split('/').filter(Boolean)[0];
      if (seg && /^[a-zA-Z0-9_-]{11}$/.test(seg)) videoId = seg;
    }
    if (
      !videoId &&
      (url.pathname.startsWith('/shorts/') ||
        url.pathname.startsWith('/live/') ||
        url.pathname.startsWith('/embed/'))
    ) {
      const seg = url.pathname.split('/').filter(Boolean)[1];
      if (seg && /^[a-zA-Z0-9_-]{11}$/.test(seg)) videoId = seg;
    }
    return {videoId, listId};
  } catch {
    return {};
  }
}

const CURATED_QUERIES: Record<string, string> = {
  recommended: '감성 플레이리스트 노래 모음 youtube music',
  lofi: 'lofi hip hop beats chill study music',
  kpop: 'kpop R&B chill playlist 2025 2026',
  jazz: 'late night jazz piano instrumental music',
  indie: '한국 인디 음악 어쿠스틱 플레이리스트',
};

function isAllowedGoogleVideoUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname.endsWith('.googlevideo.com');
  } catch {
    return false;
  }
}

let cachedVisitorData: {value: string; expiresAt: number} | null = null;

async function getYouTubeVisitorData(): Promise<string> {
  if (cachedVisitorData && cachedVisitorData.expiresAt > Date.now()) {
    return cachedVisitorData.value;
  }
  try {
    const resp = await fetch('https://www.youtube.com/sw.js_data', {
      signal: AbortSignal.timeout(3500),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
      },
    });
    if (resp.ok) {
      const txt = await resp.text();
      const match = /"(Cg[a-zA-Z0-9%_-]{12,})"/.exec(txt);
      if (match?.[1]) {
        cachedVisitorData = {value: match[1], expiresAt: Date.now() + 20 * 60 * 1000};
        return match[1];
      }
    }
  } catch {
    // Fallback cleanly without visitorData
  }
  return '';
}

async function resolveYouTubeAudioStream(
  videoId: string,
  bypassCache = false,
): Promise<AudioStreamEntry | null> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;

  if (!bypassCache) {
    const cached = audioStreamCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }

  const optionalCookies = (process.env.YOUTUBE_COOKIES || '').trim();
  const visitorData = await getYouTubeVisitorData();

  const clients: Array<{
    endpoint?: string;
    userAgent: string;
    extraHeaders?: Record<string, string>;
    client: Record<string, unknown>;
  }> = [
    {
      userAgent:
        'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.61.48',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        osName: 'Android',
        osVersion: '12L',
        androidSdkVersion: 32,
        hl: 'ko',
        gl: 'KR',
        ...(visitorData ? {visitorData} : {}),
      },
    },
    {
      userAgent:
        'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
      extraHeaders: {
        'X-YouTube-Client-Name': '5',
        'X-YouTube-Client-Version': '20.10.4',
      },
      client: {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18.3.2.22D82',
        hl: 'ko',
        gl: 'KR',
        ...(visitorData ? {visitorData} : {}),
      },
    },
    {
      endpoint: 'https://music.youtube.com/youtubei/v1/player?prettyPrint=false',
      userAgent:
        'com.google.android.apps.youtube.music/7.29.52 (Linux; U; Android 14; gzip)',
      extraHeaders: {
        'X-YouTube-Client-Name': '21',
        'X-YouTube-Client-Version': '7.29.52',
      },
      client: {
        clientName: 'ANDROID_MUSIC',
        clientVersion: '7.29.52',
        androidSdkVersion: 34,
        osName: 'Android',
        osVersion: '14',
        hl: 'ko',
        gl: 'KR',
        ...(visitorData ? {visitorData} : {}),
      },
    },
    {
      endpoint: 'https://music.youtube.com/youtubei/v1/player?prettyPrint=false',
      userAgent:
        'com.google.ios.youtubemusic/7.29.1 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)',
      extraHeaders: {
        'X-YouTube-Client-Name': '26',
        'X-YouTube-Client-Version': '7.29.1',
      },
      client: {
        clientName: 'IOS_MUSIC',
        clientVersion: '7.29.1',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18.3',
        hl: 'ko',
        gl: 'KR',
        ...(visitorData ? {visitorData} : {}),
      },
    },
  ];

  for (const cfg of clients) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': cfg.userAgent,
        ...(visitorData ? {'X-Goog-Visitor-Id': visitorData} : {}),
        ...(optionalCookies ? {Cookie: optionalCookies} : {}),
        ...(cfg.extraHeaders || {}),
      };
      const resp = await fetch(
        cfg.endpoint || 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        {
          method: 'POST',
          signal: AbortSignal.timeout(4500),
          headers,
          body: JSON.stringify({
            videoId,
            context: {client: cfg.client},
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        },
      );
      if (!resp.ok) continue;

      const data = (await resp.json()) as {
        playabilityStatus?: {status?: string};
        streamingData?: {
          adaptiveFormats?: Array<{
            url?: string;
            mimeType?: string;
            bitrate?: number;
            contentLength?: string;
          }>;
        };
      };

      if (data.playabilityStatus?.status !== 'OK') continue;
      const adaptive = data.streamingData?.adaptiveFormats || [];
      const audioFormats = adaptive.filter(
        (f) =>
          typeof f.url === 'string' &&
          f.mimeType?.startsWith('audio/') &&
          isAllowedGoogleVideoUrl(f.url),
      );
      if (audioFormats.length === 0) continue;

      // Prefer audio/mp4 (AAC) for universal Safari/iOS + Android Chrome background compatibility
      const mp4Formats = audioFormats
        .filter((f) => f.mimeType?.includes('audio/mp4'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const webmFormats = audioFormats
        .filter((f) => f.mimeType?.includes('audio/webm'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const chosen = mp4Formats[0] || webmFormats[0] || audioFormats[0];
      if (!chosen?.url) continue;

      const entry: AudioStreamEntry = {
        url: chosen.url,
        mimeType: (chosen.mimeType || 'audio/mp4').split(';')[0].trim(),
        bitrate: chosen.bitrate || 0,
        contentLength: chosen.contentLength,
      };
      audioStreamCache.set(videoId, {expiresAt: Date.now() + STREAM_CACHE_TTL_MS, data: entry});
      return entry;
    } catch {
      // Try next Innertube client
    }
  }

  audioStreamCache.set(videoId, {expiresAt: Date.now() + STREAM_FAIL_TTL_MS, data: null});
  return null;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChartText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function buildTitleKeys(rawTitle: string): string[] {
  const keys = new Set<string>();
  const full = normalizeChartText(rawTitle);
  if (full) keys.add(full);

  const withoutParens = normalizeChartText(
    rawTitle.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' '),
  );
  if (withoutParens.length >= 2) keys.add(withoutParens);

  const parenMatches = [...rawTitle.matchAll(/\(([^)]+)\)/g)];
  for (const m of parenMatches) {
    const inner = m[1].trim();
    if (/^(?:feat|ft|prod|narr|with|ver|inst|remix)\b/i.test(inner)) continue;
    const normInner = normalizeChartText(inner);
    if (normInner.length >= 2) keys.add(normInner);
  }
  return [...keys];
}

function buildArtistTokens(rawArtist: string): string[] {
  const tokens = new Set<string>();
  const parts = rawArtist
    .split(/[,&/]|\bfeat\.?\b|\bft\.?\b|\bwith\b/i)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    const full = normalizeChartText(part);
    if (full.length >= 1) tokens.add(full);
    const base = normalizeChartText(part.replace(/\([^)]*\)/g, ' '));
    if (base.length >= 1) tokens.add(base);
    const paren = [...part.matchAll(/\(([^)]+)\)/g)];
    for (const p of paren) {
      const inner = normalizeChartText(p[1]);
      if (inner.length >= 2) tokens.add(inner);
    }
  }
  if (tokens.size === 0) {
    const fallback = normalizeChartText(rawArtist);
    if (fallback) tokens.add(fallback);
  }
  return [...tokens];
}

async function fetchMelonChart(limit = 30): Promise<RawChartItem[]> {
  const res = await fetch('https://www.melon.com/chart/index.htm', {
    signal: AbortSignal.timeout(7000),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`Melon HTTP ${res.status}`);
  const html = await res.text();
  const rows = html.split(/<tr[^>]*class="lst(?:50|100)"/i).slice(1, limit + 1);
  const out: RawChartItem[] = [];
  rows.forEach((row, idx) => {
    const titleMatch = /class="ellipsis rank01"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(row);
    const artistMatch = /class="ellipsis rank02"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/.exec(row);
    const imgMatch = /<img[^>]*src="([^"]+)"/.exec(row);
    const title = decodeHtmlEntities((titleMatch?.[1] || '').replace(/<[^>]+>/g, ''));
    const artist = decodeHtmlEntities((artistMatch?.[1] || '').replace(/<[^>]+>/g, ''));
    if (title && artist) {
      out.push({
        source: 'melon',
        label: 'Melon',
        rank: idx + 1,
        title,
        artist,
        albumArt: imgMatch?.[1] || '',
      });
    }
  });
  return out;
}

async function fetchGenieChart(limit = 30): Promise<RawChartItem[]> {
  const res = await fetch('https://www.genie.co.kr/chart/top200', {
    signal: AbortSignal.timeout(7000),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`Genie HTTP ${res.status}`);
  const html = await res.text();
  const rows = html.split(/<tr[^>]*class="list"/i).slice(1, limit + 1);
  const out: RawChartItem[] = [];
  rows.forEach((row, idx) => {
    const titleMatch = /class="title ellipsis"[^>]*>([\s\S]*?)<\/a>/.exec(row);
    const artistMatch = /class="artist ellipsis"[^>]*>([\s\S]*?)<\/a>/.exec(row);
    const imgMatch = /class="cover"[\s\S]*?<img[^>]*src="([^"]+)"/.exec(row);
    const title = decodeHtmlEntities((titleMatch?.[1] || '').replace(/<[^>]+>/g, ''));
    const artist = decodeHtmlEntities((artistMatch?.[1] || '').replace(/<[^>]+>/g, ''));
    let albumArt = imgMatch?.[1] || '';
    if (albumArt.startsWith('//')) albumArt = `https:${albumArt}`;
    if (title && artist) {
      out.push({
        source: 'genie',
        label: 'Genie',
        rank: idx + 1,
        title,
        artist,
        albumArt,
      });
    }
  });
  return out;
}

async function fetchFloChart(limit = 30): Promise<RawChartItem[]> {
  const res = await fetch('https://www.music-flo.com/api/display/v1/browser/chart/1/list?mixYn=N', {
    signal: AbortSignal.timeout(7000),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`FLO HTTP ${res.status}`);
  const data = (await res.json()) as {
    data?: {
      trackList?: Array<{
        name?: string;
        representationArtist?: {name?: string};
        album?: {imgList?: Array<{url?: string}>};
      }>;
    };
  };
  const list = (data.data?.trackList || []).slice(0, limit);
  const out: RawChartItem[] = [];
  list.forEach((item, idx) => {
    const title = (item.name || '').trim();
    const artist = (item.representationArtist?.name || '').trim();
    const albumArt = item.album?.imgList?.[1]?.url || item.album?.imgList?.[0]?.url || '';
    if (title && artist) {
      out.push({
        source: 'flo',
        label: 'FLO',
        rank: idx + 1,
        title,
        artist,
        albumArt,
      });
    }
  });
  return out;
}

async function fetchVibeChart(limit = 30): Promise<RawChartItem[]> {
  const res = await fetch(
    `https://apis.naver.com/vibeWeb/musicapiweb/vibe/v1/chart/track/total?start=1&display=${limit}`,
    {
      signal: AbortSignal.timeout(7000),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    },
  );
  if (!res.ok) throw new Error(`VIBE HTTP ${res.status}`);
  const data = (await res.json()) as {
    response?: {
      result?: {
        chart?: {
          items?: {
            tracks?: Array<{
              trackTitle?: string;
              artists?: Array<{artistName?: string}>;
              album?: {imageUrl?: string};
            }>;
          };
        };
      };
    };
  };
  const tracks = (data.response?.result?.chart?.items?.tracks || []).slice(0, limit);
  const out: RawChartItem[] = [];
  tracks.forEach((item, idx) => {
    const title = (item.trackTitle || '').trim();
    const artist = (item.artists || [])
      .map((a) => a.artistName?.trim() || '')
      .filter(Boolean)
      .join(', ');
    const albumArt = item.album?.imageUrl || '';
    if (title && artist) {
      out.push({
        source: 'vibe',
        label: 'VIBE',
        rank: idx + 1,
        title,
        artist,
        albumArt,
      });
    }
  });
  return out;
}

async function fetchAppleMusicKrChart(limit = 30): Promise<RawChartItem[]> {
  const res = await fetch(
    `https://rss.marketingtools.apple.com/api/v2/kr/music/most-played/${limit}/songs.json`,
    {
      signal: AbortSignal.timeout(7000),
      headers: {
        'User-Agent': USER_AGENT,
      },
    },
  );
  if (!res.ok) throw new Error(`Apple Music HTTP ${res.status}`);
  const data = (await res.json()) as {
    feed?: {
      results?: Array<{
        name?: string;
        artistName?: string;
        artworkUrl100?: string;
      }>;
    };
  };
  const results = (data.feed?.results || []).slice(0, limit);
  const out: RawChartItem[] = [];
  results.forEach((item, idx) => {
    const title = (item.name || '').trim();
    const artist = (item.artistName || '').trim();
    const albumArt = item.artworkUrl100
      ? item.artworkUrl100.replace('100x100bb', '240x240bb')
      : '';
    if (title && artist) {
      out.push({
        source: 'apple',
        label: 'Apple Music',
        rank: idx + 1,
        title,
        artist,
        albumArt,
      });
    }
  });
  return out;
}

async function resolveChartTrackOnYouTube(title: string, artist: string): Promise<YouTubeTrack | null> {
  const cleanArtist = artist.split(/[,&]/)[0]?.replace(/\([^)]*\)/g, '').trim() || artist;
  const query = `${title} ${cleanArtist} official audio`;
  const cacheKey = `chart_yt:${query.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && cached.data.tracks[0]) {
    return cached.data.tracks[0];
  }
  try {
    const first = await fetchYouTubeInitialPage(query, 'relevance', new Set<string>(), 8);
    if (first.tracks.length === 0) return null;
    const ranked = rankMusicTracks(first.tracks, `${title} ${cleanArtist}`, true, new Set<string>());
    const best = ranked[0] || first.tracks[0];
    if (best) {
      searchCache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        data: {tracks: [best], nextCursor: null},
      });
    }
    return best || null;
  } catch {
    return null;
  }
}

async function buildUnifiedCharts(forceRefresh = false): Promise<UnifiedChartPayload> {
  if (!forceRefresh && unifiedChartCache && unifiedChartCache.expiresAt > Date.now()) {
    return unifiedChartCache.data;
  }

  const platformFetchers: Array<{
    source: ChartPlatformSource;
    label: string;
    weight: number;
    fn: () => Promise<RawChartItem[]>;
  }> = [
    {source: 'melon', label: 'Melon', weight: 1.2, fn: () => fetchMelonChart(30)},
    {source: 'genie', label: 'Genie', weight: 1.05, fn: () => fetchGenieChart(30)},
    {source: 'flo', label: 'FLO', weight: 1.0, fn: () => fetchFloChart(30)},
    {source: 'vibe', label: 'VIBE', weight: 0.95, fn: () => fetchVibeChart(30)},
    {source: 'apple', label: 'Apple Music', weight: 1.1, fn: () => fetchAppleMusicKrChart(30)},
  ];

  const results = await Promise.allSettled(platformFetchers.map((p) => p.fn()));
  const activeSources: Array<{source: ChartPlatformSource; label: string; count: number}> = [];
  const allItems: Array<RawChartItem & {weight: number}> = [];

  results.forEach((res, idx) => {
    const meta = platformFetchers[idx];
    if (res.status === 'fulfilled' && res.value.length > 0) {
      activeSources.push({source: meta.source, label: meta.label, count: res.value.length});
      for (const item of res.value) {
        allItems.push({...item, weight: meta.weight});
      }
    }
  });

  if (allItems.length === 0) {
    throw new Error('실시간 음악 차트 데이터를 불러오지 못했습니다.');
  }

  interface Cluster {
    title: string;
    artist: string;
    albumArt: string;
    titleKeys: Set<string>;
    artistTokens: Set<string>;
    platforms: Map<ChartPlatformSource, {source: ChartPlatformSource; label: string; rank: number}>;
    score: number;
  }

  const clusters: Cluster[] = [];

  for (const item of allItems) {
    const itemTitleKeys = buildTitleKeys(item.title);
    const itemArtistTokens = buildArtistTokens(item.artist);

    let matched: Cluster | undefined;
    for (const cluster of clusters) {
      const titleMatch = itemTitleKeys.some((k) => cluster.titleKeys.has(k));
      if (!titleMatch) continue;
      const artistMatch = itemArtistTokens.some((tok) => {
        if (cluster.artistTokens.has(tok)) return true;
        for (const existingTok of cluster.artistTokens) {
          if (
            tok.length >= 2 &&
            existingTok.length >= 2 &&
            (tok.includes(existingTok) || existingTok.includes(tok))
          ) {
            return true;
          }
        }
        return false;
      });
      if (artistMatch) {
        matched = cluster;
        break;
      }
    }

    const rankScore =
      item.weight * Math.max(2, 34 - item.rank) +
      (item.rank === 1 ? 14 : item.rank <= 3 ? 8 : item.rank <= 10 ? 4 : 0);

    if (matched) {
      for (const k of itemTitleKeys) matched.titleKeys.add(k);
      for (const a of itemArtistTokens) matched.artistTokens.add(a);
      if (!matched.albumArt && item.albumArt) matched.albumArt = item.albumArt;
      // Prefer Melon / Genie display title/artist when available for clean Korean/English readability
      if (item.source === 'melon' || item.source === 'vibe') {
        matched.title = item.title;
        matched.artist = item.artist;
        if (item.albumArt) matched.albumArt = item.albumArt;
      }
      const existingPlat = matched.platforms.get(item.source);
      if (!existingPlat || item.rank < existingPlat.rank) {
        matched.platforms.set(item.source, {
          source: item.source,
          label: item.label,
          rank: item.rank,
        });
        matched.score += rankScore;
      }
    } else {
      const platforms = new Map<
        ChartPlatformSource,
        {source: ChartPlatformSource; label: string; rank: number}
      >();
      platforms.set(item.source, {source: item.source, label: item.label, rank: item.rank});
      clusters.push({
        title: item.title,
        artist: item.artist,
        albumArt: item.albumArt,
        titleKeys: new Set(itemTitleKeys),
        artistTokens: new Set(itemArtistTokens),
        platforms,
        score: rankScore,
      });
    }
  }

  // Add multi-platform consensus bonus and rank
  const rankedClusters = clusters
    .map((c) => {
      const platformCount = c.platforms.size;
      const consensusBonus = Math.max(0, platformCount - 1) * 18;
      const finalScore = Math.round(c.score + consensusBonus);
      const platforms = [...c.platforms.values()].sort((a, b) => a.rank - b.rank);
      return {
        title: c.title,
        artist: c.artist,
        albumArt: c.albumArt,
        score: finalScore,
        platformCount,
        platforms,
      };
    })
    .sort((a, b) => b.score - a.score || b.platformCount - a.platformCount)
    .slice(0, 25);

  // Resolve top 25 entries to playable YouTube tracks in parallel batches of 5
  const resolvedTracks: Array<YouTubeTrack | null> = new Array(rankedClusters.length).fill(null);
  const batchSize = 5;
  for (let i = 0; i < rankedClusters.length; i += batchSize) {
    const slice = rankedClusters.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      slice.map((item) => resolveChartTrackOnYouTube(item.title, item.artist)),
    );
    batchResults.forEach((tr, offset) => {
      resolvedTracks[i + offset] = tr;
    });
  }

  const entries: UnifiedChartEntry[] = rankedClusters.map((item, idx) => ({
    unifiedRank: idx + 1,
    title: item.title,
    artist: item.artist,
    albumArt: item.albumArt,
    score: item.score,
    platformCount: item.platformCount,
    platforms: item.platforms,
    track: resolvedTracks[idx]
      ? {
          ...resolvedTracks[idx]!,
          thumbnail: item.albumArt || resolvedTracks[idx]!.thumbnail,
        }
      : null,
  }));

  const payload: UnifiedChartPayload = {
    updatedAt: Date.now(),
    activeSources,
    entries,
  };
  unifiedChartCache = {expiresAt: Date.now() + CHART_CACHE_TTL_MS, data: payload};
  return payload;
}

async function createServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ok: true});
  });

  app.get('/api/youtube/suggest', async (req: Request, res: Response) => {
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.json({suggestions: []});
      return;
    }
    try {
      const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ko&q=${encodeURIComponent(q)}`;
      const response = await fetch(url, {headers: {'User-Agent': USER_AGENT}});
      if (!response.ok) {
        res.json({suggestions: []});
        return;
      }
      const data = (await response.json()) as [string, string[]];
      const suggestions = Array.isArray(data?.[1]) ? data[1].slice(0, 8) : [];
      res.json({suggestions});
    } catch {
      res.json({suggestions: []});
    }
  });

  app.get('/api/youtube/search', async (req: Request, res: Response) => {
    const q = String(req.query.q || '').trim();
    const mode = String(req.query.mode || 'music');
    const cursor = String(req.query.cursor || '').trim();
    const sortRaw = String(req.query.sort || 'relevance');
    const sort: 'relevance' | 'popular' | 'recent' =
      sortRaw === 'popular' || sortRaw === 'recent' ? sortRaw : 'relevance';
    const preferredRaw = String(req.query.preferredChannels || '');
    const preferredChannels = new Set(
      preferredRaw
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean),
    );
    const excludeRaw = String(req.query.excludeIds || '');
    const excludeIds = new Set(
      excludeRaw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );

    if (!q && !cursor) {
      res.status(400).json({error: '검색어를 입력해주세요.'});
      return;
    }

    try {
      if (mode === 'channel') {
        const channels = await searchYouTubeChannels(q, 24);
        res.json({query: q, mode, channels, tracks: [], nextCursor: null, hasMore: false});
        return;
      }

      if (cursor) {
        const page = await searchYouTubeContinuationByCursor(cursor, excludeIds);
        const tracks =
          sort === 'relevance'
            ? rankMusicTracks(page.tracks, q, mode === 'music', preferredChannels)
            : page.tracks;
        res.json({
          query: q,
          mode,
          sort,
          tracks,
          channels: [],
          nextCursor: page.nextCursor,
          hasMore: Boolean(page.nextCursor),
        });
        return;
      }

      const page = await searchYouTubePaginated(q, 40, sort);
      const tracks =
        sort === 'relevance'
          ? rankMusicTracks(page.tracks, q, mode === 'music', preferredChannels)
          : page.tracks;

      res.json({
        query: q,
        mode,
        sort,
        tracks,
        channels: [],
        nextCursor: page.nextCursor,
        hasMore: Boolean(page.nextCursor),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '유튜브 검색 중 오류가 발생했습니다.';
      res.status(502).json({error: message, tracks: [], channels: [], nextCursor: null, hasMore: false});
    }
  });

  app.get('/api/youtube/channel/:channelId', async (req: Request, res: Response) => {
    const channelId = String(req.params.channelId || '').trim();
    if (!channelId || !/^[a-zA-Z0-9_-]{6,64}$/.test(channelId)) {
      res.status(400).json({error: '유효한 채널 ID가 아닙니다.'});
      return;
    }
    try {
      const data = await fetchChannelDetail(channelId, 36);
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : '채널 정보를 불러오지 못했습니다.';
      res.status(502).json({
        error: message,
        tracks: [],
        videos: [],
        playlists: [],
        releases: [],
        hasReleases: false,
      });
    }
  });

  app.get('/api/youtube/playlist/:playlistId', async (req: Request, res: Response) => {
    const playlistId = String(req.params.playlistId || '').trim();
    const seedVideoId = String(req.query.seedVideoId || '').trim();
    const channelTitle = String(req.query.channelTitle || '').trim();

    if (!playlistId || !/^[a-zA-Z0-9_-]{8,80}$/.test(playlistId)) {
      res.status(400).json({error: '유효한 재생목록 또는 앨범 ID가 아닙니다.', tracks: []});
      return;
    }
    if (seedVideoId && !/^[a-zA-Z0-9_-]{11}$/.test(seedVideoId)) {
      res.status(400).json({error: '유효한 시드 영상 ID가 아닙니다.', tracks: []});
      return;
    }

    try {
      const result = await fetchPlaylistTracks(
        playlistId,
        80,
        seedVideoId || undefined,
        channelTitle || undefined,
      );
      res.json({
        playlistId,
        title: result.title,
        tracks: result.tracks,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '묶인 영상 목록을 불러오지 못했습니다.';
      res.status(502).json({error: message, tracks: []});
    }
  });

  app.get('/api/youtube/curated', async (req: Request, res: Response) => {
    const mood = String(req.query.mood || 'recommended').trim();
    const query = CURATED_QUERIES[mood] || CURATED_QUERIES.recommended;
    try {
      const page = await searchYouTubePaginated(query, 32, 'relevance');
      res.json({mood, tracks: page.tracks});
    } catch (err) {
      const message = err instanceof Error ? err.message : '추천 트랙을 불러오지 못했습니다.';
      res.status(502).json({error: message, tracks: []});
    }
  });

  app.post('/api/youtube/personalized', async (req: Request, res: Response) => {
    const body = (req.body || {}) as {
      queries?: unknown;
      preferredChannels?: unknown;
      tasteTokens?: unknown;
      knownIds?: unknown;
    };

    const queries = Array.isArray(body.queries)
      ? body.queries
          .map((q) => String(q || '').trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];

    if (queries.length === 0) {
      res.status(400).json({error: '분석된 취향 검색어가 필요합니다.', tracks: []});
      return;
    }

    const preferredChannels = new Set(
      (Array.isArray(body.preferredChannels) ? body.preferredChannels : [])
        .map((c) => String(c || '').trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8),
    );
    const tasteTokens = (Array.isArray(body.tasteTokens) ? body.tasteTokens : [])
      .map((t) => String(t || '').trim().toLowerCase())
      .filter((t) => t.length >= 2)
      .slice(0, 12);
    const knownIdSet = new Set(
      (Array.isArray(body.knownIds) ? body.knownIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
        .slice(0, 120),
    );

    try {
      const pages = await Promise.all(
        queries.map((q) =>
          searchYouTubePaginated(q, 24, 'relevance').catch(() => ({tracks: [], nextCursor: null})),
        ),
      );

      const deduped = new Map<string, {track: YouTubeTrack; originIdx: number; queryIdx: number}>();
      pages.forEach((page, qIdx) => {
        page.tracks.forEach((track, idx) => {
          if (!deduped.has(track.id)) {
            deduped.set(track.id, {track, originIdx: idx, queryIdx: qIdx});
          }
        });
      });

      const scored = [...deduped.values()].map(({track, originIdx, queryIdx}) => {
        const titleLow = track.title.toLowerCase();
        const channelLow = track.channel.toLowerCase();
        let score = Math.max(0, 36 - originIdx * 0.8 - queryIdx * 3);

        for (const pref of preferredChannels) {
          if (channelLow.includes(pref)) {
            score += 24;
            break;
          }
        }
        for (const tok of tasteTokens) {
          if (titleLow.includes(tok)) score += 12;
          if (channelLow.includes(tok)) score += 8;
        }
        // Slightly prioritize fresh discoveries matching taste rather than purely repeating saved songs
        if (!knownIdSet.has(track.id)) {
          score += 10;
        }
        const views = parseViewCount(track.viewCountText);
        if (views > 0) {
          score += Math.min(14, Math.log10(views + 1) * 1.8);
        }
        if (track.durationSeconds > 0 && track.durationSeconds < 30) {
          score -= 28;
        } else if (track.durationSeconds >= 90 && track.durationSeconds <= 600) {
          score += 6;
        }

        return {track, score};
      });

      scored.sort((a, b) => b.score - a.score);

      // Balance channel diversity (up to 5 tracks per channel) so Recommended Mix stays varied
      const perChannelCount = new Map<string, number>();
      const diverseTracks: YouTubeTrack[] = [];
      for (const item of scored) {
        const chKey = item.track.channel.toLowerCase();
        const count = perChannelCount.get(chKey) || 0;
        if (count >= 5) continue;
        perChannelCount.set(chKey, count + 1);
        diverseTracks.push(item.track);
        if (diverseTracks.length >= 38) break;
      }

      res.json({tracks: diverseTracks});
    } catch (err) {
      const message = err instanceof Error ? err.message : '맞춤 추천 트랙을 불러오지 못했습니다.';
      res.status(502).json({error: message, tracks: []});
    }
  });

  app.get('/api/youtube/resolve', async (req: Request, res: Response) => {
    const inputUrl = String(req.query.url || '').trim();
    if (!inputUrl) {
      res.status(400).json({error: '유튜브 URL을 입력해주세요.'});
      return;
    }

    const {videoId, listId} = parseYouTubeUrl(inputUrl);
    if (!videoId && !listId) {
      res.status(400).json({error: '유효한 유튜브 영상 또는 재생목록 링크가 아닙니다.'});
      return;
    }

    try {
      if (listId && !videoId) {
        const playlist = await fetchPlaylistTracks(listId, 50);
        if (playlist.tracks.length === 0) {
          res.status(404).json({error: '재생목록에서 공개된 트랙을 찾을 수 없습니다.'});
          return;
        }
        res.json({type: 'playlist', title: playlist.title, tracks: playlist.tracks});
        return;
      }

      if (videoId) {
        const track = await fetchVideoMetadata(videoId);
        if (listId && !listId.startsWith('RD')) {
          try {
            const playlist = await fetchPlaylistTracks(listId, 30);
            if (playlist.tracks.length > 0) {
              res.json({type: 'playlist', title: playlist.title, tracks: playlist.tracks, primaryTrack: track});
              return;
            }
          } catch {
            // Fall back to single track
          }
        }
        res.json({type: 'track', tracks: [track]});
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '링크 정보를 불러오지 못했습니다.';
      res.status(502).json({error: message});
    }
  });

  app.get('/api/youtube/audio-info', async (req: Request, res: Response) => {
    const videoId = String(req.query.v || '').trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      res.status(400).json({available: false, error: '유효한 영상 ID가 아닙니다.'});
      return;
    }
    try {
      const stream = await resolveYouTubeAudioStream(videoId);
      if (!stream) {
        res.json({available: false});
        return;
      }
      res.json({
        available: true,
        streamUrl: `/api/youtube/stream?v=${encodeURIComponent(videoId)}`,
        mimeType: stream.mimeType,
        bitrate: stream.bitrate,
      });
    } catch {
      res.json({available: false});
    }
  });

  app.get('/api/youtube/stream', async (req: Request, res: Response) => {
    const videoId = String(req.query.v || '').trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      res.status(400).json({error: '유효한 영상 ID가 아닙니다.'});
      return;
    }

    const abortCtrl = new AbortController();
    req.on('close', () => abortCtrl.abort());

    try {
      let stream = await resolveYouTubeAudioStream(videoId);
      if (!stream || !isAllowedGoogleVideoUrl(stream.url)) {
        res.status(404).json({error: '직접 오디오 스트림을 추출할 수 없습니다.'});
        return;
      }

      const fetchUpstream = async (targetUrl: string) => {
        const reqHeaders: Record<string, string> = {
          'User-Agent': USER_AGENT,
        };
        const rangeHeader = req.headers.range;
        if (typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
          reqHeaders.Range = rangeHeader;
        }
        return fetch(targetUrl, {
          headers: reqHeaders,
          signal: abortCtrl.signal,
        });
      };

      let upstream = await fetchUpstream(stream.url);
      if ((upstream.status === 403 || upstream.status === 410) && !abortCtrl.signal.aborted) {
        stream = await resolveYouTubeAudioStream(videoId, true);
        if (stream && isAllowedGoogleVideoUrl(stream.url)) {
          upstream = await fetchUpstream(stream.url);
        }
      }

      if (!upstream.ok && upstream.status !== 206) {
        res.status(502).json({error: '오디오 스트림 응답이 올바르지 않습니다.'});
        return;
      }

      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type') || stream?.mimeType || 'audio/mp4';
      const contentLength = upstream.headers.get('content-length');
      const contentRange = upstream.headers.get('content-range');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      if (contentRange) res.setHeader('Content-Range', contentRange);

      if (!upstream.body) {
        res.end();
        return;
      }

      const nodeStream = Readable.fromWeb(upstream.body as unknown as import('stream/web').ReadableStream);
      nodeStream.on('error', () => {
        if (!res.headersSent) res.status(502);
        res.end();
      });
      nodeStream.pipe(res);
    } catch (err) {
      if (abortCtrl.signal.aborted) return;
      const message = err instanceof Error ? err.message : '오디오 스트리밍 실패';
      if (!res.headersSent) {
        res.status(502).json({error: message});
      }
    }
  });

  app.get('/api/charts/unified', async (req: Request, res: Response) => {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    try {
      const payload = await buildUnifiedCharts(forceRefresh);
      res.json(payload);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '실시간 통합 차트를 분석하지 못했습니다.';
      res.status(502).json({error: message, activeSources: [], entries: []});
    }
  });

  const httpServer = http.createServer(app);

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    app.get('/api/download-source-zip', (_req: Request, res: Response) => {
      const candidates = [
        process.env.DEV_EXPORT_ZIP_PATH,
        path.join(os.tmpdir(), 'resr-mp-source.zip'),
      ].filter((p): p is string => Boolean(p));
      const zipPath = candidates.find((p) => fs.existsSync(p));
      if (!zipPath) {
        res.status(404).json({error: 'ZIP 파일을 찾을 수 없습니다.'});
        return;
      }
      const stat = fs.statSync(zipPath);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', 'attachment; filename="resr-mp-source.zip"');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(zipPath).pipe(res);
    });

    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: {server: httpServer},
        hmr: false,
        allowedHosts: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number.parseInt(process.env.PORT || '3000', 10);
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Velo server listening on http://0.0.0.0:${PORT}`);
  });
}

createServer();
