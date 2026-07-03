# incident-to-pr

1. Configure a real model in .oma/config.json.
2. Sentry -> Settings -> Developer Settings -> internal integration with a
   webhook URL of http://<host>:8787/webhooks/sentry and issue alerts enabled.
3. Serve: SENTRY_WEBHOOK_SECRET=<client secret> oma serve webhooks
4. Each incident becomes a durable session (incident:<issueId>); the fix
   stage pauses for your approval before touching files.
5. Dry run:
   oma trigger emit incident-to-pr sentry issue.created \
     --payload '{"issueId":"1","title":"TypeError","culprit":"auth.ts","permalink":"https://sentry.io/x"}'
