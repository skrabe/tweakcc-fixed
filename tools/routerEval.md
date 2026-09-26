# Effort routing evaluation

Run from the repository root with the installed dependencies:

```sh
node --import tsx tools/routerEval.mts --out /tmp/router-eval.json
```

The default runs the real generated runtime against deterministic Jev answers and a mocked Haiku summarizer. It tests effort application, including sequential transitions; it cannot measure whether Jev understands the rubric. The 40 synthetic scenarios cover coding, administrative work, writing, research, bounded operations in high-stakes domains, missing context and difficult-to-simple transitions. Labels are acceptable effort intervals, not assertions that only one effort is correct. They are independent of any user's private conversation.

To measure actual classification, explicitly enable live requests:

```sh
node --import tsx tools/routerEval.mts --live --out /tmp/router-eval-live.json
node --import tsx tools/routerEval.mts --live --model claude-fable-5-1 --out /tmp/router-eval-fable.json
```

Live mode incurs Jev API usage. It uses the production credential loader (environment or OS credential store), never prints credentials, and does not run a Claude task or call Haiku. It keeps router state in memory and does not touch the user's conversation sidecars or model settings. Output files include synthetic request bodies, decisions and measurements, and are created with owner-only permissions. Existing output files retain their existing permissions. Only use trusted runtime and case files.

Capture the generated runtime before editing, then compare identical cases:

```sh
node --import tsx tools/routerEval.mts --write-runtime /tmp/router-before.js --out /tmp/before-policy.json
node --import tsx tools/routerEval.mts --runtime-file /tmp/router-before.js --live --out /tmp/before-live.json
node --import tsx tools/routerEval.mts --live --out /tmp/after-live.json
```

`data/router-evals-heldout.json` contains 20 additional scenarios whose labels were frozen before observing classifications. This set was subsequently reused during semantic-rubric revision, so its final results are validation rather than independent holdout evidence. Run it with `--cases data/router-evals-heldout.json`; keep its labels fixed.

`data/router-evals-invariance.json` separately checks meaning-preserving paraphrases and identical vocabulary with different remaining work, including quoted tasks versus actual requests. Its labels were frozen before outputs; it was also reused during rubric revision. `data/router-evals-blind.json` was a fresh 10-case holdout for the concise rubric. It was reused after the user subsequently clarified the daily-driver guidance, so all reported sets for the final user-steered rubric are reused validation, not independent holdout evidence.

`--filter context-hard` selects scenario IDs by substring. `--repeat 3` repeats each scenario with fresh state to expose live variability. `--cases PATH` selects another corpus using the same schema. Offline `--fixture-failure http`, `invalid`, or `low-confidence` exercises response handling. Low confidence is valid and must not trigger fallback; HTTP or invalid responses exercise failover. Acceptable ranges still describe task difficulty, so these fault-injection results must be assessed separately from ordinary classification scores.

Reports retain the actual Jev model version, full probability distribution and runtime decision diagnostics. They separate Jev's raw level from the applied effort and include a raw-to-applied count matrix, over/under-range rates, fallback rate, request sizes and median/p95 end-to-end routing latency. Latency includes credential lookup, network and runtime policy. Sequential turn results expose delayed downgrades. Offline fixture confidence is intentionally high; fault injection covers unavailable or inconclusive decisions.

These evaluations measure routing calibration and policy behavior. They do not establish answer correctness, total cost savings, production latency or Haiku summary quality. Improving labels until scores rise can overfit: retain held-out scenarios and use separate end-to-end task evaluations with outcome-based graders before claiming task-quality gains.

Replay saved live decisions through a changed policy without API requests:

```sh
node --import tsx tools/routerEval.mts --replay /tmp/router-eval-live.json --cases data/router-evals.json --out /tmp/router-replay.json
```

Use the same corpus, model and repeat count as the original report. Replay requires complete recorded choices, confidence and probability distributions. It reports request-body mismatches; nonzero mismatches mean the recorded classification may not represent what Jev would choose for the new input. Replay latency is local execution only and must not be presented as live latency. A replay verifies application policy, not fresh classification quality.
