// Web Push: subscribe this phone for reminders, and clear the reminder
// once you've written.

import { VAPID_PUBLIC_KEY } from "./config.js";

export const TAG = "daily-reminder";

export function pushSupport() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (ios && !installed) return { ok: false, why: "On iPhone, add the app to your Home Screen first (Share → Add to Home Screen), open it from there, then turn this on." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, why: "This browser can't show notifications. Try Chrome on Android, or Safari on iPhone with the app on your Home Screen." };
  }
  if (Notification.permission === "denied") {
    return { ok: false, why: "Notifications are blocked for this app. Allow them in your phone's settings, then try again." };
  }
  return { ok: true };
}

function keyBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Must be called from a tap (browsers only ask for permission after one).
export async function enablePush(sb) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications weren't allowed");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }));
  const { endpoint, keys } = sub.toJSON();
  const { error } = await sb.from("push_subscriptions")
    .upsert({ endpoint, p256dh: keys.p256dh, auth: keys.auth }, { onConflict: "endpoint" });
  if (error) throw error;
}

export async function disablePush(sb) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
}

// Called when you've written in all your groups today.
export async function clearReminder() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const shown = (await reg?.getNotifications?.({ tag: TAG })) ?? [];
    shown.forEach((n) => n.close());
    await navigator.clearAppBadge?.();
  } catch { /* not supported here: nothing to clear */ }
}
