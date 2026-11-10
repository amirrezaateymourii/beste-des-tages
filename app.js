// Best of the Day v3: app logic.
//
// The browser talks straight to Supabase (login, data, photos). The rules
// about who can see what live in the database (supabase/*.sql), so this file
// only decides what to show.
//
// Model: you can have several besties. Each friendship is a "pair" (a group
// of exactly two). You write ONE entry a day and it is saved into every pair,
// so each bestie sees it once they've written theirs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { preparePhoto } from "./photo.js";
import { pushSupport, enablePush, disablePush, clearReminder } from "./push.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }, // stay signed in until "Sign out"
});

// The daily question. Same one for everyone on the same day.
const PROMPTS = [
  "What's up?", "What's going on?", "Anything new?", "Best moment today?",
  "What made today?", "Tell me something good.", "How was today?", "What's the highlight?",
];

// ================================================================ helpers

const $ = (id) => document.getElementById(id);
const SCREENS = ["login", "code", "name", "pair", "app"];

function show(name) {
  $("loading").hidden = true;
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  $("tabbar").hidden = name !== "app";
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 3000);
}

// h("p", { class: "x", dir: "auto" }, "text", child…) builds elements.
// Text always goes in as text (never HTML), so nobody can inject markup.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
const svg = (inner, size = 22) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("width", size); s.setAttribute("height", size); s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = inner; // constant icon markup only
  return s;
};
const ICON = {
  camera: '<rect x="3" y="5" width="18" height="15" rx="3"/><circle cx="12" cy="12.5" r="3.5"/><path d="M8 5l1.5-2h5L16 5"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};

function must({ data, error }) {
  if (error) throw error;
  return data;
}

// Wraps handlers: errors become a toast, buttons can't be double-tapped.
function action(fn) {
  return async (event) => {
    event?.preventDefault?.();
    const btn = event?.submitter ?? (event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null);
    if (btn) btn.disabled = true;
    try {
      await fn(event);
    } catch (err) {
      console.error(err);
      toast(err?.message ?? "Something went wrong");
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

// ------------------------------------------------------------------ dates
const isoDay = (d = new Date()) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD, local
const fromIso = (iso) => new Date(iso + "T12:00:00");
const addDays = (iso, n) => { const d = fromIso(iso); d.setDate(d.getDate() + n); return isoDay(d); };
const today = () => isoDay();
const yesterday = () => addDays(today(), -1);
const mondayOf = (iso) => addDays(iso, -((fromIso(iso).getDay() + 6) % 7));
const fmt = (iso, o) => fromIso(iso).toLocaleDateString("en-GB", o);
const timeOf = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
function promptFor(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return PROMPTS[Math.floor(Date.UTC(y, m - 1, d) / 86400000) % PROMPTS.length];
}
function whenLabel(iso) {
  if (iso === today()) return "Today";
  if (iso === yesterday()) return "Yesterday";
  const days = (fromIso(today()) - fromIso(iso)) / 86400000;
  return days < 7 ? fmt(iso, { weekday: "long" }) : fmt(iso, { day: "numeric", month: "short" });
}

// --------------------------------------------------------- spotify links
// Accepts links from Spotify → Share → Copy link, e.g.
// https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=…
function spotifyEmbed(url) {
  const m = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode)\/([A-Za-z0-9]{10,40})/.exec((url || "").trim());
  return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator` : null;
}
const songFrame = (url) => {
  const src = spotifyEmbed(url);
  return src ? h("iframe", { class: "song", src, title: "Song on Spotify", loading: "lazy", allow: "encrypted-media; clipboard-write" }) : null;
};

// ================================================================== state

const state = {
  user: null,
  email: null,
  profile: null,
  pairs: [],       // [{ id, code, members: [{ user_id, joined_at }] }]
  besties: [],     // [{ id, name, avatarUrl, pairId, since }]
  me: null,        // { id, name, avatarUrl }
  tab: "home",
  weekOffset: 0,
  sel: today(),
  week: null,
  editing: false,
  draft: "",
  photo: null,     // { blob, url } picked, not uploaded yet
  removePhoto: false,
  song: "",
  songOpen: false,
  feedLimit: 30,
  open: null,      // which settings panel is open
};
const pairIds = () => state.pairs.filter((p) => p.members.length === 2).map((p) => p.id);

function avatar(person, size = "") {
  const cls = `avatar ${size} ${person?.id === state.user?.id ? "" : "them"}`;
  if (person?.avatarUrl) return h("img", { class: cls, src: person.avatarUrl, alt: "", draggable: "false", oncontextmenu: (e) => e.preventDefault() });
  return h("span", { class: cls, "aria-hidden": "true" }, [...(person?.name || "?")][0].toUpperCase());
}


// A profile picture you can tap to see bigger (only if there is one).
function viewable(person, size) {
  if (!person?.avatarUrl) return avatar(person, size);
  const name = person.id === state.user?.id ? "your" : `${person.name}'s`;
  return h("button", { type: "button", class: "avatar-btn", "aria-label": `View ${name} profile picture`, onclick: () => openViewer(person) },
    avatar(person, size));
}

// Full-screen preview: the picture grows into a big circle over a blurred,
// faded background. Tap anywhere, press Escape or use the phone's back
// gesture to close.
function openViewer(person) {
  const opener = document.activeElement;
  const name = person.id === state.user?.id ? state.me.name : person.name;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("popstate", finish);
    v.classList.remove("on");
    setTimeout(() => v.remove(), 220);
    opener?.focus?.();
  };
  const close = () => (history.state?.viewer ? history.back() : finish());
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const v = h("div", { class: "viewer", role: "dialog", "aria-modal": "true", "aria-label": `${name}, profile picture`, onclick: close },
    h("img", { class: "viewer-img", src: person.avatarUrl, alt: `${name}, profile picture`, draggable: "false", oncontextmenu: (e) => e.preventDefault() }),
    h("p", { class: "viewer-name", dir: "auto" }, name),
    h("button", { type: "button", class: "round-btn viewer-close", "aria-label": "Close" }, svg(ICON.close)));
  document.body.append(v);
  history.pushState({ viewer: true }, "");
  window.addEventListener("popstate", finish);
  document.addEventListener("keydown", onKey);
  requestAnimationFrame(() => v.classList.add("on"));
  v.querySelector(".viewer-close").focus();
}

// ================================================================ routing

async function route() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show("login");
  state.user = session.user;

  state.profile = must(await sb.from("profiles").select("*").eq("id", state.user.id).maybeSingle());
  if (!state.profile) return show("name");

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && state.profile.timezone !== tz) {
    await sb.from("profiles").update({ timezone: tz }).eq("id", state.user.id);
    state.profile.timezone = tz;
  }

  await loadPeople();
  if (!state.besties.length) return openPair(false);
  show("app");
  await switchTab(state.tab);
}

