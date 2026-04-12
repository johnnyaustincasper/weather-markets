import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const requiredKeys = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

export function getFirebaseEnvStatus() {
  const missing = requiredKeys.filter((key) => !import.meta.env[key]);
  return {
    ready: missing.length === 0,
    missing,
  };
}

export function isFirebaseConfigured() {
  return getFirebaseEnvStatus().ready;
}

export function getFirebaseProjectId() {
  return firebaseConfig.projectId ?? null;
}

export function getFirebaseApp(): FirebaseApp {
  const { ready, missing } = getFirebaseEnvStatus();

  if (!ready) {
    throw new Error(`Firebase env is incomplete. Missing: ${missing.join(', ')}`);
  }

  return getApps()[0] ?? initializeApp(firebaseConfig);
}

export function getFirestoreDb(): Firestore | null {
  if (!isFirebaseConfigured()) return null;
  return getFirestore(getFirebaseApp());
}

export { firebaseConfig };
