import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const viteEnv = ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {});

const firebaseConfig = {
  apiKey: viteEnv.VITE_FIREBASE_API_KEY,
  authDomain: viteEnv.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: viteEnv.VITE_FIREBASE_PROJECT_ID,
  storageBucket: viteEnv.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: viteEnv.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: viteEnv.VITE_FIREBASE_APP_ID,
  measurementId: viteEnv.VITE_FIREBASE_MEASUREMENT_ID,
};

const requiredKeys = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

let authPersistenceReady: Promise<void> | null = null;

export function getFirebaseEnvStatus() {
  const missing = requiredKeys.filter((key) => !viteEnv[key]);
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

export function getFirebaseAuth(): Auth | null {
  if (!isFirebaseConfigured()) return null;
  return getAuth(getFirebaseApp());
}

async function ensureAuthPersistence() {
  const auth = getFirebaseAuth();
  if (!auth || typeof window === 'undefined') return;

  if (!authPersistenceReady) {
    authPersistenceReady = setPersistence(auth, browserLocalPersistence).then(() => undefined);
  }

  await authPersistenceReady;
}

export async function signInToFirebase() {
  const auth = getFirebaseAuth();
  if (!auth) throw new Error('Firebase is not configured.');

  await ensureAuthPersistence();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider);
}

export async function signOutFromFirebase() {
  const auth = getFirebaseAuth();
  if (!auth) return;
  await signOut(auth);
}

export function onFirebaseAuthChanged(callback: (user: User | null) => void) {
  const auth = getFirebaseAuth();
  if (!auth) {
    callback(null);
    return () => undefined;
  }

  void ensureAuthPersistence();
  return onAuthStateChanged(auth, callback);
}

export type { User };
export { firebaseConfig };
