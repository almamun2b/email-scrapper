import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

export interface Found {
  email: string;
  name: string | null; // person name if confidently tied to the email
}

const EMAIL_RE = /[a-z0-9._%+'’-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}/gi;

const BAD_TLD_SUFFIX =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|json|woff2?|ttf|eot|otf|mp4|mp3|pdf|php|html?|aspx?)$/i;

const JUNK_DOMAINS =
  /(^|\.)(example\.(com|org|net)|domain\.(com|co\.nz)|yourdomain\.[a-z.]+|email\.com|test\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|wix\.com|godaddy\.com|sentry\.wixpress\.com|mysite\.com|yoursite\.com|website\.com|company\.com|placeholder\.com|schema\.org|w3\.org|localhost)$/i;

const JUNK_LOCAL =
  /^(email|your-?email|your-?name|name|yourname|user(name)?|first\.?last|firstname\.?lastname|someone|john\.?doe|jane\.?doe|test|example|sample|noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|xxx+|abc|foo|bar)$/i;

const GENERIC_LOCAL = new Set([
  'info', 'admin', 'administrator', 'reception', 'receptionist', 'contact', 'contactus', 'enquiries', 'enquiry',
  'inquiries', 'inquiry', 'hello', 'hi', 'office', 'accounts', 'account', 'bookings', 'booking', 'appointments',
  'appointment', 'practice', 'manager', 'team', 'support', 'clinic', 'vets', 'vet', 'dental', 'dentist', 'sales',
  'mail', 'general', 'help', 'service', 'services', 'feedback', 'billing', 'finance', 'hr', 'careers', 'jobs',
  'recruitment', 'marketing', 'media', 'communications', 'comms', 'privacy', 'complaints', 'referrals', 'referral',
  'orthodontics', 'reservations', 'frontdesk', 'front.desk', 'reception1', 'nurse', 'nurses', 'doctors', 'doctor',
  'health', 'care', 'welcome', 'web', 'webmaster', 'website', 'enquire', 'queries', 'newsletter', 'news', 'patient',
  'patients', 'customerservice', 'customer.service', 'clinicmanager', 'practicemanager', 'ops', 'operations',
]);

export function isGenericLocal(local: string): boolean {
  const l = local.toLowerCase().replace(/[._-]/g, '');
  return GENERIC_LOCAL.has(local.toLowerCase()) || GENERIC_LOCAL.has(l);
}

const GTLDS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro', 'mobi', 'health', 'clinic', 'dental',
  'dentist', 'vet', 'kiwi', 'app', 'dev', 'online', 'site', 'xyz', 'store', 'shop', 'tech', 'cloud', 'email', 'team',
  'care', 'life', 'live', 'world', 'today', 'group', 'center', 'centre', 'company', 'services', 'solutions', 'network',
  'agency', 'digital', 'studio', 'space', 'website', 'medical', 'doctor', 'pet', 'pets', 'community', 'foundation',
  'nz', 'co', 'ac', 'gov', 'city', 'works', 'expert', 'guru', 'ninja', 'academy', 'education', 'institute', 'school',
  'fitness', 'wellness', 'surgery', 'hospital', 'pharmacy', 'photography', 'design', 'nyc', 'london', 'club', 'one',
  'link', 'page', 'me', 'ltd', 'inc', 'llc', 'partners', 'ventures', 'holdings', 'associates', 'consulting', 'zone',
]);

function validTld(domain: string): boolean {
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return tld.length === 2 || GTLDS.has(tld);
}

