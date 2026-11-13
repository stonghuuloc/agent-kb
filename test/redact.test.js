import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/redact.js";
import { openStore, upsertDoc, getDoc } from "../src/store.js";

// Fixture secrets are generated, never literal: real-format tokens in the repo trip push protection.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const rand = (n, alphabet = ALNUM, r = rng(n * 7919)) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
const UPPER_NUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0234567";
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

const SECRETS = {
  "private-key": `-----BEGIN OPENSSH PRIVATE KEY-----\n${rand(64)}\n${rand(64)}\n-----END OPENSSH PRIVATE KEY-----`,
  "aws-access-key-id": "AKIA" + rand(16, UPPER_NUM),
  "github-token": "ghp_" + rand(36),
  "github-fine-grained": "github_pat_" + rand(22) + "_" + rand(59),
  "gitlab-token": "glpat-" + rand(20),
  "slack-token": "xoxb-" + rand(11, "0123456789") + "-" + rand(24),
  "slack-webhook": "https://hooks.slack.com/services/T" + rand(8, UPPER_NUM) + "/B" + rand(8, UPPER_NUM) + "/" + rand(24),
  "stripe-key": "sk_" + "live_" + rand(24),
  "anthropic-key": "sk-ant-api03-" + rand(80),
  "openai-key": "sk-proj-" + rand(48),
  "google-api-key": "AIza" + rand(35),
  "npm-token": "npm_" + rand(36),
  jwt: `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "1234567890", name: "x" })}.${rand(43)}`,
};

test("each token format is replaced in place, surrounding text kept", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    // Arrange
    const text = `before ${secret} after`;

    // Act
    const out = redact(text).text;

    // Assert
    assert.ok(!out.includes(secret), `${name} leaked: ${out}`);
    assert.match(out, /^before \[REDACTED:[a-z-]+\] after$/, name);
  }
});

test("secret-named assignments lose their value in env, YAML and JSON forms", () => {
  // Arrange
  const value = rand(20);
  const lines = [
    `DB_PASSWORD=${value}`,
    `export API_KEY="${value}"`,
    `client_secret: ${value}`,
    `{"accessToken": "${value},with;punctuation"}`,
    `auth_token = '${value}'`,
  ];

  // Act
  const out = lines.map((l) => redact(l).text);

  // Assert
  for (const o of out) assert.ok(!o.includes(value) && o.includes("[REDACTED:assignment]"), o);
  assert.equal(out[3], '{"accessToken": "[REDACTED:assignment]"}');
});

test("credentials inside URLs and auth headers are cut, the rest is kept", () => {
  // Arrange
  const pw = rand(14);
  const tok = rand(40, "abcdef0123456789");

  // Act
  const url = redact(`psql postgres://admin:${pw}@db.internal:5432/app`).text;
  const hdr = redact(`curl -H "Authorization: Bearer ${tok}" https://api.example.com`).text;

  // Assert
  assert.equal(url, "psql postgres://admin:[REDACTED:url-password]@db.internal:5432/app");
  assert.equal(hdr, 'curl -H "Authorization: Bearer [REDACTED:bearer]" https://api.example.com');
});

test("an unterminated private key is redacted to the end of the text", () => {
  // Arrange
  const body = rand(64);

  // Act
  const out = redact(`key:\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n(truncated`).text;

  // Assert
  assert.equal(out, "key:\n[REDACTED:private-key]");
});

test("long random strings without a known format are caught by entropy", () => {
  // Arrange
  const secret = "Q" + rand(38, ALNUM + "+/") + "7";

  // Act
  const { text, hits } = redact(`opaque value ${secret} here`);

  // Assert
  assert.equal(text, "opaque value [REDACTED:high-entropy] here");
  assert.deepEqual(hits, { "high-entropy": 1 });
});

