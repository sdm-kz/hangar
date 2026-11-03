// Client-side Web Push helpers: register the service worker, and subscribe/unsubscribe this
// browser (or installed PWA) with the server. On iOS this only works from an installed Home-Screen
// PWA (iOS 16.4+); elsewhere it works in a normal tab. See server/Push for the sending side.

import { api } from "./api";

const SW_URL = "/sw.js";

/** True if the browser can do Web Push at all (service workers + Push API + Notifications). */
export function isPushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** True when running as an installed PWA (standalone display) — required for push on iOS. */
export function isStandalone(): boolean {
  // iOS Safari uses the non-standard navigator.standalone; everyone else exposes display-mode.
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}

/** Register the push service worker. No-op (returns null) where unsupported. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL);
  } catch {
    return null;
  }
}

export type PushState =
  | "unsupported" // browser can't do push
  | "needs-install" // supported, but must be added to Home Screen first (iOS)
  | "default" // installed/supported, not yet granted — can prompt
  | "denied" // permission denied at the OS/browser level
  | "subscribed"; // actively subscribed on the server

/** Report where this device stands so the UI can show the right control. */
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  // iOS refuses push from a normal Safari tab — the user must install the PWA first.
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  if (iOS && !isStandalone()) return "needs-install";
  if (Notification.permission === "denied") return "denied";

  const reg = await navigator.serviceWorker.getRegistration();
  const existing = await reg?.pushManager.getSubscription();
  if (existing && Notification.permission === "granted") return "subscribed";
  return "default";
}

/**
 * Subscribe this device for push and register it with the server. Must be called from a user gesture
 * (iOS requirement). Returns the resulting state.
 */
export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "default";

  const reg = (await navigator.serviceWorker.ready) ?? (await registerServiceWorker());
  if (!reg) return "default";

  const { publicKey } = await api.pushConfig();
  // No key to subscribe against: the server's stored keypair couldn't be used, and a subscription made
  // against the stand-in it is running on would be silently dead from the next restart on (the browser
  // would still call itself subscribed). Better to say push isn't available here.
  if (!publicKey) return "unsupported";
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true, // iOS enforces that every push shows a notification
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await api.pushSubscribe(sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } });
  return "subscribed";
}

/**
 * Whether this browser gets Web Push from the server: then a push is how it hears about everything,
 * and the page raising a notification of its own would be the second one (see osNotify).
 */
export async function hasPushSubscription(): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(await reg?.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/** Unsubscribe this device and tell the server to forget it. */
export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    const { endpoint } = sub;
    try {
      await sub.unsubscribe();
    } finally {
      await api.pushUnsubscribe(endpoint).catch(() => {});
    }
  }
  return (await getPushState());
}

/**
 * If this browser rotated its push subscription (endpoints can change after OS updates/reinstalls),
 * re-register the current one with the server. Cheap to call on load when already subscribed.
 */
export async function syncSubscription(): Promise<void> {
  if (!isPushSupported() || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api
      .pushSubscribe(sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } })
      .catch(() => {});
  }
}

// VAPID public keys are URL-safe base64; the Push API wants raw bytes. Build over an explicit
// ArrayBuffer so the type is Uint8Array<ArrayBuffer> (what applicationServerKey/BufferSource expects).
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