export function cleanEmail(raw: string): string | null {
  let e = raw.trim().toLowerCase().replace(/’/g, "'");
  try {
    e = decodeURIComponent(e);
  } catch { /* keep */ }
  e = e.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
  // "u003e" style JSON escape prefixes
  e = e.replace(/^(u003[ce]|x3[ce])/, '');
  const m = e.match(/^([a-z0-9._%+'-]+)@((?:[a-z0-9-]+\.)+[a-z]{2,24})$/);
  if (!m) return null;
  const [, local, domain] = m;
  if (local.length > 64 || domain.length > 100) return null;
  if (BAD_TLD_SUFFIX.test(domain) || !validTld(domain)) return null;
  if (/^\d+x$|@\dx\./.test(e) || /@\d+x\./.test(e)) return null; // logo@2x.png
  if (JUNK_DOMAINS.test(domain)) return null;
  if (JUNK_LOCAL.test(local)) return null;
  if (/^[0-9a-f]{24,}$/.test(local)) return null; // hash-like
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(local)) return null; // uuid
  if (domain.split('.').some((p) => p.length > 40)) return null;
  return `${local}@${domain}`;
}

function decodeCfEmail(hex: string): string | null {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch {
    return null;
  }
}

function deobfuscate(text: string): string {
  return text
    .replace(/\s*[\[\(\{<]\s*at\s*[\]\)\}>]\s*/gi, '@')
    .replace(/\s*[\[\(\{<]\s*dot\s*[\]\)\}>]\s*/gi, '.')
    .replace(/\s+(?:at)\s+(?=[a-z0-9-]+\s+(?:dot)\s+[a-z]{2,})/gi, '@')
    .replace(/(?<=@[a-z0-9-]+(?:\.[a-z0-9-]+)*)\s+dot\s+(?=[a-z]{2,})/gi, '.')
    .replace(/(?<=@[a-z0-9-]+(?:\.[a-z0-9-]+)*)\s+dot\s+(?=[a-z]{2,})/gi, '.')
    .replace(/(?<=@[a-z0-9-]+(?:\.[a-z0-9-]+)*)\s+dot\s+(?=[a-z]{2,})/gi, '.')
    .replace(/&#0*64;|&commat;|&#x0*40;/gi, '@')
    .replace(/&#0*46;|&period;|&#x0*2e;/gi, '.');
}

const TITLE_RE = /^(dr|mr|mrs|ms|miss|prof|professor|assoc\.? prof|a\/prof|sir|dame)\.?\s+/i;
const NAME_WORD = /^[A-Z][a-zA-Z'’-]+\.?$/;
const NOT_NAME_WORDS = new Set([
  'contact', 'email', 'phone', 'call', 'us', 'our', 'the', 'and', 'send', 'message', 'enquiries', 'enquiry', 'info',
  'click', 'here', 'to', 'for', 'more', 'read', 'get', 'in', 'touch', 'dental', 'clinic', 'centre', 'center', 'practice',
  'vet', 'vets', 'veterinary', 'hospital', 'health', 'medical', 'team', 'reception', 'book', 'now', 'online',
  'appointment', 'appointments', 'general', 'address', 'location', 'hours', 'opening', 'home', 'about', 'services',
  'staff', 'careers', 'jobs', 'join', 'mail', 'us:', 'e:', 'email:', 'office', 'manager', 'nurse', 'dentist',
  'doctor', 'doctors', 'director', 'owner', 'founder', 'receptionist', 'assistant', 'hygienist', 'therapist',
  'orthodontist', 'surgeon', 'specialist', 'consultant', 'partners', 'limited', 'ltd', 'nz', 'new', 'zealand',
  'privacy', 'policy', 'terms', 'website', 'web', 'enquire', 'ask', 'question', 'questions', 'feedback', 'please',
  'complaints', 'complaint', 'support', 'help', 'referrals', 'referral', 'accounts', 'billing', 'admin', 'sales',
]);

/** Returns a tidy person name if the text looks like one, else null. */
export function personName(text: string | undefined | null): string | null {
  if (!text) return null;
  let t = text.replace(/\s+/g, ' ').trim().replace(/[,:;|–—-]+$/, '').trim();
  if (t.length < 4 || t.length > 50) return null;
  if (/[@\d\/\\()+]/.test(t)) return null;
  const hadTitle = TITLE_RE.test(t);
  const body = t.replace(TITLE_RE, '');
  const words = body.split(' ').filter(Boolean);
  if (words.length < (hadTitle ? 1 : 2) || words.length > 4) return null;
  if (!words.every((w) => NAME_WORD.test(w))) return null;
  if (words.some((w) => NOT_NAME_WORDS.has(w.toLowerCase().replace(/[.:]$/, '')))) return null;
  return t;
}

const LOCAL_STOP = /(group|team|line|desk|admin|office|centre|center|health|clinic|dental|vets?|care|region|regional|enrol|enquir|inquir|service|support|screen|feedback|analytic|network|committee|research|study|trust|unit|hub|ops|helpdesk|coding|billing|payroll|data|public|national|northern|southern|central|eastern|western|midland|canterbury|waikato|auckland|otago|wellington|hawkes|taranaki|southland|nelson|marlborough|volunteer|recruit|career|media|news)/i;

export function nameFromLocal(local: string): string | null {
  if (isGenericLocal(local)) return null;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^[a-z']{3,12}$/.test(p) && /[aeiouy]/.test(p))) return null;
  if (parts.some((p) => GENERIC_LOCAL.has(p) || NOT_NAME_WORDS.has(p) || LOCAL_STOP.test(p))) return null;
  return parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
}

/** A scraped heading/link text only counts as a person if it is consistent with the email or carries a title. */
function consistentPerson(name: string | null, email: string): string | null {
  if (!name) return null;
  const local = email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const words = name.replace(TITLE_RE, '').toLowerCase().split(' ').filter((w) => w.length >= 3);
  const first = words[0], last = words[words.length - 1];
  const initialLast = words.length >= 2 ? words[0][0] + last : '';
  if (words.some((w) => local.includes(w.replace(/[^a-z]/g, ''))) || (initialLast && local.includes(initialLast))) return name;
  if (words.length && first && local.startsWith(first[0]) && local.includes(last)) return name;
  if (TITLE_RE.test(name) && !isGenericLocal(email.split('@')[0])) return name;
  return null;
}

// ---------- business name ----------

export function businessName(html: string, host: string): string {
  const $ = cheerio.load(html);
  const candidates: string[] = [];

  // JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text().trim() || 'null');
      const stack: any[] = [data];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n)) { stack.push(...n); continue; }
        const type = ([] as string[]).concat(n['@type'] ?? []).join(' ');
        if (/Organization|LocalBusiness|Dentist|Medical|Veterinar|Hospital|Physician|Clinic|WebSite/i.test(type) && typeof n.name === 'string') {
          candidates.push(n.name);
        }
        for (const v of Object.values(n)) if (v && typeof v === 'object') stack.push(v);
      }
    } catch { /* ignore */ }
  });
  const og = $('meta[property="og:site_name"]').attr('content');
  if (og) candidates.push(og);
  const app = $('meta[name="application-name"]').attr('content');
  if (app) candidates.push(app);

  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const c of candidates) {
    const v = clean(c);
    if (v.length >= 2 && v.length <= 80) return v;
  }

  const title = clean($('title').first().text());
  if (title) {
    const segs = title.split(/\s+[|–—•·:]\s+|\s+-\s+|\s*\|\s*/).map(clean).filter(Boolean);
    const domainKey = baseKey(host);
    const match = segs.find((s) => baseKey(s).includes(domainKey) || domainKey.includes(baseKey(s)));
    const generic = /^(home|welcome|homepage|contact|about)/i;
    const pick = match ?? segs.filter((s) => !generic.test(s)).sort((a, b) => a.length - b.length)[0] ?? segs[0];
    if (pick && pick.length <= 80) return pick;
  }
  return host.replace(/^www\./, '');
}