test("ordinary transcript text is left alone", () => {
  // Arrange
  const safe = [
    "commit 39dfdb69c6854e1ee6fa89e72697c578ce5fb0e3 merged",
    "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "request id 123e4567-e89b-12d3-a456-426614174000",
    "/Users/someone/Documents/Projects/agent-kb/node_modules/@scope/pkg/dist/index.js",
    "TOKEN_TTL=3600 and AUTH_ENABLED=true",
    'password: "Password must be at least 8 characters"',
    '{"secret": "Top 10 tips"}',
    "PASSWORD=${DB_PASS} and secret: <your-secret> and api_key: xxxx",
    "DB_PASSWORD=$DB_PASS and password = getPassword() and password: cfg.db.password",
    "http://localhost:5173/@vite/client and http://localhost:3000/@fs/Users/me/app/main.ts",
    "https://registry.npmjs.org:443/@types/node",
    "http://localhost:8080/invite?email=bob@example.com",
    "--- PASS: TestParseConfig (0.00s)",
    "--- PASS: TestIssue1234 (0.00s) and --- PASS: TestFoo/case_1 (0.00s)",
    "['http://localhost:3000','admin@corp.com'] and [home](http://localhost:3000)@alice",
    "(http://localhost:3000),bob@corp.com",
    "`http://localhost:3000`,`admin@corp.com`",
    "database:\n  host: db.local\n  port: 5432",
    "if password:\n    return hashed",
    "if token:\n    print(user1)",
    'token:\n  "api_key2":"abcdefgh"',
    "PWD=/Users/someone/src/app and pwd: ~/src",
    "fix the password reset flow; rotate the token after login",
    "const authenticationMiddlewareConfigurationFactory = makeFactory();",
    "const token = response.data.accessToken;",
    "author: someone-else",
    "CancellationToken cancellationToken = default",
    "const resetPassword = useResetPassword",
    "AuthController.cs:42: var x = 1",
    "X-Atlassian-Token: no-check",
    'resetPassword: "Reset password"',
    "passwordLastUpdated = 2026-11-12T08:00:00Z",
    "SSH_AUTH_SOCK=/private/tmp/com.apple.launchd.abc/Listeners",
    "tokenize: 'porter unicode61'",
    "/private/tmp/agent-1234/projects/-Users-someone-Documents-Projects/b7f8332e-ffad-4ee9/tasks/x",
    "feedback_kb_first_on_continuity_2026_11_12.md",
    "https://github.com/someone/agent-kb/pull/1#discussion_r1234567890",
    "Authorization: Bearer [REDACTED:bearer]",
  ];

  // Act
  const out = safe.map((s) => redact(s));

  // Assert
  out.forEach((o, i) => assert.equal(o.text, safe[i], JSON.stringify(o.hits)));
});

test("redaction is idempotent", () => {
  // Arrange
  const once = redact(`DB_PASSWORD=${rand(20)} and ${SECRETS["github-token"]}`).text;

  // Act
  const twice = redact(once);

  // Assert
  assert.equal(twice.text, once);
  assert.deepEqual(twice.hits, {});
});

test("nothing transcript-derived reaches the store unredacted", () => {
  // Arrange
  const db = openStore(":memory:");
  const planted = Object.values(SECRETS);

  // Act
  upsertDoc(db, {
    source_path: "t",
    source_type: "claude-code",
    tier: "episodic",
    title: `fix login ${SECRETS["github-token"]}`,
    content: planted.map((s, i) => `step ${i}: used ${s}`).join("\n"),
  });
  const stored = getDoc(db, "t");
  const fts = db.prepare("SELECT title || ' ' || content AS t FROM chunks_fts").get().t;

  // Assert
  for (const s of planted) {
    assert.ok(!stored.title.includes(s) && !stored.content.includes(s) && !fts.includes(s), s.slice(0, 12));
  }
});

test("a resume command holding a secret is dropped; a clean one is kept", () => {
  // Arrange
  const db = openStore(":memory:");
  const doc = (p, cmd) => ({ source_path: p, source_type: "claude-code", tier: "episodic", title: "t", content: "c", resume_cmd: cmd });

  // Act
  upsertDoc(db, doc("bad", "cd '/work/DB_PASSWORD=hunter2x9' && claude --resume s1"));
  upsertDoc(db, doc("good", "cd /work/app && claude --resume s2"));

  // Assert
  assert.equal(getDoc(db, "bad").resume_cmd, null);
  assert.equal(getDoc(db, "good").resume_cmd, "cd /work/app && claude --resume s2");
});

