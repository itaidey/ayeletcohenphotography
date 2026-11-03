const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

const clientScript = String.raw`
const status = document.getElementById("status");
const albumsElement = document.getElementById("albums");
let site = { phone: "", instagram: "", albums: [] };

const setStatus = (message, isError = false) => {
  status.textContent = message;
  status.classList.toggle("error", isError);
};

async function request(path, options) {
  const response = await fetch("/config/api" + path, options);
  if (!response.ok) throw new Error((await response.text()) || "Something went wrong");
  site = await response.json();
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
    setStatus(error.message || "Something went wrong. Please try again.", true);
    return false;
  }
}

function addPhotos(album, files) {
  return run(async () => {
    let done = 0;
    for (const file of files) {
      setStatus("Uploading photo " + (done + 1) + " of " + files.length + "...");
      await request("/albums/" + album.id + "/photos", { method: "POST", body: file });
      done += 1;
      render();
    }
  }, files.length === 1 ? "Photo added." : files.length + " photos added.");
}

function renderAlbum(album) {
  const section = document.createElement("section");
  section.className = "album";

  const header = document.createElement("div");
  header.className = "album-header";
  const title = document.createElement("h3");
  title.textContent = album.name;
  const deleteAlbum = document.createElement("button");
  deleteAlbum.type = "button";
  deleteAlbum.className = "danger";
  deleteAlbum.textContent = "Delete album";
  deleteAlbum.addEventListener("click", () => {
    const count = album.photos.length;
    if (confirm('Delete "' + album.name + '" and its ' + count + " photo(s)? This cannot be undone.")) {
      run(() => request("/albums/" + album.id, { method: "DELETE" }), "Album deleted.");
    }
  });
  header.append(title, deleteAlbum);

  const label = document.createElement("label");
  label.className = "file";
  label.textContent = "Add photos";
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "image/jpeg,image/png,image/webp,image/gif";
  input.addEventListener("change", () => {
    if (input.files.length > 0) addPhotos(album, [...input.files]);
  });
  label.append(input);

  const grid = document.createElement("div");
  grid.className = "grid";
  for (const id of album.photos) {
    const item = document.createElement("figure");
    const image = document.createElement("img");
    image.src = "/photos/" + id;
    image.alt = "Photo in " + album.name;
    image.loading = "lazy";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      if (confirm("Delete this photo? This cannot be undone.")) {
        run(() => request("/photos/" + id, { method: "DELETE" }), "Photo deleted.");
      }
    });
    item.append(image, remove);
    grid.append(item);
  }

  section.append(header, label, grid);
  return section;
}

function render() {
  albumsElement.replaceChildren(...site.albums.map(renderAlbum));
  if (site.albums.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No albums yet. Create one above to add photos.";
    albumsElement.append(empty);
  }
}

document.getElementById("profile").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    await sendJson("/profile", "PUT", {
      phone: document.getElementById("phone").value,
      instagram: document.getElementById("instagram").value,
    });
    document.getElementById("phone").value = site.phone;
    document.getElementById("instagram").value = site.instagram;
  }, "Contact details saved.");
});

document.getElementById("new-album").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("album-name");
  if (await run(() => sendJson("/albums", "POST", { name: name.value }), "Album created.")) {
    name.value = "";
  }
});

(async () => {
  try {
    const response = await fetch("/api/site", { cache: "no-store" });
    if (!response.ok) throw new Error();
    site = await response.json();
    document.getElementById("phone").value = site.phone;
    document.getElementById("instagram").value = site.instagram;
    render();
  } catch {
    setStatus("Could not load the site settings. Please refresh the page.", true);
  }
})();
`;

export const configPage = (email) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Site Settings</title>
  <style>
    :root { color-scheme: light dark; --bg: #f7f5f2; --fg: #1c1b19; --muted: #6f6b65; --line: #d9d4cc; --panel: #fffdfa; --danger: #a4302a; }
    @media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #f2efea; --muted: #a09b93; --line: #38352f; --panel: #1f1d1a; --danger: #ef8a83; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font-family: Georgia, "Times New Roman", serif; line-height: 1.5; }
    main { width: min(100%, 52rem); margin: 0 auto; padding: 2rem 1rem 6rem; }
    h1, h2, h3 { font-weight: 400; margin: 0; }
    h2 { font-size: 1.3rem; margin-bottom: 1rem; }
    .account, .hint { color: var(--muted); overflow-wrap: anywhere; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 1.25rem; margin-top: 1.25rem; }
    label { display: block; margin-bottom: .9rem; }
    input[type=text], input[type=tel] { display: block; width: 100%; margin-top: .25rem; padding: .6rem; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
    button, .file { display: inline-block; padding: .5rem .9rem; font: inherit; font-size: .95rem; color: inherit; background: transparent; border: 1px solid var(--muted); border-radius: 6px; cursor: pointer; }
    .row { display: flex; gap: .5rem; }
    .row input { margin-top: 0; }
    .row button { flex: none; }
    .danger { color: var(--danger); border-color: var(--danger); }
    .album { border-top: 1px solid var(--line); padding: 1.25rem 0; }
    .album:first-child { border-top: 0; padding-top: 0; }
    .album-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .5rem; margin-bottom: .75rem; }
    .album-header h3 { overflow-wrap: anywhere; min-width: 0; }
    .file input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .file:focus-within { outline: 2px solid currentColor; outline-offset: 2px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: .75rem; margin-top: 1rem; }
    figure { margin: 0; }
    figure img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 6px; margin-bottom: .4rem; }
    figure button { width: 100%; padding: .3rem; font-size: .85rem; }
    #status { position: fixed; left: 50%; bottom: 1rem; transform: translateX(-50%); width: min(calc(100% - 2rem), 30rem); margin: 0; padding: .6rem .9rem; text-align: center; background: var(--fg); color: var(--bg); border-radius: 6px; }
    #status:empty { display: none; }
    #status.error { background: var(--danger); color: #fff; }
  </style>
</head>
<body>
  <main>
    <h1>Site settings</h1>
    <p class="account">Signed in as ${escapeHtml(email)}. <a href="/">View the site</a></p>

    <section class="panel">
      <h2>Contact details</h2>
      <form id="profile">
        <label>Phone
          <input id="phone" type="tel" autocomplete="off" placeholder="050-000-0000">
        </label>
        <label>Instagram username or link
          <input id="instagram" type="text" autocomplete="off" placeholder="https://www.instagram.com/username/">
        </label>
        <button type="submit">Save contact details</button>
      </form>
    </section>

    <section class="panel">
      <h2>Albums</h2>
      <form id="new-album">
        <label for="album-name">New album name</label>
        <div class="row">
          <input id="album-name" type="text" maxlength="60" required>
          <button type="submit">Create</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <h2>Your photos</h2>
      <div id="albums"></div>
    </section>
  </main>
  <p id="status" role="status"></p>
  <script>${clientScript}</script>
</body>
</html>`;
