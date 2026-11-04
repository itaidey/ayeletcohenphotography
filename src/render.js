import { COPY, SERVICES } from "./content.js";

const ORIGIN = "https://ayeletcohenphotography.com";
const FONTS = "https://fonts.googleapis.com/css2?family=Assistant:wght@300;400;600&family=Bellefair&display=swap";
const TINTS = ["blush", "sage", "sky", "butter"];

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

const prefix = (language) => (language === "en" ? "/en" : "");
const localPath = (language, route) => `${prefix(language)}${route === "/" ? "" : route}` || "/";
const tint = (slug) => TINTS[SERVICES.findIndex((service) => service.slug === slug) % TINTS.length];

const paragraphs = (value) =>
  String(value)
    .split(/\n\s*\n/)
    .map((part) => `<p>${escapeHtml(part.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");

function whatsappLink(phone) {
  const digits = phone.replace(/[^0-9]/g, "");
  const international = phone.trim().startsWith("+") ? digits : digits.replace(/^0/, "972");
  return `https://wa.me/${international}`;
}

function image(id, alt, sizes, { eager = false, className = "" } = {}) {
  const url = `/photos/${id}`;
  return `<img class="${className}" src="${url}/thumb" srcset="${url}/thumb 900w, ${url} 2400w" sizes="${sizes}" alt="${escapeHtml(alt)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'}>`;
}

const textFor = (site, language, key) => site.text?.[language]?.[key]?.trim() || COPY[language].defaults[key];
const serviceText = (site, language, service) =>
  site.services?.[service.slug]?.text?.[language]?.trim() || service[language].description;
const servicePhotos = (site, slug) => site.services?.[slug]?.photos ?? [];
const allPhotos = (site) => [...SERVICES.flatMap((service) => servicePhotos(site, service.slug)), ...(site.unsorted ?? [])];

function navigation(language, route) {
  const copy = COPY[language];
  return ["home", "about", "services", "gallery", "contact"]
    .map((key) => {
      const target = key === "home" ? "/" : `/${key}`;
      const current = route === target || (key === "services" && route.startsWith("/services/"));
      return `<a href="${localPath(language, target)}"${current ? ' aria-current="page"' : ""}>${copy.nav[key]}</a>`;
    })
    .join("");
}

function socialLinks(site, language) {
  const copy = COPY[language];
  return [
    site.phone && `<a href="${escapeHtml(whatsappLink(site.phone))}" rel="noopener" dir="ltr">${escapeHtml(site.phone)}</a>`,
    site.instagram && `<a href="${escapeHtml(site.instagram)}" rel="noopener">${copy.instagram}</a>`,
    site.facebook && `<a href="${escapeHtml(site.facebook)}" rel="noopener">${copy.facebook}</a>`,
  ].filter(Boolean);
}

function layout({ language, route, title, description, body, site, url }) {
  const copy = COPY[language];
  const other = language === "he" ? "en" : "he";
  const fullTitle = title ? `${title} | ${copy.siteTitle}` : copy.siteTitle;
  const data = {
    "@context": "https://schema.org",
    "@type": "ProfessionalService",
    name: copy.siteTitle,
    url: ORIGIN,
    areaServed: language === "he" ? "מרכז הארץ" : "Central Israel",
    ...(site.phone ? { telephone: site.phone } : {}),
    sameAs: [site.instagram, site.facebook].filter(Boolean),
  };
  const links = socialLinks(site, language);
  const sent = route === "/contact" && url?.search;

  return `<!doctype html>
<html lang="${language}" dir="${copy.dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(fullTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${escapeHtml(fullTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${ORIGIN}${localPath(language, route)}">
  ${site.heroPhoto ? `<meta property="og:image" content="${ORIGIN}/photos/${site.heroPhoto}">` : ""}
  ${sent ? '<meta name="robots" content="noindex">' : ""}
  <link rel="canonical" href="${ORIGIN}${localPath(language, route)}">
  <link rel="alternate" hreflang="he" href="${ORIGIN}${localPath("he", route)}">
  <link rel="alternate" hreflang="en" href="${ORIGIN}${localPath("en", route)}">
  <link rel="alternate" hreflang="x-default" href="${ORIGIN}${localPath("he", route)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${FONTS}">
  <link rel="stylesheet" href="/assets/site.css">
  <script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
</head>
<body>
  <header class="site-header">
    <details class="menu">
      <summary>${copy.menu}</summary>
      <nav aria-label="${copy.menu}">${navigation(language, route)}</nav>
    </details>
    <a class="logo" href="${localPath(language, "/")}"><span>${copy.name}</span><small>${copy.craft}</small></a>
    <nav class="main-nav" aria-label="${copy.menu}">${navigation(language, route)}</nav>
    <a class="language" href="${localPath(other, route)}" lang="${other}" hreflang="${other}">${copy.otherLanguage}</a>
  </header>
  <main>${body}</main>
  <footer class="site-footer">
    <p class="footer-name">${copy.siteTitle}</p>
    ${links.length ? `<div class="footer-links">${links.join("")}</div>` : ""}
  </footer>
</body>
</html>`;
}

