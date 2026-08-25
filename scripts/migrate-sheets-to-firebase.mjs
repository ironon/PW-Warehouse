#!/usr/bin/env node
// One-time migration: reads the Container/ContainerType data out of the
// (now-retired) Google Sheet and writes it into the Firebase Realtime
// Database that PW-Warehouse now runs on.
//
// Usage:
//   node scripts/migrate-sheets-to-firebase.mjs            # dry run, prints a summary
//   node scripts/migrate-sheets-to-firebase.mjs --write     # actually writes to Firebase

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHEETS_CRED_PATH = path.resolve(__dirname, '..', 'service_account_cred.json');
const FIREBASE_CRED_PATH = path.resolve(__dirname, '..', 'pw-warehouse-c203e-firebase-adminsdk-fbsvc-f2c6b3aa93.json');
const SPREADSHEET_ID = '127nEwrOV5Ji4n1d_eHw1pP4VWQZYoO9nq6eurirforI';
const DATABASE_URL = 'https://pw-warehouse-c203e-default-rtdb.firebaseio.com';

const WRITE = process.argv.includes('--write');

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getSheetsAccessToken() {
  const cred = JSON.parse(readFileSync(SHEETS_CRED_PATH, 'utf8'));
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: cred.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: cred.token_uri,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(cred.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch(cred.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheets token error: ${JSON.stringify(json)}`);
  return json.access_token;
}

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

// Drops empty-string / undefined fields so Firebase doesn't store clutter
// (and so `set()` doesn't choke on `undefined`).
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === '' || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

async function main() {
  const token = await getSheetsAccessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('Data!O5:U3004')}?valueRenderOption=UNFORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheets read failed: ${JSON.stringify(json)}`);
  const rows = json.values || [];

  const containers = {};
  for (const row of rows) {
    const id = str(row[0]);
    if (!id) continue;
    containers[id] = compact({
      location: str(row[1]),
      containerType: str(row[2]),
      label: str(row[4]),
      notes: str(row[5]),
    });
  }

  const containerIds = Object.keys(containers);
  console.log(`Read ${rows.length} rows -> ${containerIds.length} containers to migrate.`);
  console.log('Sample:', JSON.stringify(Object.fromEntries(containerIds.slice(0, 2).map((id) => [id, containers[id]])), null, 2));

  if (!WRITE) {
    console.log('\nDry run only — no changes written. Re-run with --write to apply.');
    return;
  }

  const firebaseCred = JSON.parse(readFileSync(FIREBASE_CRED_PATH, 'utf8'));
  initializeApp({ credential: cert(firebaseCred), databaseURL: DATABASE_URL });
  const db = getDatabase();

  await db.ref('containers').set(containers);
  console.log(`\nWrote ${containerIds.length} containers to Firebase RTDB at ${DATABASE_URL}.`);
  console.log('Items / ItemStacks / ContainerTypes were empty in the source sheet, so nothing to migrate for those.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
