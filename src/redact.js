/**
 * Deterministic secret redaction. Runs on every transcript-derived string before it
 * reaches a model or the disk. Rules only — never model-decided.
 */

// Judged by the name's last words: DB_PASSWORD, apiKey, SECRET_KEY_BASE — not passwordLastUpdated.
// Strong names always hide their value; weak ones only when it holds a digit.
const STRONG_LAST = new Set(["password", "passwd", "pwd", "pass", "passphrase", "secret", "secrets", "credential", "credentials"]);
const STRONG_END = /(?:apikey|accesskey|privatekey|secretkey|secretkeybase|encryptionkey|signingkey|clientsecret)$/;
const WEAK_LAST = new Set(["token", "tokens", "auth", "authorization", "cookie", "signature", "dsn"]);
const words = (name) => name.split(/[_.-]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase());
function nameStrength(name) {
  const w = words(name);
  // A lone "PASS" is weak: test output ("--- PASS: TestFoo") has no digit; DB_PASS is strong.
  const last = w.at(-1);
  if (last === "pass" && w.length === 1) return "weak";
  if (STRONG_LAST.has(last) || STRONG_END.test(w.join(""))) return "strong";
  return WEAK_LAST.has(w.at(-1)) ? "weak" : null;
}

// Values that are configuration, not secrets: numbers, booleans, references, placeholders.
const NOT_A_VALUE = /^(\d+|true|false|null|none|yes|no|default|<[^>]*>|\*+|x{3,}|\.{3}|changeme|redacted|bearer|basic|token|\[redacted[^\]]*\])$/i;

// $VAR / ${VAR} references; case-sensitive so "$ecretPass99" is still a value.
const VAR_REF = /^(?:\$\{[\w.]+\}|\$[A-Z_][A-Z0-9_]*)$/;

// Working-directory names hold paths, not secrets (PWD=/Users/me/app, OLDPWD, pwd: ~/src).
const isDirName = (name) => /^(?:old)?pwd$/i.test(name);
const PATH = /^[~/][\w./-]*$/;

// Unquoted calls, member paths and camelCase identifiers are code (`token = getToken()`, `key: cfg.apiKey`).
const CODE = /[(){}[\]]|^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$|^[a-z]+(?:[A-Z][a-z0-9]*)+$/;

// Every rule starts after a non-word char and its body is length-bounded, so a long
// "a-a-a-…" or "eyJ-eyJ-…" run costs bounded work per start, not a rescan to its end.
// "-" may precede a token (id-AKIA…, key-sk-ant-…).
const B = "(?<![A-Za-z0-9_])";
const rx = (src, flags = "g") => new RegExp(src, flags);

/** Ordered: specific token formats first, then context rules, then entropy. */
export const RULES = [
  {
    id: "private-key",
    re: /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g,
  },
  { id: "aws-access-key-id", re: rx(`${B}(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\\b`) },
  { id: "github-token", re: rx(`${B}(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\\b`) },
  { id: "gitlab-token", re: rx(`${B}glpat-[A-Za-z0-9_-]{20,256}`) },
  { id: "slack-token", re: rx(`${B}xox[abposr]-[A-Za-z0-9-]{10,256}`) },
  { id: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{1,256}/g },
  { id: "stripe-key", re: rx(`${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,256}`) },
  { id: "anthropic-key", re: rx(`${B}sk-ant-[A-Za-z0-9_-]{20,512}`) },
  { id: "openai-key", re: rx(`${B}sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,512}`) },
  { id: "google-api-key", re: rx(`${B}AIza[0-9A-Za-z_-]{35}`) },
  { id: "npm-token", re: rx(`${B}npm_[A-Za-z0-9]{36}`) },
  // Header segment matched atomically (lookahead + backreference), so an "eyJ-eyJ-…" run
  // costs one scan per start, not a backtrack over every length looking for ".".
  { id: "jwt", re: rx(`${B}eyJ(?=([A-Za-z0-9_-]{8,512}))\\1\\.eyJ[A-Za-z0-9_-]{8,2048}\\.[A-Za-z0-9_-]{8,1024}`) },
  // scheme://[user]:password@host → keep user and host. Per RFC 3986 a raw / ? # ends the
  // authority; the password may hold "@", ":" and sub-delims ( ) ' , and runs to the last "@".
  // After that "@" the host also ends at quotes, "," and ")" (JSON, prose, host lists).
  {
    id: "url-password",
    re: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/?#@"<>]{0,256}:)([^\s/?#"<>]{1,256}?)(@)(?=[^\s/?#"'<>(),@]*(?:[\s/?#"'<>(),]|$))/gi,
    group: 2,
    // host:port closed by the bracket, quote or backtick that opened the URL — ['http://localhost:3000','a@b.io'],
    // [x](http://localhost:3000)@y — is a port, not a password. Unpaired, "2024(Xq9" is a password.
    skip: (pw, before) => {
      // Accepted gap: a digit-first password closed by its own opener, "(mysql://u:123)X@db)".
      const close = { "(": ")", "'": "'", "[": "]", "`": "`" }[before];
      return close != null && new RegExp(`^\\d{1,5}\\${close}`).test(pw);
    },
  },
  { id: "bearer", re: rx(`${B}((?:[Bb]earer|BEARER|[Bb]asic|BASIC|Token)\\s+)([A-Za-z0-9._~+/=-]{16,2048})`), group: 2 },
];

