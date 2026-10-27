# shoplite-demo: the template that `setup-gitlab.mjs` pushes

| Folder | Goes to | Notes |
| --- | --- | --- |
| `service-orders/` | the GitLab project `shoplite-orders` | The ShopLite orders service (from `sandbox/shoplite`). When `PAYMENTS_URL` is not set it answers for payments itself, so this repo alone is enough for cards 1 to 4. Its `.gitlab-ci.yml` includes the shipped `service.gitlab-ci.yml` from the test repo. |
| `service-payments/` | `shoplite-payments` (optional) | The ShopLite payments service. Only the cross-service card needs it. |
| `tests/` | overlay for `shoplite-tests` | Added on top of `qa-sentinel init` (which brings the shipped CI templates, config, skills and agents): `.gitlab-ci.yml`, `qa-env/` (starts the services and a gateway on :8080), baseline API tests for the orders service, `test-map.yaml`. `qa-sentinel.config.sample.yaml` shows the settings that setup adds, with placeholders; a test keeps it equal to what the script writes. |
| `changes/` | not pushed | The developer's change for each card: `{ service, branch slug, commitMessage, edits: { file: [[search, replace]] } }`. `{KEY}` becomes the Jira key. A change that does not fit is refused. |
| `stories/` | not pushed | The text of each Jira card (story or bug), with numbered acceptance criteria. `seed-jira.mjs` turns it into Jira wiki text. |

The planted catch: card 1 (delivery slot) is written with a capacity of 5 where the card says 3. Card 3 (the bug) fixes it.
Only made-up text lives here. No secrets: tokens and keys are CI/CD variables or environment variables.