function baseKey(s: string): string {
  return s.toLowerCase().replace(/^www\./, '').replace(/\.(co\.nz|org\.nz|net\.nz|com\.au|co\.uk|com|nz|org|net|health\.nz|govt\.nz)$/g, '').replace(/[^a-z0-9]/g, '');
}

// ---------- email extraction ----------

const NAME_SELECTORS = 'h1,h2,h3,h4,h5,h6,strong,b,.name,[class*="name"],[class*="title"],[itemprop="name"],figcaption';

function nearbyName($: CheerioAPI, el: any, email: string): string | null {
  const local = email.split('@')[0];
  let node = $(el);
  for (let depth = 0; depth < 3; depth++) {
    const parent = node.parent();
    if (!parent.length) break;
    node = parent;
    // A container holding several different emails is not a single person's card.
    const cardText = node.text();
    const emailsInCard = new Set((cardText.match(EMAIL_RE) ?? []).map((m) => m.toLowerCase()));
    const mailtos = new Set(
      node.find('a[href^="mailto:" i]').map((_, a) => ($(a).attr('href') ?? '').slice(7).split('?')[0].toLowerCase()).get(),
    );
    if (emailsInCard.size > 1 || mailtos.size > 1) return null;
    const hits: string[] = [];
    node.find(NAME_SELECTORS).each((_, h) => {
      const n = personName($(h).clone().children('a[href^="mailto:" i]').remove().end().text());
      if (n) hits.push(n);
    });
    if (hits.length) return hits[0];
    // name directly before the email in the same text block ("Dr Jane Smith – jane@x.nz")
    const before = cardText.split(email)[0]?.trim().split(/\n/).map((s) => s.trim()).filter(Boolean).pop();
    const n2 = personName(before);
    if (n2 && !isGenericLocal(local)) return n2;
  }
  return null;
}