/**
 * NAME=value, NAME: value, --name=value, "name": "value", and JSON escaped inside a string
 * (\"name\": \"value\"). Groups: dashes, quote, name, separator, then one value form.
 * The separator stays on one line, so a parent key never eats its child (`database:\n  password: X`).
 */
const ASSIGNMENT =
  /(?<![\w.-])(-{0,2})(\\?["']?)([A-Za-z_][\w.-]*)\2([ \t]*[:=][ \t]*)(?:\\"((?:\\\\\\"|[^\n]){0,2048}?)\\"|"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|([^\s"'`]+))/g;

/**
 * A YAML value on the next indented line (`password:\n  X`), or a block scalar's whole
 * indented body (`key: |\n  line\n  line`). Runs after the one-line pass, so any key on that
 * line is already redacted; never a nested key (`name:` + space, end of line or a quote).
 * Groups: quote, name, then block (indicator, indent, body) or plain (indent, dq, sq, bare).
 */
const NEXT_LINE =
  /(?<![\w.-])(\\?["']?)([A-Za-z_][\w.-]*)\1[ \t]*:(?:[ \t]*([|>](?:\d[-+]?|[-+]\d?)?)[ \t]*\r?\n([ \t]+)([^\n]*(?:\n\4[^\n]*)*)|[ \t]*\r?\n([ \t]+)(?!\\?["']?[\w.-]+\\?["']?[ \t]*:(?:[ \t\r\n"']|$))(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|([^\s"'`]+)))/g;

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

  for (const { id, re, group, skip } of RULES) {
    out = out.replace(re, (...m) => {
      const groups = m.slice(1, -2);
      const [offset, src] = m.slice(-2);
      if (group && (groups[group - 1].startsWith("[REDACTED:") || skip?.(groups[group - 1], src[offset - 1]))) return m[0];
      hit(id);
      if (!group) return mark(id);
      return groups.map((g, i) => (i + 1 === group ? mark(id) : (g ?? ""))).join("");
    });
  }

  out = out.replace(ASSIGNMENT, (whole, dash, q, name, sep, eq, dq, sq, bare, offset, src) => {
    const strength = nameStrength(name);
    if (!strength) return whole;
    // Unquoted: a weak name's value ends at , ; & ) — a strong name's runs to whitespace (leak > lost text).
    let rest = "";
    let value = eq ?? dq ?? sq ?? bare;
    if (bare != null && strength === "weak") {
      const cut = bare.search(/[,;&)]/);
      if (cut >= 0) [value, rest] = [bare.slice(0, cut), bare.slice(cut)];
    }
    if (value.length < 6 || /[\s\u0080-\uffff]/.test(value) || NOT_A_VALUE.test(value) || VAR_REF.test(value) || (isDirName(name) && PATH.test(value)) || value.includes("[REDACTED:")) {
      return whole; // prose ("Reset password") and placeholders
    }
    // Go test output only: "--- PASS: TestIssue12 (0.00s)". A YAML "PASS: Test…" still counts.
    const end = offset + whole.length;
    if (name === "PASS" && src.slice(offset - 4, offset) === "--- " && / \(\d+(?:\.\d+)?s\)/y.test(src.slice(end, end + 16))) {
      return whole;
    }
    // Code (`getToken()`, `cfg.apiKey`, `resetPassword`) — unless a strong name's value has a digit.
    if (bare != null && CODE.test(value) && (strength === "weak" || !/\d/.test(value))) return whole;
    if (strength === "weak" && (value.length < 8 || !/\d/.test(value))) return whole;
    hit("assignment");
    const quote = eq != null ? '\\"' : dq != null ? '"' : sq != null ? "'" : "";
    return `${dash}${q}${name}${q}${sep}${quote}${mark("assignment")}${quote}${rest}`;
  });

  // A plain value needs a digit, and a weak name's must not be code, so `if password:\n    return x`
  // and `if token:\n    print(user1)` keep their next line. A block body is always hidden.
  out = out.replace(NEXT_LINE, (whole, q, name, block, bIndent, body, indent, dq, sq, bare) => {
    const strength = nameStrength(name);
    if (!strength) return whole;
    if (block != null) {
      if (!body.trim() || body.includes("[REDACTED:")) return whole;
      hit("assignment");
      return `${whole.slice(0, whole.length - body.length)}${mark("assignment")}`;
    }
    const value = dq ?? sq ?? bare;
    if (value.length < 6 || value.includes("[REDACTED:") || !/\d/.test(value)) return whole;
    if (bare != null && strength === "weak" && CODE.test(value)) return whole;
    hit("assignment");
    const quote = dq != null ? '"' : sq != null ? "'" : "";
    const valueStart = whole.length - value.length - quote.length * 2;
    return `${whole.slice(0, valueStart)}${quote}${mark("assignment")}${quote}`;
  });

  out = out.replace(ENTROPY_CANDIDATE, (s) => {
    if (!looksRandom(s)) return s;
    hit("high-entropy");
    return mark("high-entropy");
  });

  return { text: out, hits };
}