const bookButton = (language, className = "button") =>
  `<a class="${className}" href="${localPath(language, "/contact")}">${COPY[language].book}</a>`;

function serviceGrid(site, language) {
  return `<ul class="service-grid">${SERVICES.map((service) => {
    const cover = servicePhotos(site, service.slug)[0];
    return `<li><a href="${localPath(language, `/services/${service.slug}`)}"><span class="arch tint-${tint(service.slug)}">${
      cover ? image(cover, service[language].title, "(min-width: 900px) 25vw, 50vw") : ""
    }</span><span class="service-name">${service[language].name}</span></a></li>`;
  }).join("")}</ul>`;
}

function homePage(site, language, url) {
  const copy = COPY[language];
  const hero = site.heroPhoto
    ? image(site.heroPhoto, copy.photoAlt, "100vw", { eager: true, className: "hero-photo" })
    : "";
  const portrait = site.portraitPhoto ?? allPhotos(site)[0];
  return layout({
    language,
    route: "/",
    url,
    site,
    description: copy.description,
    body: `
    <section class="hero${site.heroPhoto ? " has-photo" : ""}">
      ${hero}
      <div class="hero-text">
        <p>${escapeHtml(textFor(site, language, "heroTagline"))}</p>
        <h1>${escapeHtml(textFor(site, language, "heroTitle"))}</h1>
        ${bookButton(language, "button button-light")}
      </div>
    </section>
    <section class="intro">
      <div class="arch tint-sage">${portrait ? image(portrait, copy.portraitAlt, "(min-width: 800px) 40vw, 90vw") : ""}</div>
      <div class="prose">
        <h2>${copy.meetTitle}</h2>
        ${paragraphs(textFor(site, language, "intro"))}
        <a class="text-link" href="${localPath(language, "/about")}">${copy.moreAbout}</a>
      </div>
    </section>
    <section class="services-band">
      <h2>${copy.servicesTitle}</h2>
      ${serviceGrid(site, language)}
    </section>
    ${instagramBand(site, language)}`,
  });
}

function instagramBand(site, language) {
  if (!site.instagram) return "";
  const copy = COPY[language];
  return `<section class="follow tint-blush"><h2>${copy.followTitle}</h2><a class="button" href="${escapeHtml(site.instagram)}" rel="noopener">${copy.instagram}</a></section>`;
}

function aboutPage(site, language, url) {
  const copy = COPY[language];
  return layout({
    language,
    route: "/about",
    url,
    site,
    title: copy.nav.about,
    description: copy.description,
    body: `
    <section class="about">
      <div class="arch tint-blush">${site.portraitPhoto ? image(site.portraitPhoto, copy.portraitAlt, "(min-width: 800px) 40vw, 90vw", { eager: true }) : ""}</div>
      <div class="prose">
        <h1>${copy.meetTitle}</h1>
        ${paragraphs(textFor(site, language, "about"))}
        ${bookButton(language)}
      </div>
    </section>
    ${instagramBand(site, language)}`,
  });
}

function servicesPage(site, language, url) {
  const copy = COPY[language];
  return layout({
    language,
    route: "/services",
    url,
    site,
    title: copy.nav.services,
    description: copy.description,
    body: `
    <section class="page-head"><h1>${copy.servicesTitle}</h1><p>${copy.servicesIntro}</p></section>
    <section class="service-list">${SERVICES.map((service) => {
      const cover = servicePhotos(site, service.slug)[0];
      return `<article>
        <div class="arch tint-${tint(service.slug)}">${cover ? image(cover, service[language].title, "(min-width: 800px) 40vw, 90vw") : ""}</div>
        <div class="prose">
          <h2><a href="${localPath(language, `/services/${service.slug}`)}">${service[language].name}</a></h2>
          ${paragraphs(serviceText(site, language, service))}
        </div>
      </article>`;
    }).join("")}</section>`,
  });
}

function gallery(ids, alt) {
  return `<div class="gallery">${ids
    .map((id) => `<a href="/photos/${id}">${image(id, alt, "(min-width: 900px) 33vw, 50vw")}</a>`)
    .join("")}</div>`;
}

