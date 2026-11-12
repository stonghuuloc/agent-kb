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
    "PASSWORD=${DB_PASS} and secret: <your-secret> and api_key: xxxx",
    "DB_PASSWORD=$DB_PASS and password = getPassword() and password: cfg.db.password",
    "http://localhost:5173/@vite/client and http://localhost:3000/@fs/Users/me/app/main.ts",
    "https://registry.npmjs.org:443/@types/node",
    "http://localhost:8080/invite?email=bob@example.com",
    "--- PASS: TestParseConfig (0.00s)",
    "--- PASS: TestIssue1234 (0.00s) and --- PASS: TestFoo/case_1 (0.00s)",
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
  ]);
});

test("a weak name's unquoted value stops at , ; & )", () => {
  // Act
  const out = redact("token=abc123def4&user=a").text;

  // Assert
  assert.equal(out, "token=[REDACTED:assignment]&user=a");
});

test("adversarial runs are redacted in linear time", () => {
  // Arrange
  const shapes = ["a.", "a-", "a+", "eyJ-", "eyJaaaaaaaaa-", "sk-", "sk-ant-", "xoxb-", "glpat-", "a://u:", "--a=", "a=", 'x:"', "Bearer ", "a:b@", 'x:\\"'];

  redact("warm-up"); // compile every rule outside the timed loop
  for (const unit of shapes) {
    const text = unit.repeat(Math.ceil(200_000 / unit.length));

    // Act
    const t = performance.now();
    redact(text);
    const ms = performance.now() - t;

    // Assert
    assert.ok(ms < 500, `${JSON.stringify(unit)} × 200 KB took ${ms.toFixed(0)} ms`);
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
