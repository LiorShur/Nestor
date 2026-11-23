# CareCall — Firebase Setup Guide
## One-time setup (~10 minutes). Users never need to do this.

---

## Step 1 — Create a Firebase project

1. Go to **https://console.firebase.google.com**
2. Click **"Add project"**
3. Name it `carecall` (or anything you like)
4. Disable Google Analytics (not needed) → **Create project**

---

## Step 2 — Enable Anonymous Authentication

1. In your project, go to **Build → Authentication**
2. Click **"Get started"**
3. Under **Sign-in providers**, click **Anonymous**
4. Toggle it **on** → **Save**

---

## Step 3 — Create a Realtime Database

1. Go to **Build → Realtime Database**
2. Click **"Create database"**
3. Choose your region (pick closest to you)
4. Select **"Start in test mode"** → **Enable**

---

## Step 4 — Set database rules

1. In the Realtime Database, click the **"Rules"** tab
2. Replace everything with:

```json
{
  "rules": {
    "carecall": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

3. Click **Publish**

---

## Step 5 — Get your config

1. Click the **gear icon** → **Project settings**
2. Scroll down to **"Your apps"**
3. Click the **</>** (web) icon
4. Register the app (any name, e.g. `carecall-web`)
5. Copy the `firebaseConfig` object — it looks like this:

```javascript
const firebaseConfig = {
  apiKey:            "AIzaSy...",
  authDomain:        "carecall-abc12.firebaseapp.com",
  databaseURL:       "https://carecall-abc12-default-rtdb.firebaseio.com",
  projectId:         "carecall-abc12",
  storageBucket:     "carecall-abc12.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc..."
};
```

---

## Step 6 — Paste into carecall-firebase.html

Open `carecall-firebase.html` and find the config block at the top:

```javascript
const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  ...
```

Replace each `"YOUR_..."` value with the real values from Step 5.

---


## Files to deploy

Upload ALL of these to Netlify (drag the whole folder):

| File | Purpose |
|------|---------|
|  | The app |
|  | PWA metadata (name, icon, color) |
|  | Service worker (offline + fast loading) |
|  | App icon (home screen, small) |
|  | App icon (home screen, large) |

> **Important:** All files must be in the same folder and served from the same domain for the PWA to work.

## Step 7 — Host the file

The file needs to be served over HTTPS (not opened directly from disk).

**Easiest — Netlify (free, 2 minutes):**
1. Go to **https://netlify.com** → sign up free
2. Drag and drop `carecall-firebase.html` onto the Netlify dashboard
3. You get a URL like `https://something.netlify.app/carecall-firebase.html`
4. Share that link with your users

**Or — GitHub Pages:**
1. Create a GitHub repo
2. Upload the HTML file
3. Go to Settings → Pages → enable from main branch
4. Your URL: `https://yourusername.github.io/repo/carecall-firebase.html`

---

## How users use it

1. They open the URL
2. First time: pick role (Patient / Carer), enter name, create or join a room
3. The room code links them together — share the 4-character code between patient and carer
4. App saves their profile — next time they open it, they reconnect automatically

## Features

- 🛏️ **Patient** — Big call button + specific need buttons (Water, Medication, Food, Toilet, Pain, Message)
- 🔔 **Carer** — Standby screen + full-screen incoming alert with bell + vibration
- 📋 **Call log** — Full history with who called, what they needed, who responded, response time
- ⚙️ **Settings** — Manage multiple rooms, edit name, join additional rooms
- 👥 **Many-to-many** — Multiple carers and patients can share the same room code
- 💾 **Auto-saved** — Profile and rooms saved, reconnects automatically on open

---

## Costs

Firebase free tier (Spark plan) is more than sufficient:
- 1 GB realtime database storage
- 10 GB/month data transfer
- 100 simultaneous connections

For a home care app with a handful of users, this will never exceed the free tier.
