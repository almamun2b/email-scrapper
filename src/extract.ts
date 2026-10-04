import fs from 'node:fs';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { parse as parseDomain } from 'tldts';

/** Where an email was found, roughly most to least reliable. Emails seen only in raw HTML are often junk. */
export type EmailSource = 'jsonld' | 'microdata' | 'mailto' | 'cfemail' | 'data-attr' | 'text' | 'raw';

export interface Found {
  email: string;
  name: string | null; // person name if confidently tied to the email
  source?: EmailSource; // optional: older cache lines lack it
  nameFrom?: 'page' | 'local'; // the name came from the page, or from the email's local part
}

const LOCAL_CHAR = /[a-z0-9._%+'’-]/i;
const LOCAL_TAIL = /[a-z0-9._%+'’-]{1,64}$/i;
const DOMAIN_AT = /@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,10}[a-z]{2,24})/iy;

/**
 * Raw email-like strings in text, in order. Anchored on each "@" with bounded parts, so it is linear
 * in the text length: an unanchored /[...]+@/ is quadratic on long runs without an "@".
 */
export function findEmails(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at < from) continue;
    const start = Math.max(from, at - 64);
    const local = LOCAL_TAIL.exec(text.slice(start, at))?.[0];
    if (!local) continue;
    const localStart = at - local.length;
    if (localStart > from && LOCAL_CHAR.test(text[localStart - 1])) continue; // local part longer than 64
    DOMAIN_AT.lastIndex = at;
    const m = DOMAIN_AT.exec(text);
    if (!m) continue;
    // a JSON/JS string escape right before the address ("\ndavid@…") is not part of it
    out.push((text[localStart - 1] === '\\' && /^[nrtfbv]/.test(local) ? local.slice(1) : local) + m[0]);
    from = at + m[0].length;
  }
  return out;
}

const BAD_TLD_SUFFIX =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|json|woff2?|ttf|eot|otf|mp4|mp3|pdf|php|html?|aspx?)$/i;

const JUNK_DOMAINS =
  /(^|\.)(example\.(com|org|net)|domain\.(com|co\.nz)|yourdomain\.[a-z.]+|test\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|wix\.com|godaddy\.com|sentry\.wixpress\.com|mysite\.com|yoursite\.com|website\.com|company\.com|placeholder\.com|schema\.org|w3\.org|localhost)$/i;

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

/** A real, registrable domain under an ICANN suffix (so ".nh", ".ay" or "logo.png" don't pass). */
function validDomain(domain: string): boolean {
  const d = parseDomain(domain, { allowPrivateDomains: false });
  return d.isIcann === true && !!d.domain;
}

const rot13 = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));

// ROT13 is only trusted when it turns an invalid domain into one under a common suffix,
// so random junk with a bad TLD isn't "decoded" into a plausible-looking address.
const ROT13_SUFFIX = /^(com|net|org|edu|gov|info|biz|ca|us|ie|(?:[a-z]+\.)?(nz|au|uk))$/;

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
  let [, local, domain] = m;
  if (local.length > 64 || domain.length > 100) return null;
  if (BAD_TLD_SUFFIX.test(domain)) return null; // logo@2x.png
  // Some sites scramble addresses with ROT13 ("vasb@rknzcyr.pbz.nh" is info@example.com.au). ".nz" scrambles
  // to ".am", a real TLD, so "x.pb.am" (co.nz) is also decoded when it unscrambles to a two-part suffix.
  const valid = validDomain(domain);
  if (!valid || /\.(am|pn)$/.test(domain)) {
    const d = rot13(domain);
    const suffix = parseDomain(d).publicSuffix ?? '';
    if (validDomain(d) && ROT13_SUFFIX.test(suffix) && (!valid || suffix.includes('.'))) {
      local = rot13(local);
      domain = d;
    } else if (!valid) {
      return null;
    }
  }
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

// Whitespace is collapsed first and every pattern starts with a literal, so these stay linear on
// long whitespace or letter runs (a leading \s* or lookbehind is tried at every position).
const DOT_IN_DOMAIN = / dot (?<=@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8} dot )(?=[a-z]{2,})/gi;

