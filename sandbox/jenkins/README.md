# Jenkins sandbox

Runs qa-sentinel's `Jenkinsfile.tests` on a real Jenkins against the ShopLite sandbox, on your laptop.

**Needs:** Docker Desktop, the ShopLite sandbox set up (`node sandbox/shoplite/local.mjs setup`), ShopLite's QA
environment running (`node sandbox/shoplite/local.mjs env start`).

```bash
docker compose -f sandbox/jenkins/docker-compose.yml up --build -d
# open http://localhost:8090 (admin / admin) → qa-api-tests → Build with Parameters → Build
docker compose -f sandbox/jenkins/docker-compose.yml down -v     # remove it again
```

**What to check:** the build pulls the Playwright image, installs, type-checks, runs the API (and web) tests
against ShopLite on `host.docker.internal:8080`, and the "Tests" tab shows the JUnit results. With
`CHANGED_ONLY=true` on a `qa-sentinel/*` branch it runs `qa-sentinel verify --policy` instead.

The gap report and generation jobs need a GitLab project and its merge request events (GitLab plugin); try them on
your GitLab sandbox once the suite job works.
