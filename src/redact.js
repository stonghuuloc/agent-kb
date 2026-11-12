/**
 * Deterministic secret redaction. Runs on every transcript-derived string before it
 * reaches a model or the disk. Rules only — never model-decided.
 */

// Matched on the name's last two words: DB_PASSWORD, apiKey, GH_TOKEN — not passwordLastUpdated.
// Strong names always hide their value; weak ones only when it holds a digit.
const STRONG_TAIL = /(?:passw(?:or)?d|pwd|passphrase|secrets?|apikey|accesskey|privatekey|credentials?)$/;
const WEAK_TAIL = /(?:tokens?|auth|cookie|signature|dsn)$/;
const tail = (name) =>
  name
    .split(/[_.-]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .slice(-2)
    .join("")
    .toLowerCase();

// Values that are configuration, not secrets: numbers, booleans, references, placeholders.
const NOT_A_VALUE = /^(\d+|true|false|null|none|yes|no|default|\$\{?[\w.]+\}?|<[^>]*>|\*+|x{3,}|\.{3}|changeme|redacted|bearer|basic|token|\[redacted[^\]]*\])$/i;

// Unquoted calls, member paths and camelCase identifiers are code (`token = getToken()`, `key: cfg.apiKey`).
const CODE = /[(){}[\]]|^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$|^[a-z]+(?:[A-Z][a-z0-9]*)+$/;

/** Ordered: specific token formats first, then context rules, then entropy. */
export const RULES = [
  {
    id: "private-key",
    re: /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g,
  },
  { id: "aws-access-key-id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { id: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { id: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // scheme://user:password@host → keep user and host.
  { id: "url-password", re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, group: 2 },
  { id: "bearer", re: /\b((?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{16,})/g, group: 2 },
];

/** NAME=value, NAME: value, "name": "value" where NAME looks like a secret. */
const ASSIGNMENT = /(?<![\w.-])(["']?)([A-Za-z_][\w.-]*)\1(\s*[:=]\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'`,;]+))/g;

const ENTROPY_CANDIDATE = /[A-Za-z0-9+/_=-]{32,}/g;

export function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) h -= (k / s.length) * Math.log2(k / s.length);
  return h;
}

const WORD = /^(?:[a-z]{2,}\d{0,4}|[A-Z][a-z]+|[A-Z]{2,}|\d{1,4})$/;

/** Share of separator-delimited parts that are plain words (paths, snake_case, kebab-case). */
function wordShare(s) {
  const parts = s.split(/[/_.=-]+/).filter(Boolean);
  return parts.length < 2 ? 0 : parts.filter((p) => WORD.test(p)).length / parts.length;
}

/**
 * Long, upper + lower + digit, high-entropy, not a hex hash/UUID, not a path or identifier.
 * Measured: misses ~2% of 32-byte base64 keys; lowercase-only tokens are left to the format rules.
 */
export function looksRandom(s) {
  const bare = s.replace(/^[-_=/+.]+|[-_=/+.]+$/g, "");
  if (bare.length < 32 || /^[0-9a-f-]+$/i.test(bare)) return false;
  if (!/[a-z]/.test(bare) || !/[A-Z]/.test(bare) || !/\d/.test(bare)) return false;
  if (wordShare(bare) >= 0.5) return false;
  return entropy(bare) >= 4.3;
}

const mark = (id) => `[REDACTED:${id}]`;

/** Returns the redacted text and the rule ids that fired (with counts). */
export function redact(text) {
  if (text == null) return { text, hits: {} };
  let out = String(text);
  const hits = {};
  const hit = (id) => (hits[id] = (hits[id] ?? 0) + 1);

  for (const { id, re, group } of RULES) {
    out = out.replace(re, (...m) => {
      hit(id);
      if (!group) return mark(id);
      return m.slice(1, -2).map((g, i) => (i + 1 === group ? mark(id) : g ?? "")).join("");
    });
  }

  out = out.replace(ASSIGNMENT, (whole, q, name, sep, dq, sq, bare) => {
    const value = dq ?? sq ?? bare;
    const t = tail(name);
    const strong = STRONG_TAIL.test(t);
    if (!strong && !WEAK_TAIL.test(t)) return whole;
    if (value.length < 6 || /[\s\u0080-\uffff]/.test(value) || NOT_A_VALUE.test(value) || value.includes("[REDACTED:")) {
      return whole; // prose ("Reset password") and placeholders
    }
    if (bare != null && CODE.test(bare)) return whole;
    if (!strong && (value.length < 8 || !/\d/.test(value))) return whole;
    hit("assignment");
    const quote = dq != null ? '"' : sq != null ? "'" : "";
    return `${q}${name}${q}${sep}${quote}${mark("assignment")}${quote}`;
  });

  out = out.replace(ENTROPY_CANDIDATE, (s) => {
    if (!looksRandom(s)) return s;
    hit("high-entropy");
    return mark("high-entropy");
  });

  return { text: out, hits };
}