function deobfuscate(text: string): string {
  let t = text
    .replace(/\s+/g, ' ')
    .replace(/ ?[\[\(\{<] ?at ?[\]\)\}>] ?/gi, '@')
    .replace(/ ?[\[\(\{<] ?dot ?[\]\)\}>] ?/gi, '.')
    .replace(/ at (?=[a-z0-9-]{1,63} dot [a-z]{2,})/gi, '@');
  // one " dot " per domain label per pass
  for (let i = 0, prev = ''; i < 8 && prev !== t; i++) {
    prev = t;
    t = t.replace(DOT_IN_DOMAIN, '.');
  }
  return t
    .replace(/&#0*64;|&commat;|&#x0*40;/gi, '@')
    .replace(/&#0*46;|&period;|&#x0*2e;/gi, '.');
}

const TITLE_RE = /^(dr|mr|mrs|ms|miss|prof|professor|assoc\.? prof|a\/prof|sir|dame)\.?\s+/i;
const NAME_WORD = /^\p{Lu}[\p{L}'’-]+\.?$/u; // Unicode, so Māori macrons and accents pass
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

// Matched against whole local-part pieces (a substring test rejected "caroline" for containing "line").
const LOCAL_STOP = /^(group|team|line|desk|admin|office|centre|center|health|clinic|dental|vets?|care|region|regional|enrol\w*|enquir\w*|inquir\w*|service|support|screen\w*|feedback|analytic\w*|network|committee|research\w*|study|trust|unit|hub|ops|helpdesk|coding|billing|payroll|data|public|national|northern|southern|central|eastern|western|midland|canterbury|waikato|auckland|otago|wellington|hawkes|taranaki|southland|nelson|marlborough|volunteer\w*|recruit\w*|career\w*|media|news)s?$/i;

/**
 * Department, role and business vocabulary. A local part using any of these isn't a person, and a scraped
 * "name" made only of them ("Customer Care", "Parts Department") isn't either.
 */
const DEPT_WORDS = new Set([
  ...GENERIC_LOCAL, ...NOT_NAME_WORDS,
  'parts', 'part', 'cars', 'car', 'customer', 'customers', 'relations', 'experience', 'trade', 'res', 'events', 'event',
  'travel', 'press', 'fleet', 'store', 'yard', 'shop', 'department', 'dept', 'room', 'print', 'body', 'spare',
  'used', 'demo', 'insurance', 'leasing', 'lease', 'rental', 'rentals', 'hire', 'tours', 'tour', 'tickets', 'ticket',
  'groups', 'functions', 'weddings', 'wedding', 'conference', 'conferences', 'membership', 'members', 'member',
  'payable', 'receivable', 'legal', 'compliance', 'quality', 'safety', 'security', 'ict', 'digital', 'social',
  'content', 'design', 'studio', 'gallery', 'museum', 'library', 'school', 'faculty', 'college', 'university',
  'campus', 'medicine', 'nursing', 'pharmacy', 'radiology', 'pathology', 'laboratory', 'lab', 'theatre',
  'emergency', 'maternity', 'mental', 'oral', 'community', 'family', 'youth', 'kids', 'children', 'aged', 'seniors',
  'residents', 'guest', 'guests', 'concierge', 'resort', 'hotel', 'motel', 'spa', 'cafe', 'restaurant',
  'kitchen', 'bar', 'venue', 'club', 'society', 'association', 'council', 'board', 'chair', 'president',
  'secretary', 'treasurer', 'ceo', 'cfo', 'coo', 'executive', 'logistics', 'warehouse', 'dispatch', 'delivery',
  'orders', 'order', 'purchasing', 'procurement', 'supply', 'wholesale', 'retail', 'export', 'import', 'product',
  'products', 'sponsorship', 'partnerships', 'partner', 'investor', 'investors', 'experiences', 'care', 'relationship',
  'rec', 'anz', 'aunz', 'au', 'private', 'helpline', 'hotline', 'franchise', 'principal', 'coordinator', 'assessment', 'request', 'requests',
  'studies', 'technologies', 'packaging', 'testing', 'programmes', 'programs', 'authorities', 'visa', 'residences',
]);

const GIVEN_NAMES = new Set(
  fs.readFileSync(new URL('./data/given-names.txt', import.meta.url), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean),
);

const titleCase = (parts: string[]) => parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
const localParts = (local: string) => local.split(/[._-]+/).filter(Boolean);

/** "jane.smith" → "Jane Smith", only when the first part is a known given name and nothing reads as a department. */
export function nameFromLocal(local: string): string | null {
  if (isGenericLocal(local)) return null;
  const parts = localParts(local);
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^[a-z']{3,12}$/.test(p) && /[aeiouy]/.test(p))) return null;
  if (!GIVEN_NAMES.has(parts[0])) return null;
  if (parts.some((p) => DEPT_WORDS.has(p) || LOCAL_STOP.test(p))) return null;
  return titleCase(parts);
}

/** Lowercase ASCII letters of a name word, accents and macrons folded ("Tāne" → "tane"). */
const fold = (w: string) => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');

const allDeptWords = (name: string) => {
  const words = name.replace(TITLE_RE, '').split(' ').map(fold).filter(Boolean);
  return words.length > 0 && words.every((w) => DEPT_WORDS.has(w));
};

/**
 * A scraped heading/link text only counts as a person if it is consistent with the email or carries a title.
 * Compares whole tokens of the local part, never substrings ("care" in "gmsvcare" is not a match).
 */
function consistentPerson(name: string | null, email: string): string | null {
  if (!name || allDeptWords(name)) return null;
  const local = email.split('@')[0].toLowerCase();
  const tokens = local.split(/[^a-z]+/).filter(Boolean);
  const words = name.replace(TITLE_RE, '').split(' ').map(fold).filter(Boolean);
  if (words.some((w) => w.length >= 3 && tokens.includes(w))) return name;
  if (words.length >= 2) {
    const first = words[0], last = words[words.length - 1];
    const forms = new Set([first + last, first[0] + last, first + last[0], last + first, last + first[0]]);
    if ([...tokens, tokens.join('')].some((t) => forms.has(t))) return name;
  }
  if (TITLE_RE.test(name) && !isGenericLocal(email.split('@')[0])) return name;
  return null;
}

// ---------- JSON-LD ----------

/** Visits every object in the page's JSON-LD blocks (nested graphs and arrays included). */
function walkJsonLd($: CheerioAPI, visit: (node: any) => void): void {
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const stack: any[] = [JSON.parse($(el).contents().text().trim() || 'null')];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n)) { stack.push(...n); continue; }
        visit(n);
        for (const v of Object.values(n)) if (v && typeof v === 'object') stack.push(v);
      }
    } catch { /* invalid JSON-LD */ }
  });
}