test("digits alone are a secret under a strong name and config under a weak one", () => {
  // Arrange
  const pins = [
    "DB_PASSWORD=123456", "--password 123456", 'password: "123456"', "export SECRET=987654321", "password:\n  123456",
    "DB_PASSWORD=1234", "--password 1234", 'password: "1234"', "password:\n  1234", "secret=7",
    '{"password": 1234}', "password = 1234;", "DB_PASSWORD=1234)", "--password 1234;", "password:\n  1234,", "password: 1234.",
  ];
  const config = ["token_ttl=86400", "retries: 3", "max_token=123456", "TIMEOUT=300000", "token: 1234", "pass: ok", "password: abc"];

  // Act
  const hidden = pins.map((s) => redact(s).text);
  const kept = config.map((s) => redact(s).text);

  // Assert
  hidden.forEach((t, i) => assert.ok(!t.includes(pins[i].match(/(\d+)\D*$/)[1]), `${pins[i]} → ${t}`));
  assert.deepEqual(kept, config);
});

test("strong secret names lose the whole value in every common shape", () => {
  // Arrange
  const v = "Q" + rand(10) + "7";
  const lines = [
    `--password=${v}`,
    `curl -d "{\\"password\\":\\"${v}\\"}"`,
    `"password": "ab\\"${v}"`,
    `DB_PASSWORD=${v}(x`,
    `DB_PASSWORD=myPassword2024${v}`,
    `DB_PASSWORD=Xy7,${v}`,
    `DB_PASSWORD=$e${v}`,
    `SECRET_KEY=${v}!@#`,
    `STRIPE_SECRET_KEY=${v}`,
    `SECRET_KEY_BASE=${v}`,
    `DB_PASS=${v}`,
    `PASS=${v}`,
    `--pass=${v}`,
    `"pass": "${v}"`,
    `PASSWORD=/${v}`,
    `SECRET=~${v}`,
    `PASS=Test${v}`,
    `--pass=Test${v}`,
    `"pass": "Test${v}"`,
    `environment:\n  PASS: Test${v}`,
    `database:\n  password: ${v}`,
    `password:\n  ${v}`,
    `DB_PASSWORD:\n    ${v}`,
    `private_key: >-\n  ${v}`,
    `config:\n  "password": "${v}"`,
    `db:\n  'password': '${v}'`,
    `args:\n  "--password=${v}"`,
    `x:\n  foo,password=${v}`,
    `{\n  "db":\n    "password": "${v}"}`,
    `password:\n  "${v}"`,
    `password:\n  '${v}'`,
    `token:\n  ${v}==`,
    `api_key:\n  ab9:${v}`,
    `password: |2\n  ${v}`,
    `password:\n  my${v}`,
    `password:\n  Pa(ss)${v}`,
    `DB_PASSWORD:\n    hunter.${v}`,
    `password:\n  "ab\\"${v}"`,
    `password: |\n  correct horse ${v}\n  battery ${v}`,
    `password: |\n  first line\n\n  after blank ${v}\nnext: 1`,
    `password: |\n  a\n\n\n  two blanks ${v}\nnext: 1`,
    `password: |\n  a\n \n\t\n\n  three blanks ${v}`,
    `password: |\n\n  leading blank ${v}`,
    `password: |\r\n  a\r\n\r\n\r\n  crlf blanks ${v}`,
    `password: 'it''s a ${v}'`,
    `password: "p@ss 2023! ${v}"`,
    `password: "correct horse ${v}"`,
    `private_key: |\n  ${SECRETS["github-token"]}\n  tail ${v}`,
    `password: | # comment\n  body ${v}`,
    `password: 'it''s${v}'`,
    `password:\n  'it''s${v}'`,
    `authorization: bearer ${rand(40, "abcdef0123456789")}${v}`,
    `{\\"password\\":\\"ab\\\\\\"${v}\\"}`,
  ];

  // Act
  const out = lines.map((l) => redact(l).text);

  // Assert
  out.forEach((o, i) => assert.ok(!o.includes(v), `${lines[i]} → ${o}`));
});

