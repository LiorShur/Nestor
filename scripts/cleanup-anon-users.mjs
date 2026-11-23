/**
 * Batch-delete all anonymous Firebase Auth users and their
 * Realtime Database data.
 *
 * Usage:
 *   1. Download a service account key from Firebase Console:
 *      Project Settings → Service accounts → Generate new private key
 *   2. Save as `service-account-key.json` in the project root
 *   3. Run: node scripts/cleanup-anon-users.mjs
 *
 * What it does:
 *   - Lists ALL Firebase Auth users
 *   - Filters to anonymous-only (no email, no phone)
 *   - Deletes their Auth accounts
 *   - Removes their RTDB data at carecall/users/{uid}
 *   - Removes their codeIndex entries
 *
 * Dry-run mode (default): set DRY_RUN=false below to actually delete.
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = true; // ← Change to false to actually delete

// Load service account
const keyPath = join(__dirname, '..', 'service-account-key.json');
let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(keyPath, 'utf8'));
} catch (e) {
  console.error('❌ Could not read service-account-key.json');
  console.error('   Download from: Firebase Console → Project Settings → Service accounts → Generate new private key');
  console.error('   Save as: service-account-key.json in the project root');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://carecall-2afa6-default-rtdb.firebaseio.com',
});

const auth = admin.auth();
const db = admin.database();

async function listAllUsers(nextPageToken) {
  const users = [];
  const result = await auth.listUsers(1000, nextPageToken);
  users.push(...result.users);
  if (result.pageToken) {
    users.push(...await listAllUsers(result.pageToken));
  }
  return users;
}

async function main() {
  console.log(DRY_RUN ? '🔍 DRY RUN — no deletions will occur\n' : '🔴 LIVE MODE — deletions are permanent\n');

  // 1. List all auth users
  const allUsers = await listAllUsers();
  console.log(`Total auth users: ${allUsers.length}`);

  // 2. Filter anonymous users (no email, no phone, no linked providers beyond 'anonymous')
  const anonUsers = allUsers.filter(u => {
    if (u.email || u.phoneNumber) return false;
    const providers = (u.providerData || []).map(p => p.providerId);
    return providers.length === 0 || providers.every(p => p === 'anonymous');
  });

  console.log(`Anonymous users found: ${anonUsers.length}`);
  if (anonUsers.length === 0) {
    console.log('✅ Nothing to clean up.');
    process.exit(0);
  }

  // 3. Show what we'd delete
  for (const u of anonUsers) {
    console.log(`  - ${u.uid} (created: ${u.metadata.creationTime})`);
  }

  if (DRY_RUN) {
    console.log(`\n🔍 Dry run complete. Set DRY_RUN = false in the script to delete these ${anonUsers.length} users.`);
    process.exit(0);
  }

  // 4. Delete auth accounts
  console.log('\nDeleting auth accounts...');
  const uids = anonUsers.map(u => u.uid);
  // Firebase supports batch delete up to 1000 at a time
  for (let i = 0; i < uids.length; i += 1000) {
    const batch = uids.slice(i, i + 1000);
    const result = await auth.deleteUsers(batch);
    console.log(`  Batch ${Math.floor(i / 1000) + 1}: deleted ${result.successCount}, failed ${result.failureCount}`);
    if (result.errors.length) {
      result.errors.forEach(e => console.warn(`    Error: ${e.error.message} (index ${e.index})`));
    }
  }

  // 5. Clean up RTDB data
  console.log('\nCleaning RTDB data...');
  for (const uid of uids) {
    try {
      // Remove user profile
      await db.ref(`carecall/users/${uid}`).remove();
      console.log(`  ✓ Removed carecall/users/${uid}`);
    } catch (e) {
      console.warn(`  ✗ Failed to remove user data for ${uid}:`, e.message);
    }
  }

  // 6. Clean up orphaned codeIndex entries
  console.log('\nCleaning orphaned codeIndex entries...');
  const codeIndexSnap = await db.ref('carecall/codeIndex').once('value');
  const codeIndex = codeIndexSnap.val() || {};
  let orphanCount = 0;
  for (const [code, entry] of Object.entries(codeIndex)) {
    if (entry && uids.includes(entry.uid)) {
      await db.ref(`carecall/codeIndex/${code}`).remove();
      console.log(`  ✓ Removed codeIndex/${code} (was → ${entry.uid})`);
      orphanCount++;
    }
  }
  console.log(`  Removed ${orphanCount} orphaned code entries.`);

  console.log(`\n✅ Done! Deleted ${uids.length} anonymous users + their data.`);
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