const ldType = (n: any) => ([] as string[]).concat(n['@type'] ?? []).join(' ');

// ---------- business name ----------

export function businessName(html: string, host: string): string {
  const $ = cheerio.load(html);
  const candidates: string[] = [];

  walkJsonLd($, (n) => {
    if (/Organization|LocalBusiness|Dentist|Medical|Veterinar|Hospital|Physician|Clinic|WebSite/i.test(ldType(n)) && typeof n.name === 'string') {
      candidates.push(n.name);
    }
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
    // short segments ("NZ", "Home") would match almost any domain
    const match = segs.find((s) => baseKey(s).length >= 4 && (baseKey(s).includes(domainKey) || domainKey.includes(baseKey(s))));
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

/**
 * Per-extraction memo of each container's text, whether it holds more than one email, and its first
 * person-like heading. Each container is examined once however many emails sit inside it.
 */
type Card = { text: string; multi: boolean; name?: string | null };
type CardMemo = Map<any, Card>;

function cardInfo($: CheerioAPI, node: any, memo: CardMemo): Card {
  let info = memo.get(node);
  if (!info) {
    const el = $(node);
    const text = el.text();
    const emails = new Set(findEmails(text).map((m) => m.toLowerCase()));
    const mailtos = new Set(
      el.find('a[href^="mailto:" i]').map((_, a) => ($(a).attr('href') ?? '').slice(7).split('?')[0].toLowerCase()).get(),
    );
    info = { text, multi: emails.size > 1 || mailtos.size > 1 };
    memo.set(node, info);
  }
  return info;
}

function nearbyName($: CheerioAPI, el: any, email: string, memo: CardMemo): string | null {
  const local = email.split('@')[0];
  let node = $(el);
  for (let depth = 0; depth < 3; depth++) {
    const parent = node.parent();
    if (!parent.length) break;
    node = parent;
    // A container holding several different emails is not a single person's card.
    const card = cardInfo($, node.get(0), memo);
    if (card.multi) return null;
    if (card.name === undefined) {
      card.name = null;
      node.find(NAME_SELECTORS).each((_, h) => {
        card.name = personName($(h).clone().children('a[href^="mailto:" i]').remove().end().text());
        return !card.name; // stop at the first hit
      });
    }
    if (card.name) return card.name;
    // name directly before the email in the same text block ("Dr Jane Smith – jane@x.nz")
    const at = card.text.toLowerCase().indexOf(email);
    const before = (at >= 0 ? card.text.slice(0, at) : card.text).trim().split(/\n/).map((s) => s.trim()).filter(Boolean).pop();
    const n2 = personName(before);
    if (n2 && !isGenericLocal(local)) return n2;
  }
  return null;
}

/** Visits text nodes in document order with their parent element. */
function walkText(root: any, visit: (text: string, parent: any) => void): void {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'text') visit(n.data, n.parent);
    else if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
}

export function extractFromHtml(html: string): Found[] {
  return extractFromDom(cheerio.load(html), html);
}

/** Emails in a parsed page. Removes scripts and styles from `$`, so read anything else from it first. */
export function extractFromDom($: CheerioAPI, html: string): Found[] {
  const found = new Map<string, { name: string | null; source: EmailSource }>();
  const memo: CardMemo = new Map();
  const add = (raw: string, name: string | null, source: EmailSource) => {
    const email = cleanEmail(raw);
    if (!email) return;
    const prev = found.get(email);
    if (!prev) found.set(email, { name, source });
    else if (prev.name === null && name) prev.name = name;
  };

  // 1. schema.org / JSON-LD emails with names
  walkJsonLd($, (n) => {
    if (typeof n.email !== 'string') return;
    const nm = /Person|Physician|Dentist/i.test(ldType(n)) ? personName(n.name) : null;
    add(n.email.replace(/^mailto:/i, ''), nm, 'jsonld');
  });
  $('[itemtype*="schema.org/Person" i]').each((_, el) => {
    const em = $(el).find('[itemprop="email"]').first();
    const raw = em.attr('content') || em.attr('href')?.replace(/^mailto:/i, '') || em.text();
    const nm = personName($(el).find('[itemprop="name"]').first().text());
    if (raw) add(raw, nm, 'microdata');
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
        if (!name && parts.length === 1) name = consistentPerson(nearbyName($, a, email, memo), email);
        add(email, name, 'mailto');
      }
    } else if (/cdn-cgi\/l\/email-protection#/i.test(href)) {
      const hex = href.split('#')[1];
      const dec = hex && decodeCfEmail(hex);
      if (dec) add(dec, consistentPerson(nearbyName($, a, dec.toLowerCase(), memo), dec.toLowerCase()), 'cfemail');
    }
  });

  // 3. Cloudflare data-cfemail
  $('[data-cfemail]').each((_, el) => {
    const dec = decodeCfEmail($(el).attr('data-cfemail') ?? '');
    if (dec) add(dec, consistentPerson(nearbyName($, el, dec.toLowerCase(), memo), dec.toLowerCase()), 'cfemail');
  });

  // 4. data-attributes commonly used to hide emails
  $('[data-email],[data-mail]').each((_, el) => {
    const v = $(el).attr('data-email') ?? $(el).attr('data-mail');
    if (v) add(v.replace(/^mailto:/i, ''), null, 'data-attr');
  });

  // 5. Regex over visible text (with deobfuscation) and raw HTML.
  // One pass over the text nodes gives both the text and, per email, the element holding it (last occurrence).
  $('script:not([type="application/ld+json"]),style,noscript').remove();
  memo.clear(); // card texts read before the removal still contain script text
  const pieces: string[] = [];
  const holders = new Map<string, any>();
  walkText($.root().get(0), (t, parent) => {
    pieces.push(t);
    if (!t.includes('@')) return;
    for (const m of findEmails(t)) {
      const email = cleanEmail(m);
      if (email) holders.set(email, parent);
    }
  });
  for (const m of findEmails(deobfuscate(pieces.join(' ')))) {
    const email = cleanEmail(m);
    if (!email || found.has(email)) continue;
    const holder = holders.get(email);
    add(email, holder ? consistentPerson(nearbyName($, holder, email, memo), email) : null, 'text');
  }
  for (const m of findEmails(deobfuscate(html))) add(m, null, 'raw');

  // derive person name from local part when nothing better was found
  const out: Found[] = [];
  for (const [email, { name, source }] of found) {
    const fromLocal = name ? null : nameFromLocal(email.split('@')[0]);
    out.push({ email, name: name ?? fromLocal, source, ...(name ? { nameFrom: 'page' } : fromLocal ? { nameFrom: 'local' } : {}) });
  }
  return out;
}

