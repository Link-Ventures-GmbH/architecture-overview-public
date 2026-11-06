# Evals demo

A pretend test run for the Evals view. From the repository root:

```
node tools/evals-demo.mjs
```

It writes `data/live.json` and `data/runs/<id>/` here and sends GenAI spans with
`project.dir` set to this folder, so the tool files them under this project.
Open this folder in Architecture Overview (project switcher) and pick Evals.