test("URL passwords are cut with an empty user, @ or : inside, and any authority terminator", () => {
  // Arrange
  const v = "Q" + rand(10) + "7";

  // Act
  const out = [
    `redis://:${v}@cache:6379`,
    `postgres://admin:ab%2F${v}@db`,
    `postgres://admin:ab@${v}@db.local/x`,
    `postgres://admin:ab@${v}:x9@db.local/x`,
    `{"url":"postgres://admin:${v}@db.local:5432","x":1}`,
    `(see postgres://admin:${v}@db:5432).`,
    `mongodb://u:${v}@h1:27017,h2:27017/db`,
    `mysql://root:${v}@[::1]:3306/app`,
    `postgres://admin:Pa(ss)${v}@db.local/app`,
    `mysql://root:it's${v}@db/app`,
    `amqp://u:Xq9!$&'()*+,;=${v}@mq:5672/`,
    `mysql://root:2024'${v}@db`,
    `postgres://admin:1234(${v})9@db:5432/app`,
    `amqp://u:123,${v}@mq`,
    `redis://:007;${v}@cache`,
  ].map(
    (l) => redact(l).text,
  );

  // Assert
  assert.deepEqual(out, [
    "redis://:[REDACTED:url-password]@cache:6379",
    "postgres://admin:[REDACTED:url-password]@db",
    "postgres://admin:[REDACTED:url-password]@db.local/x",
    "postgres://admin:[REDACTED:url-password]@db.local/x",
    '{"url":"postgres://admin:[REDACTED:url-password]@db.local:5432","x":1}',
    "(see postgres://admin:[REDACTED:url-password]@db:5432).",
    "mongodb://u:[REDACTED:url-password]@h1:27017,h2:27017/db",
    "mysql://root:[REDACTED:url-password]@[::1]:3306/app",
    "postgres://admin:[REDACTED:url-password]@db.local/app",
    "mysql://root:[REDACTED:url-password]@db/app",
    "amqp://u:[REDACTED:url-password]@mq:5672/",
    "mysql://root:[REDACTED:url-password]@db",
    "postgres://admin:[REDACTED:url-password]@db:5432/app",
    "amqp://u:[REDACTED:url-password]@mq",
    "redis://:[REDACTED:url-password]@cache",
  ]);
});

test("a weak name's unquoted value stops at , ; & )", () => {
  // Act
  const out = redact("token=abc123def4&user=a").text;

  // Assert
  assert.equal(out, "token=[REDACTED:assignment]&user=a");
});

test("adversarial runs are redacted in linear time", () => {
  // Arrange: 16x input costs ~16x if linear, 256x if quadratic; the wide span and best of 3 absorb GC and load
  const best = (text) => Math.min(...[0, 1, 2].map(() => { const t = performance.now(); redact(text); return performance.now() - t; }));
  const shapes = ["a.", "a-", "a+", "eyJ-", "eyJaaaaaaaaa-", "sk-", "sk-ant-", "xoxb-", "glpat-", "a://u:", "--a=", "a=", 'x:"', "Bearer ", "a:b@", 'x:\\"', "password:" + " ".repeat(5000), "password: |" + " ".repeat(5000), "pwd:", "pwd: a 1", "--password ", "--key a", "x: |\n\n", "password: |\n\n", "password: |\n \n"];

  redact("warm-up"); // compile every rule outside the timed loop
  for (const unit of shapes) {
    const at = (bytes) => unit.repeat(Math.ceil(bytes / unit.length));

    // Act
    const small = best(at(50_000));
    const large = best(at(800_000));

    // Assert
    const ratio = large / Math.max(small, 1);
    assert.ok(ratio < 64, `${JSON.stringify(unit)}: 800 KB took ${large.toFixed(0)} ms, 50 KB ${small.toFixed(0)} ms (×${ratio.toFixed(1)})`);
    assert.ok(large < 10_000, `${JSON.stringify(unit)} × 800 KB took ${large.toFixed(0)} ms`);
  }
});

test("tokens right after a dash are still redacted", () => {
  // Arrange
  const cases = [`id-${SECRETS["aws-access-key-id"]}`, `key-${SECRETS["anthropic-key"]}`, `foo-${SECRETS.jwt}`];

  // Act
  const out = cases.map((c) => redact(c).text);

  // Assert
  assert.deepEqual(out, ["id-[REDACTED:aws-access-key-id]", "key-[REDACTED:anthropic-key]", "foo-[REDACTED:jwt]"]);
});

test("a JWT with a long header (kid, jku) is still one jwt hit", () => {
  // Arrange
  const header = b64url({ alg: "RS256", kid: rand(120), jku: "https://keys.example.com/" + rand(80) });
  const token = `${header}.${b64url({ sub: "1" })}.${rand(43)}`;

  // Act
  const { text, hits } = redact(`auth ${token} end`);

  // Assert
  assert.ok(header.length > 256);
  assert.equal(text, "auth [REDACTED:jwt] end");
  assert.deepEqual(hits, { jwt: 1 });
});

