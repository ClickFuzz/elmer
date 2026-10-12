import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';

const JOBS_DIR = (FileSystem.documentDirectory ?? '') + 'elmer_jobs/';
const SCHEMA_VERSION = 3;

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
        is_mock INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS job_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        local_uri TEXT NOT NULL,
        classification TEXT NOT NULL DEFAULT 'General',
        sort_order INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
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
  photos: Array<{ uri: string; classification: string }>;
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

  const result = await db.runAsync(
    `INSERT INTO jobs
       (created_at, updated_at, status, audio_local_uri, transcription,
        post_content, social_content, web_content, job_location, seo_metadata, is_mock)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      now, now, audioLocalUri, params.transcription,
      params.googlePost, params.socialPost, params.webContent,
      params.location || null,
      params.seoMetadata ? JSON.stringify(params.seoMetadata) : null,
      params.isMock ? 1 : 0,
    ]
  );

  const jobId = result.lastInsertRowId;

  for (let i = 0; i < params.photos.length; i++) {
    await db.runAsync(
      `INSERT INTO job_photos (job_id, local_uri, classification, sort_order) VALUES (?, ?, ?, ?)`,
      [jobId, params.photos[i].uri, params.photos[i].classification, i]
    );
  }

  return jobId;
}

export async function getJobStats(): Promise<{ total: number; drafts: number }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number; drafts: number }>(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as drafts
     FROM jobs`
  );
  return { total: row?.total ?? 0, drafts: row?.drafts ?? 0 };
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
