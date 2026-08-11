/**
 * Consistent snapshot of a live database.
 * `npm run backup -- backups/grading-room-2026-08-11.db`
 *
 * Uses SQLite's own VACUUM INTO rather than copying the file, which is the
 * difference between a restorable backup and one missing whatever was in the
 * write-ahead log at the moment you copied it.
 */
import { backupTo, openDb } from '../db.js';

const destination = process.argv[2];
if (!destination) {
  console.error('Usage: npm run backup -- <path/to/backup.db>');
  process.exit(1);
}

const db = openDb();
backupTo(db, destination);
db.close();
console.log(`Wrote ${destination}. Restore by pointing GR_DB at it, or copying it back over the live file while stopped.`);
