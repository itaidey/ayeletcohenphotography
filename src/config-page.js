import { COPY, SERVICES } from "./content.js";

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

const pageData = {
  services: SERVICES.map((service) => ({
    slug: service.slug,
    name: service.en.name,
    he: service.he.description,
    en: service.en.description,
  })),
  defaults: { he: COPY.he.defaults, en: COPY.en.defaults },
};

const TEXT_FIELDS = [
  ["heroTagline", "Homepage small line", 1],
  ["heroTitle", "Homepage headline", 1],
  ["intro", "Homepage introduction", 6],
  ["about", "About page text", 8],
];

const textFields = TEXT_FIELDS.map(
  ([key, label, rows]) => `<div class="pair">
    <label>${label} (Hebrew)<textarea data-text="he.${key}" rows="${rows}" dir="rtl"></textarea></label>
    <label>${label} (English)<textarea data-text="en.${key}" rows="${rows}" dir="ltr"></textarea></label>
  </div>`,
).join("");

const clientScript = String.raw`
const data = JSON.parse(document.getElementById("page-data").textContent);
const status = document.getElementById("status");
let site = null;

const setStatus = (message, isError = false) => {
  status.textContent = message;
  status.classList.toggle("error", isError);
};

async function request(path, options) {
  const response = await fetch("/config/api" + path, options);
  if (!response.ok) throw new Error((await response.text()) || "Something went wrong");
  const result = await response.json();
  site = result;
  return result;
}

const sendJson = (path, method, body) =>
  request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function run(action, doneMessage) {
  setStatus("Saving...");
  try {
    await action();
    render();
    setStatus(doneMessage);
    return true;
  } catch (error) {
    setStatus(error.message || "Something went wrong. Try again.", true);
    return false;
  }
}

function resize(bitmap, longestEdge, quality) {
  const scale = Math.min(1, longestEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("This photo could not be prepared."))), "image/jpeg", quality);
  });
}

async function prepare(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(file.name + " could not be opened. Use a JPEG or PNG photo.");
  }
  const full = await resize(bitmap, 2400, 0.86);
  const thumb = await resize(bitmap, 900, 0.8);
  bitmap.close();
  return { full, thumb };
}

function upload(path, files) {
  return run(async () => {
    let done = 0;
    for (const file of files) {
      setStatus("Preparing photo " + (done + 1) + " of " + files.length + "...");
      const { full, thumb } = await prepare(file);
      setStatus("Uploading photo " + (done + 1) + " of " + files.length + "...");
      const result = await request(path, { method: "POST", body: full });
      await request("/photos/" + result.photoId + "/thumb", { method: "PUT", body: thumb });
      done += 1;
      render();
    }
  }, files.length === 1 ? "Photo added." : files.length + " photos added.");
}

function button(label, onClick, className = "") {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.className = className;
  element.addEventListener("click", onClick);
  return element;
}

function fileButton(label, multiple, onFiles) {
  const wrapper = document.createElement("label");
  wrapper.className = "file";
  wrapper.textContent = label;
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = multiple;
  input.accept = "image/jpeg,image/png,image/webp,image/heic";
  input.addEventListener("change", () => {
    if (input.files.length > 0) onFiles([...input.files]);
    input.value = "";
  });
  wrapper.append(input);
  return wrapper;
}

function photoCard(id, isFirst, extras) {
  const figure = document.createElement("figure");
  const image = document.createElement("img");
  image.src = "/photos/" + id + "/thumb";
  image.alt = "";
  image.loading = "lazy";
  figure.append(image);
  if (isFirst) {
    const tag = document.createElement("span");
    tag.textContent = "Cover photo";
    figure.append(tag);
  }
  figure.append(...extras);
  return figure;
}

const deletePhoto = (id) => {
  if (confirm("Delete this photo? This cannot be undone.")) {
    run(() => request("/photos/" + id, { method: "DELETE" }), "Photo deleted.");
  }
};

function moveSelect(id) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Move photo to a service");
  select.append(new Option("Move to...", ""));
  for (const service of data.services) select.append(new Option(service.name, service.slug));
  select.addEventListener("change", () => {
    if (select.value) run(() => sendJson("/photos/" + id + "/move", "POST", { service: select.value }), "Photo moved.");
  });
  return select;
}

function renderSlot(key, field) {
  const holder = document.getElementById("slot-" + key);
  const id = site[field];
  const items = [fileButton(id ? "Replace photo" : "Choose photo", false, (files) => upload("/slots/" + key, files))];
  if (id) {
    const image = document.createElement("img");
    image.src = "/photos/" + id + "/thumb";
    image.alt = "";
    items.unshift(image);
    items.push(button("Delete", () => {
      if (confirm("Delete this photo? This cannot be undone.")) {
        run(() => request("/slots/" + key, { method: "DELETE" }), "Photo deleted.");
      }
    }, "danger"));
  }
  holder.replaceChildren(...items);
}

function renderService(service) {
  const entry = site.services[service.slug];
  const section = document.createElement("details");
  section.className = "service";
  section.dataset.slug = service.slug;
  section.open = document.querySelector('[data-slug="' + service.slug + '"]')?.open ?? false;

  const summary = document.createElement("summary");
  summary.textContent = service.name + " (" + entry.photos.length + " photos)";
  section.append(summary);

  const pair = document.createElement("div");
  pair.className = "pair";
  const fields = {};
  for (const language of ["he", "en"]) {
    const label = document.createElement("label");
    label.textContent = "Description (" + (language === "he" ? "Hebrew" : "English") + ")";
    const area = document.createElement("textarea");
    area.rows = 4;
    area.dir = language === "he" ? "rtl" : "ltr";
    area.value = entry.text[language] || "";
    area.placeholder = service[language];
    label.append(area);
    fields[language] = area;
    pair.append(label);
  }
  const save = button("Save description", () =>
    run(() => sendJson("/services/" + service.slug + "/text", "PUT", { he: fields.he.value, en: fields.en.value }), "Description saved."));

  const grid = document.createElement("div");
  grid.className = "grid";
  entry.photos.forEach((id, index) => {
    const actions = [button("Delete", () => deletePhoto(id), "danger"), moveSelect(id)];
    if (index > 0) actions.unshift(button("Make cover", () => run(() => request("/photos/" + id + "/cover", { method: "POST" }), "Cover photo changed.")));
    grid.append(photoCard(id, index === 0, actions));
  });

  const add = fileButton("Add photos", true, (files) => upload("/services/" + service.slug + "/photos", files));
  section.append(pair, save, add, grid);
  return section;
}

function render() {
  renderSlot("hero", "heroPhoto");
  renderSlot("portrait", "portraitPhoto");
  document.getElementById("services").replaceChildren(...data.services.map(renderService));

  const unsorted = document.getElementById("unsorted");
  unsorted.hidden = site.unsorted.length === 0;
  document.getElementById("unsorted-grid").replaceChildren(
    ...site.unsorted.map((id) => photoCard(id, false, [moveSelect(id), button("Delete", () => deletePhoto(id), "danger")])),
  );
}

const inputs = {
  phone: document.getElementById("phone"),
  instagram: document.getElementById("instagram"),
  facebook: document.getElementById("facebook"),
  contactEmail: document.getElementById("contact-email"),
};

function fillForms() {
  for (const [key, input] of Object.entries(inputs)) input.value = site[key] || "";
  for (const area of document.querySelectorAll("[data-text]")) {
    const [language, key] = area.dataset.text.split(".");
    area.value = site.text[language][key] || "";
    area.placeholder = data.defaults[language][key];
  }
}

document.getElementById("settings").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    await sendJson("/settings", "PUT", Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])));
    fillForms();
  }, "Contact details saved.");
});

document.getElementById("texts").addEventListener("submit", (event) => {
  event.preventDefault();
  const body = { he: {}, en: {} };
  for (const area of document.querySelectorAll("[data-text]")) {
    const [language, key] = area.dataset.text.split(".");
    body[language][key] = area.value;
  }
  run(() => sendJson("/text", "PUT", body), "Text saved.");
});

(async () => {
  try {
    const response = await fetch("/config/api/site", { cache: "no-store" });
    if (!response.ok) throw new Error();
    site = await response.json();
    fillForms();
    render();
  } catch {
    setStatus("The settings could not be loaded. Refresh the page.", true);
  }
})();
`;

