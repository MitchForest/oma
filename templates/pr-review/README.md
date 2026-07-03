# pr-review — the bugbot

1. Configure a real model in .oma/config.json (default is the fake provider).
2. Export GITHUB_TOKEN (repo scope). The workflow reads it via env.secrets.
3. Serve webhooks: GITHUB_WEBHOOK_SECRET=<secret> oma serve webhooks
4. GitHub repo -> Settings -> Webhooks: URL http://<host>:8787/webhooks/github,
   content type application/json, secret matching, events: Pull requests.
5. Dry run without GitHub:
   oma trigger emit pr-review github pull_request.opened \
     --payload '{"repo":"o/r","pr":1,"draft":false,"head":"sha"}' \
     --no-wake
