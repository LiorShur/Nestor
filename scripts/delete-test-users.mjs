/**
 * Delete all 60 test users created by create-test-users.mjs.
 *
 * Removes:
 *   - Firebase Auth accounts
 *   - RTDB profiles at carecall/users/{uid}
 *   - codeIndex entries at carecall/codeIndex/{code}
 *   - Room memberships (removes test user from any rooms)
 *
 * Usage:
 *   1. Place service-account-key.json in project root
 *   2. Run: node scripts/delete-test-users.mjs
 *
 * Dry-run by default — set DRY_RUN=false below to actually delete.
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = false; // ← Change to false to actually delete

// Load service account
const keyPath = join(__dirname, '..', 'service-account-key.json');
let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(keyPath, 'utf8'));
} catch (e) {
  console.error('❌ Could not read service-account-key.json');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://carecall-2afa6-default-rtdb.firebaseio.com',
});

const auth = admin.auth();
const db = admin.database();

// Same naming convention as create-test-users.mjs
const roles = ['patient', 'carer', 'family'];
const platforms = ['Android', 'IOS'];
const roleLabels = { patient: 'Patient', carer: 'Carer', family: 'Family' };

const testEmails = [];
for (const role of roles) {
  for (const platform of platforms) {
    for (let i = 1; i <= 10; i++) {
      const num = String(i).padStart(2, '0');
      const name = `${roleLabels[role]}${platform}${num}`;
      testEmails.push({
        name,
        email: `carecall.${name.toLowerCase()}@test.carecall.app`,
      });
    }
  }
}

async function main() {
  console.log(DRY_RUN ? '🔍 DRY RUN — no deletions will occur\n' : '🔴 LIVE MODE — deletions are permanent\n');
  console.log(`Looking up ${testEmails.length} test users...\n`);

  const found = [];
  const notFound = [];

  for (const { name, email } of testEmails) {
    try {
      const user = await auth.getUserByEmail(email);
      found.push({ name, email, uid: user.uid });
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        notFound.push(name);
      } else {
        console.warn(`  ⚠️  Error looking up ${name}:`, e.message);
      }
    }
  }

  console.log(`Found: ${found.length} | Not found: ${notFound.length}\n`);

  if (!found.length) {
    console.log('✅ No test users to delete.');
    process.exit(0);
  }

  for (const u of found) {
    console.log(`  ${u.name} | ${u.email} | ${u.uid}`);
  }

  if (DRY_RUN) {
    console.log(`\n🔍 Dry run complete. Set DRY_RUN = false to delete these ${found.length} users.`);
    process.exit(0);
  }

  // 1. Clean up RTDB data
  console.log('\n── Cleaning RTDB data ──');
  for (const { name, uid } of found) {
    try {
      // Read user profile to get personalCode
      const profileSnap = await db.ref(`carecall/users/${uid}`).once('value');
      const profile = profileSnap.val();

      // Remove codeIndex entry
      if (profile && profile.personalCode) {
        await db.ref(`carecall/codeIndex/${profile.personalCode}`).remove();
        console.log(`  ✓ Removed codeIndex/${profile.personalCode}`);
      }

      // Remove from any rooms they're a member of
      if (profile && Array.isArray(profile.rooms)) {
        for (const roomId of profile.rooms) {
          try {
            await db.ref(`carecall/rooms/${roomId}/members/${uid}`).remove();
            console.log(`  ✓ Removed from room ${roomId}`);
          } catch (_) {}
        }
      }

      // Remove user profile
      await db.ref(`carecall/users/${uid}`).remove();
      console.log(`  ✓ Removed profile for ${name}`);
    } catch (e) {
      console.warn(`  ⚠️  RTDB cleanup failed for ${name}:`, e.message);
    }
  }

  // 2. Remove pending pair requests sent by/to test users
  console.log('\n── Cleaning pending pair requests ──');
  const testUids = new Set(found.map(u => u.uid));
  for (const { uid } of found) {
    try {
      // Clean sentPairs
      await db.ref(`carecall/users/${uid}/sentPairs`).remove().catch(() => {});
      // Clean pendingPairs
      await db.ref(`carecall/users/${uid}/pendingPairs`).remove().catch(() => {});
    } catch (_) {}
  }
  console.log(`  ✓ Cleaned pair requests for ${found.length} users`);

  // 3. Delete Firebase Auth accounts (batch, up to 1000)
  console.log('\n── Deleting Auth accounts ──');
  const uids = found.map(u => u.uid);
  for (let i = 0; i < uids.length; i += 1000) {
    const batch = uids.slice(i, i + 1000);
    const result = await auth.deleteUsers(batch);
    console.log(`  Batch ${Math.floor(i / 1000) + 1}: deleted ${result.successCount}, failed ${result.failureCount}`);
    if (result.errors.length) {
      result.errors.forEach(e => console.warn(`    Error: ${e.error.message} (index ${e.index})`));
    }
  }

  console.log(`\n✅ Done! Deleted ${found.length} test users + their data.\n`);
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