export const configPage = (email) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Site Settings</title>
  <style>
    :root { color-scheme: light; --bg: #f8f6f2; --fg: #33403d; --muted: #66716d; --line: #d9dcd6; --panel: #fffefb; --danger: #a4302a; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font-family: Assistant, "Segoe UI", Arial, sans-serif; line-height: 1.5; }
    main { width: min(100%, 60rem); margin: 0 auto; padding: 2rem 1rem 6rem; }
    h1, h2 { font-weight: 400; margin: 0; }
    h2 { font-size: 1.35rem; margin-bottom: .25rem; }
    .account, .hint { color: var(--muted); overflow-wrap: anywhere; margin-top: .25rem; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 1.25rem; margin-top: 1.25rem; }
    label { display: block; margin-bottom: .9rem; font-weight: 600; }
    input:not([type=file]), textarea, select { font: inherit; color: inherit; background: #fff; border: 1px solid #aab3ae; border-radius: 6px; }
    label input:not([type=file]), textarea { display: block; width: 100%; margin-top: .25rem; padding: .55rem; font-weight: 400; }
    textarea { resize: vertical; }
    select { max-width: 100%; padding: .3rem; font-size: .85rem; }
    button, .file { display: inline-block; margin: 0 .35rem .35rem 0; padding: .45rem .85rem; font: inherit; font-size: .95rem; font-weight: 400; color: inherit; background: transparent; border: 1px solid var(--muted); border-radius: 6px; cursor: pointer; }
    button[type=submit] { color: #fff; background: var(--fg); border-color: var(--fg); }
    .danger { color: var(--danger); border-color: var(--danger); }
    .file { position: relative; }
    .file input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .file:focus-within, button:focus-visible, summary:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    .pair { display: grid; gap: 0 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
    .slots { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
    .slot h3 { font-size: 1rem; margin: 0 0 .5rem; }
    .slot img { display: block; width: 100%; max-height: 14rem; object-fit: cover; border-radius: 6px; margin-bottom: .5rem; }
    .service { border-top: 1px solid var(--line); padding: .75rem 0; }
    .service summary { cursor: pointer; font-size: 1.1rem; }
    .service[open] summary { margin-bottom: .75rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: .75rem; margin-top: .75rem; }
    figure { position: relative; margin: 0; }
    figure img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 6px; margin-bottom: .4rem; }
    figure span { position: absolute; inset-block-start: .35rem; inset-inline-start: .35rem; padding: 0 .4rem; font-size: .8rem; background: var(--fg); color: #fff; border-radius: 4px; }
    figure button { padding: .2rem .5rem; font-size: .85rem; }
    #status { position: fixed; left: 50%; bottom: 1rem; transform: translateX(-50%); width: min(calc(100% - 2rem), 30rem); margin: 0; padding: .6rem .9rem; text-align: center; background: var(--fg); color: #fff; border-radius: 6px; }
    #status:empty { display: none; }
    #status.error { background: var(--danger); }
  </style>
</head>
<body>
  <main>
    <h1>Site settings</h1>
    <p class="account">Signed in as ${escapeHtml(email)}. <a href="/">View the site</a></p>

    <section class="panel">
      <h2>Contact details</h2>
      <p class="hint">These appear at the bottom of every page. The email stays private and receives the contact form.</p>
      <form id="settings">
        <div class="pair">
          <label>WhatsApp phone<input id="phone" type="tel" autocomplete="off" dir="ltr"></label>
          <label>Email for contact form messages<input id="contact-email" type="email" autocomplete="off" dir="ltr"></label>
          <label>Instagram username or link<input id="instagram" type="text" autocomplete="off" dir="ltr"></label>
          <label>Facebook page or link<input id="facebook" type="text" autocomplete="off" dir="ltr"></label>
        </div>
        <button type="submit">Save contact details</button>
      </form>
    </section>

    <section class="panel">
      <h2>Main photos</h2>
      <p class="hint">Photos are resized automatically when you add them.</p>
      <div class="slots">
        <div class="slot"><h3>Homepage photo</h3><div id="slot-hero"></div></div>
        <div class="slot"><h3>Photo of you</h3><div id="slot-portrait"></div></div>
      </div>
    </section>

    <section class="panel">
      <h2>Services and photos</h2>
      <p class="hint">Open a service to add photos and change its description. The first photo is the cover.</p>
      <div id="services"></div>
    </section>

    <section class="panel" id="unsorted" hidden>
      <h2>Photos to sort</h2>
      <p class="hint">These photos show in the gallery. Move each one to a service.</p>
      <div class="grid" id="unsorted-grid"></div>
    </section>

    <section class="panel">
      <h2>Website text</h2>
      <p class="hint">Leave a box empty to keep the suggested text shown in it.</p>
      <form id="texts">
        ${textFields}
        <button type="submit">Save text</button>
      </form>
    </section>
  </main>
  <p id="status" role="status"></p>
  <script type="application/json" id="page-data">${JSON.stringify(pageData).replace(/</g, "\\u003c")}</script>
  <script>${clientScript}</script>
</body>
</html>`;