test("a CRLF block keeps its line endings and the lines after it", () => {
  // Act
  const out = redact("password: |\r\n  line one 9\r\n  line two\r\nnext: 1").text;

  // Assert
  assert.equal(out, "password: |\r\n  [REDACTED:assignment]\r\nnext: 1");
});

test("a multi-megabyte blank run after a secret block neither throws nor leaks", () => {
  // Arrange
  const blanks = "\n".repeat(5_000_000);

  // Act
  const lead = redact(`password: |${blanks}  tail hunter2pass9`).text;
  const inner = redact(`password: |\n  a${blanks}  tail hunter2pass9`).text;

  // Assert
  assert.ok(!lead.includes("hunter2pass9") && !inner.includes("hunter2pass9"));
});

test("quoted passphrases with a year or a digit next to a symbol are hidden; labels are kept", () => {
  // Arrange
  const secret = ['password: "Winter 2025"', 'password: "Summer 2024!"', 'password: "p@ss 2023!"'];
  const label = ['password: "Must be at least 8 characters"', 'secret: "Top 10 tips"', 'password: "Reset password"'];

  // Act
  const out = [...secret, ...label].map((l) => redact(l).text);

  // Assert
  assert.deepEqual(out.slice(0, 3), Array(3).fill('password: "[REDACTED:assignment]"'));
  assert.deepEqual(out.slice(3), label);
});

test("unquoted multi-word passphrases and space-separated password flags are hidden", () => {
  // Arrange
  const lines = [
    "password: Summer 2024!",
    "password: Winter 2025",
    "pwd: Summer 2024!",
    "password: P@ss 9876 word",
    "secret: p@ss 2023! # rotated",
    "password:\n  Summer 2024!",
    "mysql --password Qx7vT2kLp9zR -h db",
    'psql --password "Qx7vT2kLp9zR"',
    'login --password "Winter 2025" --user a',
    "password: Summer 2024! # " + "note ".repeat(30),
    "secret: Summer 2024!" + " ".repeat(120),
    "password: hunter2 summer",
    "password: Pa:ss 2024",
    "pwd: P=ss 9876",
    "passphrase: correct horse 9 battery",
    '--password "a1b2 secret: Summer 2024!" more',
    "password:\n  ab:12 cd",
    "password: Summer 2024!\rnext: 1",
    "password: Summer 2024!\f",
  ];
  const expected = [
    "password: [REDACTED:assignment]",
    "password: [REDACTED:assignment]",
    "pwd: [REDACTED:assignment]",
    "password: [REDACTED:assignment]",
    "secret: [REDACTED:assignment] # rotated",
    "password:\n  [REDACTED:assignment]",
    "mysql --password [REDACTED:assignment] -h db",
    'psql --password "[REDACTED:assignment]"',
    'login --password "[REDACTED:assignment]" --user a',
    "password: [REDACTED:assignment] # " + "note ".repeat(30),
    "secret: [REDACTED:assignment]" + " ".repeat(120),
    "password: [REDACTED:assignment]",
    "password: [REDACTED:assignment]",
    "pwd: [REDACTED:assignment]",
    "passphrase: [REDACTED:assignment]",
    '--password "[REDACTED:assignment]" more',
    "password:\n  [REDACTED:assignment]",
    "password: [REDACTED:assignment]\rnext: 1",
    "password: [REDACTED:assignment]\f",
  ];

  // Act
  const first = lines.map((l) => redact(l));
  const out = first.map((r) => r.text);
  const again = out.map((l) => redact(l));

  // Assert
  assert.deepEqual(out, expected);
  first.forEach((r, i) => assert.deepEqual(r.hits, { assignment: 1 }, lines[i]));
  assert.deepEqual(again.map((r) => r.text), expected);
  assert.ok(again.every((r) => Object.keys(r.hits).length === 0));
});

test("flags and keys that only look secret keep their text", () => {
  // Arrange
  const safe = [
    "docker login --password-stdin",
    "psql --password $PGPASSWORD",
    "git log --pretty format",
    "credentials:\n  user: admin1",
    "password: Must be at least 8 characters",
    "reset password: done",
    "monkey: banana 2024",
    "imagePullSecrets:\n  - name: regcred1",
    'if password == "abc123":',
  ];

  // Act
  const out = safe.map((l) => redact(l).text);

  // Assert
  assert.deepEqual(out, safe);
});
