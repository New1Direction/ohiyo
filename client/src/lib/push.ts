import { api, type PushDevice } from "../api";

export async function registerOhiyoServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || location.protocol !== "https:" && location.hostname !== "localhost") return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function key(subscription: PushSubscription, name: PushEncryptionKeyName): string | null {
  const buf = subscription.getKey(name);
  if (!buf) return null;
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function canUseWebPush(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function enableContentFreeWebPush(token: string): Promise<PushDevice> {
  if (!canUseWebPush()) throw new Error("This browser does not support web push notifications.");
  const cfg = await api.getPushConfig();
  if (!cfg.enabled || !cfg.vapid_public_key) {
    throw new Error("Server push is not configured yet. You can still use local notifications while Ohiyo is open.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  const registration = await registerOhiyoServiceWorker();
  if (!registration) throw new Error("Could not install the Ohiyo service worker.");
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(cfg.vapid_public_key),
  });
  const p256dh = key(subscription, "p256dh");
  const auth = key(subscription, "auth");
  if (!p256dh || !auth) throw new Error("Browser did not expose web push keys.");
  return api.registerPushDevice(token, {
    platform: "web",
    endpoint: subscription.endpoint,
    p256dh,
    auth,
    device_name: navigator.userAgent.includes("Mobile") ? "Mobile PWA" : "Web browser",
  });
}
