# nightly-triage

1. Configure a real model in .oma/config.json.
2. Test it once: oma run nightly-triage
3. Schedule it (crontab -e):
   0 2 * * * cd /path/to/repo && oma run nightly-triage
4. Read the morning report: oma list, then oma show <sessionId>.
