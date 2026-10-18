import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';

const JOBS_DIR = (FileSystem.documentDirectory ?? '') + 'elmer_jobs/';
const SCHEMA_VERSION = 10;

export type SeoMetadata = {
  seoTitle: string;
  urlSlug: string;
  metaDescription: string;
  mainKeyword: string;
  secondaryKeywords: string[];
  imageFilenames: string[];
  imageAltTexts: string[];
};

let _db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('elmer.db');
  await migrate(_db);
  return _db;
}

async function migrate(db: SQLite.SQLiteDatabase) {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;

  if (version < 1) {
    // Fresh install — create full schema at current version
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        audio_local_uri TEXT,
        transcription TEXT,
        post_content TEXT,
        social_content TEXT,
        web_content TEXT,
        job_location TEXT,
        seo_metadata TEXT,
        is_mock INTEGER NOT NULL DEFAULT 0,
        publish_status TEXT,
        user_email TEXT
      );
      CREATE TABLE IF NOT EXISTS job_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        local_uri TEXT NOT NULL,
        classification TEXT NOT NULL DEFAULT 'General',
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_featured INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }

  // Incremental migrations for devices that have an older schema
  if (version < 2) {
    try { await db.execAsync('ALTER TABLE jobs ADD COLUMN web_content TEXT'); } catch { /* already exists */ }
  }
  if (version < 3) {
    try { await db.execAsync('ALTER TABLE jobs ADD COLUMN social_content TEXT'); } catch { /* already exists */ }
    try { await db.execAsync('ALTER TABLE jobs ADD COLUMN job_location TEXT'); } catch { /* already exists */ }
    try { await db.execAsync('ALTER TABLE jobs ADD COLUMN seo_metadata TEXT'); } catch { /* already exists */ }
  }
  if (version < 5) {
    try {
      await db.execAsync('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    } catch { /* already exists */ }
  }
  if (version < 6) {
    try { await db.execAsync("ALTER TABLE job_photos ADD COLUMN destination TEXT NOT NULL DEFAULT 'other_platforms'"); } catch { /* already exists */ }
  }
  if (version < 7) {
    try { await db.execAsync("UPDATE job_photos SET destination = 'other_platforms' WHERE destination = 'all'"); } catch { /* ignore */ }
  }
  if (version < 8) {
    try { await db.execAsync('ALTER TABLE job_photos ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
    // Feature the first photo (lowest sort_order) for each existing job
    try {
      await db.execAsync(`
        UPDATE job_photos SET is_featured = 1
        WHERE sort_order = (
          SELECT MIN(sort_order) FROM job_photos jp2 WHERE jp2.job_id = job_photos.job_id
        )
      `);
    } catch { /* ignore */ }
  }
  if (version < 9) {
    try { await db.execAsync('ALTER TABLE jobs ADD COLUMN publish_status TEXT'); } catch { /* already exists */ }
  }
  if (version < 10) {
    try { await db.execAsync('ALTER TABLE jobs ADD COLUMN user_email TEXT'); } catch { /* already exists */ }
    // Claim any pre-migration jobs that belong to the current session's owner.
    // Only assigns jobs that are still unclaimed (user_email IS NULL).
    // A new login must never claim NULL jobs — that is intentionally left to the startup
    // path (useEffect in App.tsx), which only runs for the already-authenticated user.
    try {
      await db.execAsync(
        `UPDATE jobs SET user_email = (SELECT value FROM settings WHERE key = 'session_email')
         WHERE user_email IS NULL
           AND (SELECT value FROM settings WHERE key = 'session_email') IS NOT NULL`
      );
    } catch { /* ignore — settings row may not exist on fresh install */ }
  }

  if (version < SCHEMA_VERSION) {
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

export async function saveJob(params: {
  audioSourceUri: string | null;
  transcription: string;
  googlePost: string;
  socialPost: string;
  webContent: string;
  location: string;
  seoMetadata: SeoMetadata | null;
  isMock: boolean;
  photos: { uri: string; classification: string; isFeatured?: boolean }[];
}): Promise<number> {
  const db = await getDb();
  const now = Date.now();

  let audioLocalUri: string | null = null;
  if (params.audioSourceUri) {
    try {
      const dir = `${JOBS_DIR}${now}/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const dest = `${dir}audio.m4a`;
      await FileSystem.copyAsync({ from: params.audioSourceUri, to: dest });
      audioLocalUri = dest;
    } catch {
      audioLocalUri = params.audioSourceUri;
    }
  }

  const email = await getSessionEmail();

  const result = await db.runAsync(
    `INSERT INTO jobs
       (created_at, updated_at, status, audio_local_uri, transcription,
        post_content, social_content, web_content, job_location, seo_metadata, is_mock, user_email)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      now, now, audioLocalUri, params.transcription,
      params.googlePost, params.socialPost, params.webContent,
      params.location || null,
      params.seoMetadata ? JSON.stringify(params.seoMetadata) : null,
      params.isMock ? 1 : 0,
      email,
    ]
  );

  const jobId = result.lastInsertRowId;

  for (let i = 0; i < params.photos.length; i++) {
    await db.runAsync(
      `INSERT INTO job_photos (job_id, local_uri, classification, is_featured, sort_order) VALUES (?, ?, ?, ?, ?)`,
      [jobId, params.photos[i].uri, params.photos[i].classification, params.photos[i].isFeatured ? 1 : 0, i]
    );
  }

  return jobId;
}

export async function getJobStats(): Promise<{ total: number; drafts: number }> {
  const db = await getDb();
  const email = await getSessionEmail();
  const row = await db.getFirstAsync<{ total: number; drafts: number }>(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as drafts
     FROM jobs WHERE user_email = ?`,
    [email ?? '']
  );
  return { total: row?.total ?? 0, drafts: row?.drafts ?? 0 };
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`, [key]
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    [key, value]
  );
}

// ── Session token (Elmer account) ─────────────────────────────────────────────
// Token is stored in SecureStore (Keychain/Keystore); email stays in SQLite.

const SECURE_TOKEN_KEY = 'elmer_session_token';

export async function getSessionToken(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(SECURE_TOKEN_KEY);
  if (token) return token;
  // One-time migration: move any plaintext token left in SQLite to SecureStore.
  const legacy = await getSetting('session_token');
  if (legacy) {
    await SecureStore.setItemAsync(SECURE_TOKEN_KEY, legacy);
    const db = await getDb();
    await db.runAsync(`DELETE FROM settings WHERE key = 'session_token'`);
    return legacy;
  }
  return null;
}

export async function getSessionEmail(): Promise<string | null> {
  return getSetting('session_email');
}

export async function setSession(token: string, email: string): Promise<void> {
  await SecureStore.setItemAsync(SECURE_TOKEN_KEY, token);
  await setSetting('session_email', email);
  // Remove any legacy plaintext token that may exist from a prior install.
  const db = await getDb();
  await db.runAsync(`DELETE FROM settings WHERE key = 'session_token'`);
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SECURE_TOKEN_KEY);
  const db = await getDb();
  await db.runAsync(`DELETE FROM settings WHERE key IN ('session_token', 'session_email')`);
}

// ── Connected channels ────────────────────────────────────────────────────────

export type ConnectedChannel = {
  id: string;
  platform: 'google' | 'facebook' | 'instagram' | 'twitter' | 'wordpress' | 'threads';
  accountName: string;
  accountId?: string;
};

// Returns channels that have been authorized via OAuth.
// Falls back to empty array when not available.
export type BusinessProfile = {
  name: string;
  website: string;
  inquiryUrl: string;
  location: string;
  category: string;
  categoryCustom: string;
  services: string[];
  serviceAreas: string[];
  description: string;
  writingStyle: string;
  customWritingInstructions: string;
};

export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  name: '',
  website: '',
  inquiryUrl: '',
  location: '',
  category: '',
  categoryCustom: '',
  services: [],
  serviceAreas: [],
  description: '',
  writingStyle: 'Casual / Professional',
  customWritingInstructions: '',
};

export async function getBusinessProfile(): Promise<BusinessProfile> {
  const email = await getSessionEmail();
  const key = email ? `business_profile_${email}` : 'business_profile';
  const raw = await getSetting(key);
  if (raw) {
    try { return { ...DEFAULT_BUSINESS_PROFILE, ...JSON.parse(raw) }; } catch { /* fall through */ }
  }
  if (!email) {
    const legacyLoc = await getSetting('business_location');
    if (legacyLoc) return { ...DEFAULT_BUSINESS_PROFILE, location: legacyLoc };
  }
  return { ...DEFAULT_BUSINESS_PROFILE };
}

export async function saveBusinessProfile(profile: BusinessProfile): Promise<void> {
  const email = await getSessionEmail();
  const key = email ? `business_profile_${email}` : 'business_profile';
  await setSetting(key, JSON.stringify(profile));
}

// ── Pending home state (draft before generate) ────────────────────────────────

export type PendingPhoto = {
  uri: string;
  classification: string;
  isFeatured?: boolean;
  gps?: { lat: number; lng: number };
};

export type PendingHomeState = {
  photos: PendingPhoto[];
  audioUri: string | null;
};

export async function getPendingHomeState(): Promise<PendingHomeState | null> {
  const raw = await getSetting('pending_home_state');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function savePendingHomeState(state: PendingHomeState | null): Promise<void> {
  if (!state) {
    const db = await getDb();
    await db.runAsync(`DELETE FROM settings WHERE key = 'pending_home_state'`);
    return;
  }
  await setSetting('pending_home_state', JSON.stringify(state));
}

export async function getConnectedChannels(): Promise<ConnectedChannel[]> {
  const raw = await getSetting('connected_channels');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export async function fetchServerConnectedChannels(
  token: string,
  apiUrl: string
): Promise<ConnectedChannel[]> {
  try {
    const res = await fetch(`${apiUrl}/platforms`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.platforms ?? [])
      .filter((p: { platform: string; selected?: boolean }) =>
        // For Facebook, only include pages the user has explicitly selected.
        p.platform !== 'facebook' || p.selected === true
      )
      .map((p: {
        id: number;
        platform: string;
        account_name: string;
        account_id: string;
      }) => ({
        id:          String(p.id),
        platform:    p.platform as ConnectedChannel['platform'],
        accountName: p.account_name,
        accountId:   p.account_id,
      }));
  } catch {
    return [];
  }
}

export type FacebookPage = {
  id: number;
  account_name: string;
  account_id: string;
  selected: boolean;
  connected_at: number;
};

export async function fetchFacebookPages(
  token: string,
  apiUrl: string
): Promise<FacebookPage[]> {
  try {
    const res = await fetch(`${apiUrl}/facebook/pages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.pages ?? [];
  } catch {
    return [];
  }
}

export async function getMultiPageWarningShown(): Promise<boolean> {
  const val = await getSetting('fb_multi_page_warned');
  return val === '1';
}

export async function setMultiPageWarningShown(): Promise<void> {
  await setSetting('fb_multi_page_warned', '1');
}

export async function getInstagramConnected(): Promise<boolean> {
  const val = await getSetting('instagram_connected');
  return val === '1';
}

export async function setInstagramConnected(connected: boolean): Promise<void> {
  if (connected) {
    await setSetting('instagram_connected', '1');
  } else {
    const db = await getDb();
    await db.runAsync(`DELETE FROM settings WHERE key = 'instagram_connected'`);
  }
}

export async function getInstagramExplanationShown(): Promise<boolean> {
  const val = await getSetting('ig_explanation_shown');
  return val === '1';
}

export async function setInstagramExplanationShown(): Promise<void> {
  await setSetting('ig_explanation_shown', '1');
}

export type JobPlatformResult = 'success' | 'failed' | 'excluded';

export type JobPublishStatus = {
  platforms: Record<string, JobPlatformResult>;
  results: {
    platform: string;
    pageName: string;
    ok: boolean;
    postUrl?: string;
    error?: string;
    duplicate?: boolean;
  }[];
};

export type Job = {
  id: number;
  createdAt: number;
  status: string;
  socialContent: string | null;
  webContent: string | null;
  googlePost: string | null;
  jobLocation: string | null;
  isMock: boolean;
  firstPhotoUri: string | null;
  publishStatus: JobPublishStatus | null;
};

export async function deleteJob(id: number): Promise<void> {
  const db = await getDb();
  const email = await getSessionEmail();
  await db.runAsync('DELETE FROM jobs WHERE id = ? AND user_email = ?', [id, email ?? '']);
}

export type JobPhoto = {
  localUri: string;
  classification: string;
  isFeatured: boolean;
  sortOrder: number;
};

export async function getJobPhotos(jobId: number): Promise<JobPhoto[]> {
  const db = await getDb();
  const email = await getSessionEmail();
  const rows = await db.getAllAsync<{
    local_uri: string;
    classification: string;
    is_featured: number;
    sort_order: number;
  }>(
    `SELECT jp.local_uri, jp.classification, jp.is_featured, jp.sort_order
     FROM job_photos jp
     JOIN jobs j ON jp.job_id = j.id
     WHERE jp.job_id = ? AND j.user_email = ?
     ORDER BY jp.sort_order ASC`,
    [jobId, email ?? '']
  );
  return rows.map(r => ({
    localUri: r.local_uri,
    classification: r.classification,
    isFeatured: r.is_featured === 1,
    sortOrder: r.sort_order,
  }));
}


export async function getAllJobs(): Promise<Job[]> {
  const db = await getDb();
  const email = await getSessionEmail();
  const rows = await db.getAllAsync<{
    id: number;
    created_at: number;
    status: string;
    social_content: string | null;
    web_content: string | null;
    post_content: string | null;
    job_location: string | null;
    is_mock: number;
    first_photo_uri: string | null;
    publish_status: string | null;
  }>(`SELECT j.id, j.created_at, j.status, j.social_content, j.web_content,
             j.post_content, j.job_location, j.is_mock, j.publish_status,
             (SELECT local_uri FROM job_photos WHERE job_id = j.id ORDER BY sort_order ASC LIMIT 1) AS first_photo_uri
      FROM jobs j WHERE j.user_email = ? ORDER BY j.created_at DESC`,
    [email ?? '']);
  return rows.map(r => {
    let publishStatus: JobPublishStatus | null = null;
    if (r.publish_status) {
      try { publishStatus = JSON.parse(r.publish_status); } catch { /* ignore */ }
    }
    return {
      id: r.id,
      createdAt: r.created_at,
      status: r.status,
      socialContent: r.social_content,
      webContent: r.web_content,
      googlePost: r.post_content,
      jobLocation: r.job_location,
      isMock: r.is_mock === 1,
      firstPhotoUri: r.first_photo_uri,
      publishStatus,
    };
  });
}

export async function updateJobPublishStatus(
  jobId: number,
  status: string,
  publishStatus: JobPublishStatus,
): Promise<void> {
  const db = await getDb();
  const email = await getSessionEmail();
  await db.runAsync(
    `UPDATE jobs SET status = ?, publish_status = ?, updated_at = ? WHERE id = ? AND user_email = ?`,
    [status, JSON.stringify(publishStatus), Date.now(), jobId, email ?? ''],
  );
}

export async function deleteOldPublishedMedia(): Promise<void> {
  const db = await getDb();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const old = await db.getAllAsync<{ id: number; audio_local_uri: string | null }>(
    `SELECT id, audio_local_uri FROM jobs WHERE status = 'published' AND updated_at < ?`,
    [cutoff]
  );
  for (const job of old) {
    if (job.audio_local_uri) {
      await FileSystem.deleteAsync(job.audio_local_uri, { idempotent: true }).catch(() => {});
    }
    await db.runAsync(`UPDATE jobs SET audio_local_uri = NULL WHERE id = ?`, [job.id]);
  }
}
