/**
 * Create 60 test users in Firebase Auth + Realtime Database.
 *
 * Naming: PatientAndroid01–10, PatientIOS01–10,
 *         CarerAndroid01–10, CarerIOS01–10,
 *         FamilyAndroid01–10, FamilyIOS01–10
 *
 * Each user gets:
 *   - Firebase Auth account (email/password)
 *   - RTDB profile at carecall/users/{uid}
 *   - codeIndex entry at carecall/codeIndex/{code}
 *
 * Usage:
 *   1. Place service-account-key.json in project root
 *   2. Run: node scripts/create-test-users.mjs
 *
 * All users share the same password: CareCall2026!
 * Email format: carecall.{name}@test.carecall.app
 *   (Firebase Auth doesn't validate deliverability)
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load service account
const keyPath = join(__dirname, '..', 'service-account-key.json');
let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(keyPath, 'utf8'));
} catch (e) {
  console.error('❌ Could not read service-account-key.json');
  console.error('   Download from: Firebase Console → Project Settings → Service accounts → Generate new private key');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://carecall-2afa6-default-rtdb.firebaseio.com',
});

const auth = admin.auth();
const db = admin.database();

const PASSWORD = 'CareCall2026!';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  return Array.from({ length: 6 }, () =>
    CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  ).join('');
}

// Build the user list
const users = [];
const roles = ['patient', 'carer', 'family'];
const platforms = ['Android', 'IOS'];
const roleLabels = { patient: 'Patient', carer: 'Carer', family: 'Family' };

for (const role of roles) {
  for (const platform of platforms) {
    for (let i = 1; i <= 3; i++) {
      const num = String(i).padStart(2, '0');
      const name = `${roleLabels[role]}${platform}${num}`;
      const email = `carecall.${name.toLowerCase()}@test.carecall.app`;
      const phone = `+972523787733`;
      users.push({ name, email, role, platform, phone });
    }
  }
}

async function createUser(user) {
  const { name, email, role, phone } = user;
  const code = genCode();

  // 1. Create Firebase Auth account
  let uid;
  try {
    const existing = await auth.getUserByEmail(email).catch(() => null);
    if (existing) {
      console.log(`  ⏭️  ${name} already exists (${existing.uid})`);
      uid = existing.uid;
    } else {
      const record = await auth.createUser({
        email,
        password: PASSWORD,
        displayName: name,
        emailVerified: true,
      });
      uid = record.uid;
    }
  } catch (e) {
    console.error(`  ❌ Auth failed for ${name}:`, e.message);
    return null;
  }

  // 2. Write RTDB profile
  const profile = {
    personalCode: code,
    name,
    role,
    phone,
    rooms: [],
    avatar: role === 'patient' ? '🛏️' : role === 'carer' ? '🔔' : '👨‍👩‍👧',
  };

  try {
    await db.ref(`carecall/users/${uid}`).set(profile);
  } catch (e) {
    console.error(`  ❌ Profile write failed for ${name}:`, e.message);
    return null;
  }

  // 3. Write codeIndex
  try {
    await db.ref(`carecall/codeIndex/${code}`).set({
      uid,
      name,
      role,
    });
  } catch (e) {
    console.error(`  ❌ CodeIndex write failed for ${name}:`, e.message);
  }

  console.log(`  ✅ ${name} | ${email} | ${code} | ${uid}`);
  return { ...user, uid, code };
}

async function main() {
  console.log(`\n🔧 Creating ${users.length} test users...\n`);
  console.log(`   Password for all: ${PASSWORD}\n`);
  console.log('   Name                    | Email                                      | Code   | UID');
  console.log('   ' + '─'.repeat(95));

  const results = [];

  for (const role of roles) {
    console.log(`\n── ${roleLabels[role]}s ──`);
    for (const user of users.filter(u => u.role === role)) {
      const result = await createUser(user);
      if (result) results.push(result);
    }
  }

  // Print summary table
  console.log('\n\n═══ SUMMARY ═══\n');
  console.log('Name                    | Email                                      | Code   | Platform | Role');
  console.log('─'.repeat(105));
  for (const r of results) {
    const name = r.name.padEnd(23);
    const email = r.email.padEnd(42);
    const code = r.code.padEnd(6);
    console.log(`${name} | ${email} | ${code} | ${r.platform.padEnd(8)} | ${r.role}`);
  }

  console.log(`\n✅ Created ${results.length}/${users.length} users.`);
  console.log(`\n📋 Login credentials:`);
  console.log(`   Email pattern: carecall.<name>@test.carecall.app`);
  console.log(`   Password:      ${PASSWORD}`);
  console.log(`\n   Example: carecall.patientandroid01@test.carecall.app / ${PASSWORD}\n`);

  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
