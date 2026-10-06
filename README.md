# Sui Basecamp 2026 Agenda Planner

Plan your days at [Sui Basecamp](https://www.sui.io/basecamp) in Singapore, Oct 7-8, 2026.

**Open the planner: https://basecamp.inodra.com/**

- Pick your topics. The planner builds a program for both days: when, which stage, what it is.
- When two sessions overlap, you see both side by side with a short summary. Pick one or decide on the day.
- Star sessions to always keep them. Skip the ones you do not want.
- Share your program with a link. The program lives in the link, so there is no account and no backend.
- Export your program to your calendar (.ics, Singapore time). Each session has an alarm 10 min before.
- Optional reminders in the browser, 10 min before each session. They only work while the page is open.

This is an unofficial tool by [Inodra](https://inodra.com/?utm_source=basecamp-planner&utm_medium=referral&utm_campaign=sui-basecamp-2026). It is not affiliated with the Sui Foundation or Mysten Labs. The schedule can change, so check the [official agenda](https://www.sui.io/basecamp#agenda).

## Update the agenda

The agenda comes from the official page. To refresh it:

```sh
python3 scrape.py
```

The script writes `data.js` and prints the counts per day, stage and format. It lists new or renamed sessions. Add them to `annotations.json` with topics and a one-line summary.

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. You can also open `index.html` directly.

## License

[Apache-2.0](LICENSE)
