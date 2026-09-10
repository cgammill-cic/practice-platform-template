// Nightly + manual D1 → R2 backup with change detection and alerting (O-7, F-002 #10).
//
// Detection layers (decision log 2026-07-29):
//  1. Missing run   → dashboard banner turns red when the last backup is >26h old.
//  2. Silent no-op  → checksum identical to previous backup while audit_event shows writes → alert.
//  3. Corruption    → every backup is read back from R2 and parsed before counting as successful.
// Email alert channel arrives with Phase 2 (Microsoft Graph); until then the dashboard banner
// and /health carry the alert state.

import type { D1Db, R2Bucket } from "./types";

export interface BackupEnv {
  DB: D1Db;
  BACKUPS: R2Bucket;
}

const RETENTION_DAYS = 30;
const MANIFEST_KEY = "manifest/latest.json";

interface Manifest {
  exported_at: string;
  checksum: string;
  counts: Record<string, number>;
  key: string;
  status: string;
}

async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function listTables(db: D1Db): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name != 'd1_migrations' ORDER BY name"
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function runBackup(env: BackupEnv, trigger: "cron" | "manual") {
  const exportedAt = new Date().toISOString();
  const tables = await listTables(env.DB);
  const dump: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM "${t}"`).all();
    dump[t] = results;
    counts[t] = results.length;
  }
  const payload = JSON.stringify({ exported_at: exportedAt, tables: dump });
  const checksum = await sha256hex(JSON.stringify(dump));

  const key = `backups/${exportedAt.slice(0, 10)}T${exportedAt.slice(11, 19).replace(/:/g, "")}.json`;
  await env.BACKUPS.put(key, payload);

  let status: "ok" | "alert" = "ok";
  let detail = `${trigger} backup ok (${tables.length} tables)`;

  // Layer 3: read-back integrity check.
  const readBack = await env.BACKUPS.get(key);
  if (!readBack) {
    status = "alert";
    detail = "Backup file missing after write — R2 write failed.";
  } else {
    try {
      const text = await readBack.text();
      JSON.parse(text);
      if (text.length !== payload.length) throw new Error("length mismatch");
    } catch {
      status = "alert";
      detail = "Backup file failed integrity check (corrupt or truncated).";
    }
  }

  // Layer 2: change detection vs previous manifest.
  if (status === "ok") {
    const prevObj = await env.BACKUPS.get(MANIFEST_KEY);
    if (prevObj) {
      try {
        const prev = JSON.parse(await prevObj.text()) as Manifest;
        if (prev.checksum === checksum) {
          const prevTs = prev.exported_at.slice(0, 19).replace("T", " ");
          const writes = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE ts > ?")
            .bind(prevTs)
            .first<{ n: number }>();
          if ((writes?.n ?? 0) > 0) {
            status = "alert";
            detail = `Backup content identical to previous despite ${writes!.n} audited change(s) since ${prev.exported_at} — backup may not be capturing changes.`;
          } else {
            detail = `${trigger} backup ok — identical to previous backup, and no audited writes since, so identical content is expected.`;
          }
        }
      } catch {
        // Unreadable previous manifest: current backup stands alone.
      }
    }
  }

  await env.BACKUPS.put(
    MANIFEST_KEY,
    JSON.stringify({ exported_at: exportedAt, checksum, counts, key, status } satisfies Manifest)
  );

  // Retention.
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  const listing = await env.BACKUPS.list({ prefix: "backups/" });
  for (const obj of listing.objects) {
    if (new Date(obj.uploaded).getTime() < cutoff) await env.BACKUPS.delete(obj.key);
  }

  await env.DB.prepare(
    "INSERT INTO backup_run (status, detail, row_counts, checksum, object_key) VALUES (?,?,?,?,?)"
  )
    .bind(status, detail, JSON.stringify(counts), checksum, key)
    .run();

  return { status, detail, counts, checksum, key };
}

export async function recordBackupFailure(env: BackupEnv, err: unknown) {
  const detail = `Backup run threw: ${err instanceof Error ? err.message : String(err)}`;
  try {
    await env.DB.prepare("INSERT INTO backup_run (status, detail) VALUES ('alert', ?)").bind(detail).run();
  } catch {
    // If even this fails, the dashboard staleness banner is the remaining net.
  }
}

export interface BackupStatus {
  state: "none" | "ok" | "alert" | "stale";
  message: string;
}

export async function backupStatus(db: D1Db): Promise<BackupStatus> {
  const last = await db
    .prepare("SELECT ts, status, detail FROM backup_run ORDER BY id DESC LIMIT 1")
    .first<{ ts: string; status: string; detail: string }>();
  if (!last) return { state: "none", message: "No backup recorded yet — first nightly run pending (2:00 AM Central)." };
  const ageHours = (Date.now() - new Date(last.ts.replace(" ", "T") + "Z").getTime()) / 3_600_000;
  if (last.status === "alert") return { state: "alert", message: `Backup alert (${last.ts} UTC): ${last.detail}` };
  if (ageHours > 26)
    return { state: "stale", message: `No backup in ${Math.round(ageHours)} hours (last: ${last.ts} UTC) — the nightly job may have stopped.` };
  return { state: "ok", message: `Last backup ok at ${last.ts} UTC.` };
}
