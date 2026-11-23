#!/bin/bash
# Build script: Vite build → copy to www/ → Capacitor sync
echo "📦 Building CareCall for Android..."

# 1. Run Vite production build (outputs to dist/)
npm run build
if [ $? -ne 0 ]; then
  echo "❌ Vite build failed"
  exit 1
fi

# 2. Copy Vite output to www/ for Capacitor
rm -rf www/*
cp -r dist/* www/

# 3. Sync to Android
npx cap sync android

# 4. Restore google-services.json (cap sync may overwrite app/ contents)
if [ -f google-services.json ]; then
  cp google-services.json android/app/google-services.json
  echo "✅ google-services.json copied to android/app/"
elif [ ! -f android/app/google-services.json ]; then
  echo "⚠️  google-services.json not found! Push notifications won't work."
  echo "   Download from Firebase Console and place in project root."
fi

echo "✅ Build complete! Open in Android Studio with: npx cap open android"