export function extractFromHtml(html: string): Found[] {
  const found = new Map<string, string | null>();
  const add = (raw: string, name: string | null) => {
    const email = cleanEmail(raw);
    if (!email) return;
    const prev = found.get(email);
    if (prev === undefined || (prev === null && name)) found.set(email, name);
  };

  const $ = cheerio.load(html);

  // 1. schema.org / JSON-LD emails with names
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text().trim() || 'null');
      const stack: any[] = [data];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n)) { stack.push(...n); continue; }
        if (typeof n.email === 'string') {
          const type = ([] as string[]).concat(n['@type'] ?? []).join(' ');
          const nm = /Person|Physician|Dentist/i.test(type) ? personName(n.name) : null;
          add(n.email.replace(/^mailto:/i, ''), nm);
        }
        for (const v of Object.values(n)) if (v && typeof v === 'object') stack.push(v);
      }
    } catch { /* ignore */ }
  });
  $('[itemtype*="schema.org/Person" i]').each((_, el) => {
    const em = $(el).find('[itemprop="email"]').first();
    const raw = em.attr('content') || em.attr('href')?.replace(/^mailto:/i, '') || em.text();
    const nm = personName($(el).find('[itemprop="name"]').first().text());
    if (raw) add(raw, nm);
  });

  // 2. mailto: links
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim();
    if (/^mailto:/i.test(href)) {
      const list = href.slice(7).split('?')[0];
      let decoded = list;
      try { decoded = decodeURIComponent(list); } catch { /* keep */ }
      const parts = decoded.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        const email = cleanEmail(p);
        if (!email) continue;
        let name: string | null = consistentPerson(personName($(a).text()), email);
        if (!name && parts.length === 1) name = consistentPerson(nearbyName($, a, email), email);
        add(email, name);
      }
    } else if (/cdn-cgi\/l\/email-protection#/i.test(href)) {
      const hex = href.split('#')[1];
      const dec = hex && decodeCfEmail(hex);
      if (dec) add(dec, consistentPerson(nearbyName($, a, dec.toLowerCase()), dec.toLowerCase()));
    }
  });

  // 3. Cloudflare data-cfemail
  $('[data-cfemail]').each((_, el) => {
    const dec = decodeCfEmail($(el).attr('data-cfemail') ?? '');
    if (dec) add(dec, consistentPerson(nearbyName($, el, dec.toLowerCase()), dec.toLowerCase()));
  });

  // 4. data-attributes commonly used to hide emails
  $('[data-email],[data-mail]').each((_, el) => {
    const v = $(el).attr('data-email') ?? $(el).attr('data-mail');
    if (v) add(v.replace(/^mailto:/i, ''), null);
  });

  // 5. Regex over visible text (with deobfuscation) and raw HTML
  $('script:not([type="application/ld+json"]),style,noscript').remove();
  const spaced = ($.root().html() ?? '').replace(/<\/?[a-z][^>]*>/gi, ' ');
  const text = deobfuscate(cheerio.load(`<body>${spaced}</body>`).text());
  for (const m of text.matchAll(EMAIL_RE)) {
    const email = cleanEmail(m[0]);
    if (!email) continue;
    if (!found.has(email)) {
      // try to find an element that holds this email for name context
      let name: string | null = null;
      const holder = $(`*:contains("${email.replace(/"/g, '')}")`).last();
      if (holder.length) name = consistentPerson(nearbyName($, holder.get(0), email), email);
      add(email, name);
    }
  }
  const raw = deobfuscate(html);
  for (const m of raw.matchAll(EMAIL_RE)) add(m[0], found.has(cleanEmail(m[0]) ?? '') ? found.get(cleanEmail(m[0])!) ?? null : null);

  // derive person name from local part when nothing better was found
  const out: Found[] = [];
  for (const [email, name] of found) {
    out.push({ email, name: name ?? nameFromLocal(email.split('@')[0]) });
  }
  return out;
}

/** Looks like a JS-rendered shell with little real content. */
export function looksJsRendered(html: string): boolean {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const textLen = $('body').text().replace(/\s+/g, ' ').trim().length;
  if (textLen < 200) return true;
  return false;
}