function servicePage(site, language, service, url) {
  const copy = COPY[language];
  const text = serviceText(site, language, service);
  const photos = servicePhotos(site, service.slug);
  return layout({
    language,
    route: `/services/${service.slug}`,
    url,
    site,
    title: service[language].title,
    description: text.split("\n")[0].slice(0, 160),
    body: `
    <section class="page-head tint-${tint(service.slug)}">
      <h1>${service[language].title}</h1>
      <div class="prose">${paragraphs(text)}</div>
      ${bookButton(language)}
    </section>
    <section class="gallery-section">
      ${photos.length ? gallery(photos, service[language].title) : `<p class="empty">${copy.serviceEmpty}</p>`}
      <p class="after-gallery"><a class="text-link" href="${localPath(language, "/services")}">${copy.allServices}</a></p>
    </section>`,
  });
}

function galleryPage(site, language, url) {
  const copy = COPY[language];
  const photos = allPhotos(site);
  return layout({
    language,
    route: "/gallery",
    url,
    site,
    title: copy.galleryTitle,
    description: copy.description,
    body: `
    <section class="page-head"><h1>${copy.galleryTitle}</h1></section>
    <section class="gallery-section">${photos.length ? gallery(photos, copy.photoAlt) : `<p class="empty">${copy.galleryEmpty}</p>`}</section>`,
  });
}

function contactPage(site, language, url) {
  const copy = COPY[language];
  const form = copy.form;
  const params = url.searchParams;
  const notice = params.has("sent")
    ? `<p class="notice" role="status">${form.sent}</p>`
    : { missing: form.missing, email: form.badEmail, send: form.failed }[params.get("error")]
      ? `<p class="notice notice-error" role="alert">${{ missing: form.missing, email: form.badEmail, send: form.failed }[params.get("error")]}</p>`
      : "";
  const options = SERVICES.map((service) => `<option value="${service.slug}">${service[language].name}</option>`).join("");

  return layout({
    language,
    route: "/contact",
    url,
    site,
    title: copy.contactTitle,
    description: copy.description,
    body: `
    <section class="page-head tint-sky">
      <h1>${copy.contactTitle}</h1>
      <p>${copy.contactLead}</p>
      ${site.phone ? `<a class="button" href="${escapeHtml(whatsappLink(site.phone))}" rel="noopener">${copy.whatsapp}</a>` : ""}
    </section>
    <section class="contact-form" id="form">
      <h2>${form.title}</h2>
      ${notice}
      <form method="post" action="${localPath(language, "/contact")}">
        <input type="hidden" name="started" value="${Date.now()}">
        <div class="trap" aria-hidden="true"><label>${form.honeypot}<input name="website" tabindex="-1" autocomplete="off"></label></div>
        <label>${form.name}<input name="name" required maxlength="100" autocomplete="name"></label>
        <label>${form.phone}<input name="phone" type="tel" maxlength="30" autocomplete="tel" dir="ltr"></label>
        <label>${form.email}<input name="email" type="email" maxlength="254" autocomplete="email" dir="ltr"></label>
        <p class="hint">${form.hint}</p>
        <label>${form.service}<select name="service"><option value="">${form.anyService}</option>${options}</select></label>
        <label>${form.message}<textarea name="message" required rows="5" maxlength="3000"></textarea></label>
        <button class="button" type="submit">${form.send}</button>
      </form>
    </section>`,
  });
}

export function renderPage({ route, language, url, site }) {
  if (route === "/") return { status: 200, html: homePage(site, language, url) };
  if (route === "/about") return { status: 200, html: aboutPage(site, language, url) };
  if (route === "/services") return { status: 200, html: servicesPage(site, language, url) };
  if (route === "/gallery") return { status: 200, html: galleryPage(site, language, url) };
  if (route === "/contact") return { status: 200, html: contactPage(site, language, url) };

  const service = SERVICES.find((item) => route === `/services/${item.slug}`);
  if (service) return { status: 200, html: servicePage(site, language, service, url) };

  const copy = COPY[language];
  return {
    status: 404,
    html: layout({
      language,
      route: "/",
      url,
      site,
      title: copy.notFoundTitle,
      description: copy.notFoundTitle,
      body: `<section class="page-head"><h1>${copy.notFoundTitle}</h1><p>${copy.notFoundBody}</p><a class="button" href="${localPath(language, "/")}">${copy.backHome}</a></section>`,
    }),
  };
}

export function renderSitemap() {
  const routes = ["/", "/about", "/services", "/gallery", "/contact", ...SERVICES.map((service) => `/services/${service.slug}`)];
  const urls = routes.flatMap((route) => ["he", "en"].map((language) => `<url><loc>${ORIGIN}${localPath(language, route)}</loc></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`;
}
