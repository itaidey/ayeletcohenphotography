import { COPY, SERVICES } from "./content.js";

const ORIGIN = "https://ayeletcohenphotography.com";
const FONTS = "https://fonts.googleapis.com/css2?family=Assistant:wght@300;400;600&family=Bellefair&display=swap";
const TINTS = ["blush", "sage", "sky", "lilac", "butter"];

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
  const quickBar = route === "/contact" ? "" : `<nav class="quick-bar" aria-label="${copy.book}">${
    site.phone ? `<a href="${escapeHtml(whatsappLink(site.phone))}" rel="noopener">${copy.whatsappShort}</a>` : ""
  }${bookButton(language)}</nav>`;

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
  ${quickBar}
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
    return `<li><a class="mat-card tint-${tint(service.slug)}" href="${localPath(language, `/services/${service.slug}`)}"><span class="print">${
      cover ? image(cover, service[language].title, "(min-width: 800px) 25vw, 74vw") : ""
    }</span><span class="service-name">${service[language].name}</span></a></li>`;
  }).join("")}</ul>`;
}

function homePage(site, language, url) {
  const copy = COPY[language];
  const portrait = site.portraitPhoto ?? allPhotos(site)[0];
  return layout({
    language,
    route: "/",
    url,
    site,
    description: copy.description,
    body: `
    <section class="hero">
      <div class="hero-print">${site.heroPhoto ? image(site.heroPhoto, copy.photoAlt, "100vw", { eager: true }) : ""}</div>
      <div class="hero-label">
        <h1>${escapeHtml(textFor(site, language, "heroTitle"))}</h1>
        <p>${escapeHtml(textFor(site, language, "heroTagline"))}</p>
        ${bookButton(language)}
      </div>
    </section>
    <section class="intro">
      <div class="mat tint-sage"><span class="print">${portrait ? image(portrait, copy.portraitAlt, "(min-width: 800px) 40vw, 90vw") : ""}</span></div>
      <div class="prose">
        <h2>${copy.meetTitle}</h2>
        ${paragraphs(textFor(site, language, "intro"))}
        <a class="text-link" href="${localPath(language, "/about")}">${copy.moreAbout}</a>
      </div>
    </section>
    <section class="services-band">
      <h2>${copy.servicesTitle}</h2>
      <p>${copy.servicesIntro}</p>
      ${serviceGrid(site, language)}
    </section>`,
  });
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
      <div class="mat tint-blush"><span class="print">${site.portraitPhoto ? image(site.portraitPhoto, copy.portraitAlt, "(min-width: 800px) 40vw, 90vw", { eager: true }) : ""}</span></div>
      <div class="prose">
        <h1>${copy.meetTitle}</h1>
        ${paragraphs(textFor(site, language, "about"))}
        ${bookButton(language)}
      </div>
    </section>`,
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
        <a class="mat tint-${tint(service.slug)}" href="${localPath(language, `/services/${service.slug}`)}" tabindex="-1" aria-hidden="true"><span class="print">${cover ? image(cover, service[language].title, "(min-width: 800px) 45vw, 90vw") : ""}</span></a>
        <div class="prose">
          <h2><a href="${localPath(language, `/services/${service.slug}`)}">${service[language].name}</a></h2>
          ${paragraphs(serviceText(site, language, service))}
          <a class="text-link" href="${localPath(language, `/services/${service.slug}`)}">${copy.seeMore}</a>
        </div>
      </article>`;
    }).join("")}</section>`,
  });
}

function gallery(ids, alt) {
  const size = ids.length === 1 ? " gallery-single" : ids.length === 2 ? " gallery-pair" : "";
  return `<div class="gallery${size}">${ids
    .map((id) => `<a href="/photos/${id}">${image(id, alt, "(min-width: 900px) 33vw, 50vw")}</a>`)
    .join("")}</div>`;
}

function servicePage(site, language, service, url) {
  const copy = COPY[language];
  const text = serviceText(site, language, service);
  const [cover, ...photos] = servicePhotos(site, service.slug);
  return layout({
    language,
    route: `/services/${service.slug}`,
    url,
    site,
    title: service[language].title,
    description: text.split("\n")[0].slice(0, 160),
    body: `
    <section class="service-head tint-${tint(service.slug)}">
      <div class="service-cover">${cover ? image(cover, service[language].title, "(min-width: 800px) 58vw, 100vw", { eager: true }) : ""}</div>
      <div class="prose">
        <h1>${service[language].title}</h1>
        ${paragraphs(text)}
        ${bookButton(language)}
      </div>
    </section>
    <section class="gallery-section">
      ${photos.length ? gallery(photos, service[language].title) : cover ? "" : `<p class="empty">${copy.serviceEmpty}</p>`}
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

function contactPage(site, language, url, canEmail) {
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
    <div class="contact-layout">
    <section class="contact-lead tint-sky">
      <h1>${copy.contactTitle}</h1>
      <p>${copy.contactLead}</p>
      ${site.phone ? `<a class="button" href="${escapeHtml(whatsappLink(site.phone))}" rel="noopener">${copy.whatsapp}</a>` : ""}
    </section>
    ${canEmail ? `<section class="contact-form" id="form">
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
    </section>` : ""}
    </div>`,
  });
}

export function renderPage({ route, language, url, site, canEmail }) {
  if (route === "/") return { status: 200, html: homePage(site, language, url) };
  if (route === "/about") return { status: 200, html: aboutPage(site, language, url) };
  if (route === "/services") return { status: 200, html: servicesPage(site, language, url) };
  if (route === "/gallery") return { status: 200, html: galleryPage(site, language, url) };
  if (route === "/contact") return { status: 200, html: contactPage(site, language, url, canEmail) };

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