// ---------- re-checking stored results ----------

/**
 * Whether a stored name was derived from the email's local part rather than read off the page. Rows from
 * before `nameFrom` existed are judged by shape: a name that is just the title-cased local part.
 */
function localDerived(row: Found): boolean {
  if (row.nameFrom) return row.nameFrom === 'local';
  const parts = localParts(row.email.split('@')[0]);
  // the old rule only ever produced 2–3 parts of 3–12 letters, so anything else came from the page
  const oldShape = parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^[a-z']{3,12}$/.test(p) && /[aeiouy]/.test(p));
  return oldShape && row.name === titleCase(parts);
}

/**
 * Re-applies the current email and name rules to a stored row, so old cache lines can be cleaned without
 * re-scraping. Returns null when the email no longer passes. A scraped name is only dropped when it is all
 * department words: its page context is gone, and JSON-LD names never needed to match the email.
 */
export function recheckRow<T extends Found>(row: T): T | null {
  const email = cleanEmail(row.email);
  if (!email) return null;
  const local = email.split('@')[0];
  let name = row.name;
  if (name && (localDerived(row) || allDeptWords(name))) name = null;
  if (email !== row.email && name && !consistentPerson(name, email)) name = null;
  const fromLocal = name ? null : nameFromLocal(local);
  const out: T = { ...row, email, name: name ?? fromLocal };
  if (name) out.nameFrom = row.nameFrom ?? 'page';
  else if (fromLocal) out.nameFrom = 'local';
  else delete out.nameFrom;
  return out;
}

/**
 * One first part across many local-part names on a site is a role mailbox per branch, not a person
 * ("bec.brisbane", "bec.cairns", … on a dealer group site). Clears those names in place.
 */
export function demoteRolePrefixes(rows: Found[], min = 5): void {
  const variants = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.name || !localDerived(r)) continue;
    const [first, ...rest] = localParts(r.email.split('@')[0]);
    if (!variants.has(first)) variants.set(first, new Set());
    variants.get(first)!.add(rest.join('.'));
  }
  for (const r of rows) {
    if (!r.name || !localDerived(r)) continue;
    if ((variants.get(localParts(r.email.split('@')[0])[0])?.size ?? 0) >= min) {
      r.name = null;
      delete r.nameFrom;
    }
  }
}

/** Looks like a JS-rendered shell with little real content. */
export function looksJsRendered(html: string): boolean {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const textLen = $('body').text().replace(/\s+/g, ' ').trim().length;
  if (textLen < 200) return true;
  return false;
}
