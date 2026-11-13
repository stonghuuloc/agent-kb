# Security policy

agent-kb reads your agent transcripts and stores redacted summaries on your machine
(see [CONSTITUTION.md](CONSTITUTION.md), principles 1–3). Bugs that matter most here:

- a secret that survives redaction and reaches the store, a model call or a note;
- data leaving the machine other than the redacted text sent to the model provider you configured;
- a path where crafted transcript, export or vault content runs code or writes outside its folder.

## Reporting

Report privately through GitHub: **Security → Report a vulnerability** on this repository
(private vulnerability reporting). Please do not open a public issue. Include a minimal input
that shows the problem; never include a real credential, generate a fake one of the same shape.

You can expect a first reply within 7 days. Fixes ship on `main`; there are no maintained
release branches yet.