// Pairs, besties, names and profile pictures.
async function loadPeople() {
  const groups = must(await sb.from("groups").select("id, invite_code, created_at").order("created_at"));
  const members = must(await sb.from("group_members").select("group_id, user_id, joined_at"));
  state.pairs = groups.map((g) => ({ id: g.id, code: g.invite_code, members: members.filter((m) => m.group_id === g.id) }));

  const otherIds = [...new Set(members.map((m) => m.user_id).filter((id) => id !== state.user.id))];
  const profiles = must(await sb.from("profiles").select("id, display_name, avatar_path").in("id", [state.user.id, ...otherIds]));
  const paths = profiles.filter((p) => p.avatar_path).map((p) => p.avatar_path);
  const urls = new Map();
  if (paths.length) {
    const signed = must(await sb.storage.from("avatars").createSignedUrls(paths, 60 * 60 * 24));
    for (const s of signed) if (s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  const person = (id) => {
    const p = profiles.find((x) => x.id === id);
    return { id, name: p?.display_name ?? "Bestie", avatarUrl: p?.avatar_path ? urls.get(p.avatar_path) : null };
  };
  state.me = { ...person(state.user.id), name: state.profile.display_name };
  state.besties = state.pairs
    .filter((p) => p.members.length === 2)
    .map((p) => {
      const m = p.members.find((x) => x.user_id !== state.user.id);
      return { ...person(m.user_id), pairId: p.id, since: m.joined_at };
    });
}

// ================================================================== auth

$("email-form").addEventListener("submit", action(async () => {
  state.email = $("email").value.trim().toLowerCase();
  must(await sb.auth.signInWithOtp({ email: state.email, options: { shouldCreateUser: true } }));
  $("code-email").textContent = state.email;
  $("code").value = "";
  show("code");
  $("code").focus();
}));

$("code-form").addEventListener("submit", action(async () => {
  must(await sb.auth.verifyOtp({ email: state.email, token: $("code").value.trim(), type: "email" }));
  await route();
}));

$("resend").addEventListener("click", action(async () => {
  must(await sb.auth.signInWithOtp({ email: state.email, options: { shouldCreateUser: true } }));
  toast("Sent again. Check your inbox");
}));
$("code-back").addEventListener("click", () => show("login"));

$("name-form").addEventListener("submit", action(async () => {
  must(await sb.from("profiles").insert({
    id: state.user.id,
    display_name: $("display-name").value.trim(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  await route();
}));

// ================================================================ pairing

async function openPair(canGoBack) {
  $("pair-back").hidden = !canGoBack;
  $("join-code").value = "";
  show("pair");
  const id = must(await sb.rpc("create_pair"));
  const g = must(await sb.from("groups").select("invite_code").eq("id", id).single());
  $("my-code").textContent = g.invite_code;
  $("my-code").setAttribute("aria-label", "Your code: " + g.invite_code.split("").join(" "));
}

$("share-code").addEventListener("click", action(async () => {
  const code = $("my-code").textContent;
  const text = `Be my bestie on Best of the Day 🌞 My code: ${code}\n${location.origin}${location.pathname}`;
  if (navigator.share) await navigator.share({ text }).catch(() => {});
  else { await navigator.clipboard.writeText(text); toast("Copied"); }
}));

$("join-form").addEventListener("submit", action(async () => {
  must(await sb.rpc("join_group", { code: $("join-code").value }));
  toast("You're besties now 🎉");
  state.tab = "home";
  await route();
}));

$("pair-back").addEventListener("click", action(async () => { show("app"); await switchTab("people"); }));

// =================================================================== tabs

for (const b of document.querySelectorAll("#tabbar button")) {
  b.addEventListener("click", action(() => switchTab(b.dataset.tab)));
}

async function switchTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll("#tabbar button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  for (const t of ["home", "feed", "people"]) $(`tab-${t}`).hidden = t !== tab;
  window.scrollTo(0, 0);
  if (tab === "home") await refreshHome();
  if (tab === "feed") await renderFeed();
  if (tab === "people") await renderPeople();
}

// =================================================================== home

async function refreshHome() {
  renderNudge();
  await shareToNewBesties();
  await loadWeek();
  renderStrip();
  renderDay();
}

// If you wrote today/yesterday before pairing with someone new, copy that
// entry into the new pair so the no-peeking rule works for them too.
async function shareToNewBesties() {
  const ids = pairIds();
  if (!ids.length) return;
  const mine = must(await sb.from("entries").select("group_id, day, body, photo_path, song_url")
    .eq("author_id", state.user.id).in("day", [today(), yesterday()]));
  for (const day of [today(), yesterday()]) {
    const have = mine.filter((e) => e.day === day);
    if (!have.length) continue;
    const src = have[0];
    for (const gid of ids.filter((id) => !have.some((e) => e.group_id === id))) {
      let photo_path = null;
      if (src.photo_path) {
        photo_path = `${gid}/${state.user.id}/${day}.jpg`;
        await sb.storage.from("photos").copy(src.photo_path, photo_path).catch(() => {});
      }
      await sb.from("entries").upsert({ group_id: gid, author_id: state.user.id, day, body: src.body, photo_path, song_url: src.song_url },
        { onConflict: "group_id,author_id,day" });
    }
  }
}

async function loadWeek() {
  const from = addDays(mondayOf(today()), 7 * state.weekOffset);
  const to = addDays(from, 6);
  const ids = pairIds();
  const [entries, ...written] = await Promise.all([
    sb.from("entries").select("group_id, author_id, day, body, photo_path, song_url, created_at")
      .in("group_id", ids).gte("day", from).lte("day", to).then(must),
    ...ids.map((g) => sb.rpc("written_days", { g, d_from: from, d_to: to }).then(must)),
  ]);
  const urls = await photoUrls(entries);
  state.week = {
    from, to,
    entries: entries.map((e) => ({ ...e, photoUrl: e.photo_path ? urls.get(e.photo_path) : null })),
    written: new Set(written.flat().map((w) => `${w.day}|${w.user_id}`)),
  };
  // Written today in every pair? Then the reminder can go away.
  const t = today();
  if (ids.every((g) => entries.some((e) => e.group_id === g && e.author_id === state.user.id && e.day === t))) clearReminder();
}

async function photoUrls(entries) {
  const paths = [...new Set(entries.filter((e) => e.photo_path).map((e) => e.photo_path))];
  const urls = new Map();
  if (paths.length) {
    const signed = must(await sb.storage.from("photos").createSignedUrls(paths, 60 * 60));
    for (const s of signed) if (s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  return urls;
}

function renderStrip() {
  const strip = $("strip");
  const { from, written, entries } = state.week;
  strip.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const day = addDays(from, i);
    const future = day > today();
    const meWrote = entries.some((e) => e.author_id === state.user.id && e.day === day) || written.has(`${day}|${state.user.id}`);
    const themWrote = state.besties.some((b) => written.has(`${day}|${b.id}`));
    strip.append(h("button", {
      class: "day-btn" + (day === state.sel ? " sel" : "") + (day === today() ? " today" : ""),
      disabled: future,
      "aria-label": fmt(day, { weekday: "long", day: "numeric", month: "long" }) + (meWrote ? ", you wrote" : "") + (themWrote ? ", your bestie wrote" : ""),
      "aria-pressed": day === state.sel ? "true" : "false",
      onclick: () => { if (!swiped) selectDay(day); },
    },
    h("span", { class: "wd", "aria-hidden": "true" }, fmt(day, { weekday: "narrow" })),
    h("span", { class: "num", "aria-hidden": "true" }, String(fromIso(day).getDate())),
    h("span", { class: "dots", "aria-hidden": "true" },
      h("span", { class: "dot" + (meWrote ? " me" : "") }),
      h("span", { class: "dot" + (themWrote ? " them" : "") }))));
  }
}

// Swipe the days left/right to change week.
let x0 = null, swiped = false;
$("strip").addEventListener("pointerdown", (e) => { x0 = e.clientX; swiped = false; });
$("strip").addEventListener("pointerup", action(async (e) => {
  if (x0 === null) return;
  const dx = e.clientX - x0;
  x0 = null;
  if (Math.abs(dx) < 50) return;
  swiped = true;
  setTimeout(() => (swiped = false), 50);
  if (dx < 0 && state.weekOffset >= 0) return; // no future weeks
  const strip = $("strip");
  strip.classList.add(dx > 0 ? "slide-right" : "slide-left");
  state.weekOffset += dx > 0 ? -1 : 1;
  const sunday = addDays(mondayOf(today()), 7 * state.weekOffset + 6);
  state.sel = sunday > today() ? today() : sunday;
  resetDraft();
  await loadWeek();
  strip.classList.remove("slide-left", "slide-right");
  renderStrip();
  renderDay();
}));
$("strip").addEventListener("pointercancel", () => { x0 = null; });

function selectDay(day) {
  if (day === state.sel) return;
  state.sel = day;
  resetDraft();
  renderStrip();
  renderDay();
}

function resetDraft() {
  state.editing = false;
  state.draft = "";
  if (state.photo) URL.revokeObjectURL(state.photo.url);
  state.photo = null;
  state.removePhoto = false;
  state.song = "";
  state.songOpen = false;
}

function renderDay() {
  const day = state.sel;
  const { entries, written } = state.week;
  const mine = entries.find((e) => e.author_id === state.user.id && e.day === day);
  const editable = day === today() || day === yesterday();
  const parts = [];

  if (editable && (!mine || state.editing)) parts.push(composer(day, mine));
  else parts.push(entryBlock(state.me, mine, day, editable));

  for (const b of state.besties) {
    const e = entries.find((x) => x.author_id === b.id && x.day === day);
    if (e || !(editable && (!mine || state.editing))) {
      parts.push(entryBlock(b, e, day, false, written.has(`${day}|${b.id}`)));
    }
  }
  $("day").replaceChildren(...parts);
}

function entryBlock(person, e, day, editable, wrote = false) {
  const isMe = person.id === state.user.id;
  // Name on the left; at the end of the line the time it was posted, in a
  // pale colour (after "Edit" on your own moment).
  const who = h("div", { class: "who" }, avatar(person),
    h("span", { class: "grow", dir: "auto" }, isMe ? "You" : person.name),
    e?.created_at ? h("time", { class: "posted-at", datetime: e.created_at }, timeOf(e.created_at)) : null,
    isMe && editable && e ? h("button", { class: "edit-btn", "aria-label": "Edit your moment", onclick: () => startEdit(e) }, svg(ICON.pencil, 16)) : null);
  if (!e) {
    let text = "Nothing this day";
    if (!isMe && wrote) text = "Wrote · save yours to see it";
    else if (!isMe && day === today()) text = "Hasn't written yet";
    return h("article", { class: "entry" }, who, h("p", { class: "entry-text none" }, text));
  }
  return h("article", { class: "entry" }, who,
    h("p", { class: "entry-text", dir: "auto" }, e.body),
    e.photoUrl ? h("img", { class: "photo", src: e.photoUrl, alt: `Photo from ${isMe ? "you" : person.name}`, loading: "lazy" }) : null,
    e.song_url ? songFrame(e.song_url) : null);
}

function startEdit(e) {
  state.editing = true;
  state.draft = e.body;
  state.song = e.song_url || "";
  state.songOpen = !!e.song_url;
  renderDay();
  $("entry")?.focus();
}

function composer(day, mine) {
  const textarea = h("textarea", {
    id: "entry", dir: "auto", maxlength: "1000", placeholder: day === today() ? "Write it down…" : "Forgot yesterday? Add it now…",
    oninput: (e) => { state.draft = e.target.value; },
  });
  textarea.value = state.draft;

  const existingUrl = mine?.photoUrl && !state.removePhoto ? mine.photoUrl : null;
  const previewUrl = state.photo?.url ?? existingUrl;

  const photoBtn = h("label", { class: "round-btn" + (previewUrl ? " on" : "") },
    h("input", { type: "file", accept: "image/*", class: "sr-only", "aria-label": "Add a photo", onchange: pickPhoto }), svg(ICON.camera));
  const musicBtn = h("button", { type: "button", class: "round-btn" + (state.songOpen ? " on" : ""), "aria-label": "Add a song from Spotify", "aria-expanded": String(state.songOpen),
    onclick: () => { state.songOpen = !state.songOpen; renderDay(); if (state.songOpen) $("song")?.focus(); } }, svg(ICON.music));

  const songInput = state.songOpen ? h("div", { class: "stack" },
    h("label", { for: "song", class: "sr-only" }, "Spotify link"),
    h("input", { id: "song", class: "song-input", type: "url", inputmode: "url", placeholder: "Paste a Spotify link (Share → Copy link)", value: state.song,
      oninput: (e) => { state.song = e.target.value; const f = songFrame(state.song); $("song-preview").replaceChildren(...(f ? [f] : [])); } }),
    h("div", { id: "song-preview" }, songFrame(state.song))) : null;

  const statuses = state.besties.map((b) => {
    const wrote = state.week.written.has(`${day}|${b.id}`);
    return h("p", { class: "status-line" }, avatar(b, "s30"),
      h("span", {}, h("strong", { dir: "auto" }, b.name), wrote ? " wrote · save yours to see it" : (day === today() ? " hasn't written yet" : " didn't write this day")));
  });

  return h("form", { class: "composer", onsubmit: action(save) },
    h("label", { for: "entry", class: "question" }, promptFor(day)),
    textarea,
    previewUrl ? h("div", { class: "preview" }, h("img", { src: previewUrl, alt: "Your photo" }),
      h("button", { type: "button", class: "round-btn small remove", "aria-label": "Remove photo", onclick: removePhoto }, svg(ICON.close, 18))) : null,
    songInput,
    h("div", { class: "tools" }, photoBtn, musicBtn, h("span", { class: "grow" }),
      mine ? h("button", { type: "button", class: "quiet-btn", onclick: () => { resetDraft(); renderDay(); } }, "Cancel") : null,
      h("button", { type: "submit", class: "btn" }, "Save")),
    statuses);
}

const pickPhoto = action(async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (state.photo) URL.revokeObjectURL(state.photo.url);
  state.photo = await preparePhoto(file);
  state.removePhoto = false;
  renderDay();
});

function removePhoto() {
  if (state.photo) { URL.revokeObjectURL(state.photo.url); state.photo = null; }
  else state.removePhoto = true;
  renderDay();
}

async function save() {
  const body = state.draft.trim();
  if (!body) { toast("Write something first"); $("entry")?.focus(); return; }
  const song_url = state.song.trim() || null;
  if (song_url && !spotifyEmbed(song_url)) { toast("That's not a Spotify song link. In Spotify: Share → Copy link"); return; }

  const day = state.sel, me = state.user.id;
  const mineAll = must(await sb.from("entries").select("group_id, photo_path").eq("author_id", me).eq("day", day));
  const src = mineAll.find((e) => e.photo_path)?.photo_path ?? null;

  for (const gid of pairIds()) {
    const path = `${gid}/${me}/${day}.jpg`;
    const had = mineAll.find((e) => e.group_id === gid)?.photo_path ?? null;
    let photo_path = null;
    if (state.photo) {
      must(await sb.storage.from("photos").upload(path, state.photo.blob, { upsert: true, contentType: "image/jpeg" }));
      photo_path = path;
    } else if (state.removePhoto) {
      if (had) await sb.storage.from("photos").remove([had]);
    } else if (had) {
      photo_path = had;
    } else if (src) {
      await sb.storage.from("photos").copy(src, path).catch(() => {});
      photo_path = path;
    }
    must(await sb.from("entries").upsert(
      { group_id: gid, author_id: me, day, body, photo_path, song_url, updated_at: new Date().toISOString() },
      { onConflict: "group_id,author_id,day" }));
  }
  resetDraft();
  toast("Saved 🌞");
  await loadWeek();
  renderStrip();
  renderDay();
}


// ---------------------------------------------------- notifications (once)
// No settings: the app asks once. After that, the server sends at most one
// reminder per evening (random time between 20:00 and 23:00 Tehran time),
// only if you haven't written yet.

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

async function turnOnReminders() {
  await enablePush(sb);
  must(await sb.from("profiles").update({ reminders_enabled: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }).eq("id", state.user.id));
  state.profile.reminders_enabled = true;
}

function renderNudge() {
  const box = $("nudge");
  box.replaceChildren();
  const s = pushSupport();
  const later = Number(store.get("nudge-later") || 0);
  const snoozed = Date.now() < later;

  if (s.ok && "Notification" in window && Notification.permission === "granted") {
    // Already allowed (e.g. after signing in again): reconnect quietly.
    if (!state.profile.reminders_enabled || !store.get("push-ok")) {
      turnOnReminders().then(() => store.set("push-ok", "1")).catch(console.error);
    }
    return;
  }
  if (snoozed) return;
  if (!s.ok) {
    if (s.code !== "install") return; // blocked or unsupported: don't nag
    box.append(h("div", { class: "nudge" },
      h("p", {}, "Add the app to your Home Screen to get an evening nudge when you haven't written yet."),
      h("p", { class: "hint" }, "Safari → Share → Add to Home Screen"),
      h("button", { class: "quiet-btn", onclick: () => { store.set("nudge-later", String(Date.now() + 7 * 864e5)); renderNudge(); } }, "Got it")));
    return;
  }
  box.append(h("div", { class: "nudge" },
    h("p", {}, "Get one nudge in the evening if you haven't written yet."),
    h("div", { class: "tools" },
      h("button", { class: "btn", onclick: action(async () => {
        try {
          await turnOnReminders(); // asks for permission: needs this tap
          store.set("push-ok", "1");
          toast("Notifications on 🌙");
        } catch (err) {
          toast(err.message);
        }
        renderNudge();
      }) }, "Turn on"),
      h("button", { class: "quiet-btn", onclick: () => { store.set("nudge-later", String(Date.now() + 3 * 864e5)); renderNudge(); } }, "Not now"))));
}

// =================================================================== feed

async function renderFeed() {
  const ids = pairIds();
  const rows = must(await sb.from("entries").select("group_id, author_id, day, body, photo_path, song_url, created_at")
    .in("group_id", ids).order("day", { ascending: false }).order("created_at", { ascending: false }).limit(state.feedLimit * 2));
  // Your entry is stored once per bestie; show it once.
  const seen = new Set();
  const posts = rows.filter((e) => { const k = `${e.author_id}|${e.day}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, state.feedLimit);
  const urls = await photoUrls(posts);
  const people = [state.me, ...state.besties];

  const feed = $("feed");
  if (!posts.length) {
    feed.replaceChildren(h("p", { class: "empty" }, "Nothing here yet. Your moments and your besties' will show up here."));
    return;
  }
  feed.replaceChildren(...posts.map((e) => {
    const p = people.find((x) => x.id === e.author_id) ?? { id: e.author_id, name: "Bestie" };
    const name = p.id === state.user.id ? "You" : p.name;
    const when = whenLabel(e.day);
    const photoUrl = e.photo_path ? urls.get(e.photo_path) : null;
    if (photoUrl) {
      return h("article", { class: "post" },
        h("div", { class: "post-photo" }, h("img", { class: "main", src: photoUrl, alt: `Photo from ${name}`, loading: "lazy" }),
          h("span", { class: "chip" }, avatar(p, "s22"), h("span", { dir: "auto" }, name), ` · ${when}`)),
        h("p", { class: "post-text", dir: "auto" }, e.body),
        e.song_url ? songFrame(e.song_url) : null);
    }
    return h("article", { class: "quote" },
      h("p", { class: "post-text", dir: "auto" }, e.body),
      e.song_url ? songFrame(e.song_url) : null,
      h("span", { class: "byline" }, avatar(p, "s30"), h("span", { dir: "auto" }, name), ` · ${when}`));
  }));
  if (rows.length >= state.feedLimit * 2) {
    feed.append(h("button", { class: "btn outline", onclick: action(async () => { state.feedLimit += 30; await renderFeed(); }) }, "Show more"));
  }
}

// ================================================================= people

async function renderPeople() {
  await loadPeople();
  const days = must(await sb.from("entries").select("day").eq("author_id", state.user.id).order("day", { ascending: false }).limit(1000));
  const unique = [...new Set(days.map((d) => d.day))];
  let streak = 0;
  let cursor = unique[0] === today() ? today() : yesterday();
  for (const d of unique) { if (d === cursor) { streak++; cursor = addDays(cursor, -1); } else if (d < cursor) break; }

  const me = h("section", { class: "me" },
    h("div", { class: "avatar-pick" },
      state.me.avatarUrl
        ? viewable(state.me, "s76")
        // no picture yet: tapping the circle picks one
        : h("label", { class: "avatar-btn", title: "Add a profile picture" }, avatar(state.me, "s76"),
            h("input", { type: "file", accept: "image/*", class: "sr-only", "aria-label": "Add a profile picture", onchange: pickAvatar })),
      h("label", { class: "plus", title: "Change profile picture" },
        h("input", { type: "file", accept: "image/*", class: "sr-only", "aria-label": "Change profile picture", onchange: pickAvatar }),
        svg(ICON.plus, 13))),
    h("div", {},
      h("div", { class: "name", dir: "auto" }, state.me.name),
      h("div", { class: "muted" }, `${unique.length} ${unique.length === 1 ? "moment" : "moments"}` + (streak > 1 ? ` · ${streak} days in a row` : ""))));

  const openInvite = state.pairs.find((x) => x.members.length === 1);
  const besties = h("section", { class: "list" },
    h("h2", { class: "label", style: "margin: 0 0 6px 4px" }, "Besties"),
    ...state.besties.map((b) => bestieRow(b)),
    h("button", { class: "row dashed", onclick: action(() => openPair(true)) },
      h("span", { class: "avatar s48", style: "background: var(--peach); color: var(--accent-text)", "aria-hidden": "true" }, svg(ICON.plus)),
      openInvite ? `Invite a bestie · code ${openInvite.code}` : "Invite a bestie"));

  const nameInput = h("input", { id: "my-name", maxlength: "40", dir: "auto", value: state.me.name, "aria-label": "Your name" });
  const namePanel = state.open === "name" ? h("form", { class: "panel", onsubmit: action(async () => {
    const display_name = nameInput.value.trim();
    if (!display_name) return;
    must(await sb.from("profiles").update({ display_name }).eq("id", state.user.id));
    state.profile.display_name = display_name;
    state.open = null;
    toast("Saved");
    await renderPeople();
  }) }, nameInput, h("button", { type: "submit", class: "btn" }, "Save name")) : null;

  const toggle = (k) => () => { state.open = state.open === k ? null : k; renderPeople(); };
  const settings = h("section", { class: "settings" },
    h("button", { class: "set-row", "aria-expanded": String(state.open === "name"), onclick: toggle("name") },
      h("span", { class: "grow" }, "Your name"), svg(ICON.chevron, 18)),
    namePanel);

  const signOut = h("button", { class: "quiet-btn", style: "align-self: center", onclick: action(signOutNow) }, "Sign out");

  $("people").replaceChildren(me, besties, settings, signOut);

}

function bestieRow(b) {
  const row = h("div", { class: "row" }, viewable(b, "s48"),
    h("div", { class: "grow" }, h("span", { class: "main", dir: "auto" }, b.name),
      h("span", { class: "sub" }, "Since " + new Date(b.since).toLocaleDateString("en-GB", { day: "numeric", month: "long" }))));
  const more = h("button", { class: "quiet-btn", "aria-label": `Unpair from ${b.name}` }, "Unpair");
  more.addEventListener("click", () => {
    more.replaceWith(h("span", { style: "display: flex; gap: 4px" },
      h("button", { class: "text-btn", onclick: action(async () => {
        must(await sb.rpc("leave_group", { g: b.pairId }));
        toast(`Unpaired from ${b.name}`);
        await loadPeople();
        if (!state.besties.length) return openPair(false);
        await renderPeople();
      }) }, "Unpair"),
      h("button", { class: "quiet-btn", onclick: () => renderPeople() }, "Cancel")));
  });
  row.append(more);
  return row;
}

const pickAvatar = action(async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const { blob } = await preparePhoto(file, 512);
  const path = `${state.user.id}.jpg`;
  must(await sb.storage.from("avatars").upload(path, blob, { upsert: true, contentType: "image/jpeg" }));
  must(await sb.from("profiles").update({ avatar_path: path }).eq("id", state.user.id));
  toast("Looking good");
  await renderPeople();
});

async function signOutNow() {
  await disablePush(sb).catch(() => {});
  await sb.auth.signOut();
  Object.assign(state, { user: null, profile: null, pairs: [], besties: [], me: null, week: null, tab: "home", open: null });
  $("email").value = "";
  show("login");
}

// ================================================================== start

// Coming back to the app: reload (someone may have posted) unless typing.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || $("screen-app").hidden) return;
  if (["entry", "song", "my-name"].includes(document.activeElement?.id)) return;
  if (state.sel > today()) state.sel = today();
  switchTab(state.tab).catch(console.error);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(console.error);

if (SUPABASE_URL.includes("YOUR-PROJECT")) {
  $("loading").textContent = "Set your Supabase URL and keys in config.js first (see README).";
} else {
  route().catch((err) => { console.error(err); toast(err.message); show("login"); });
}
